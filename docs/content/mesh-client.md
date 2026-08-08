# Mesh Client Tracking

Track clients connected across multiple backend nodes and invoke operations on any client regardless of which node it's connected to. Redis provides membership and registry coordination; `MeshSrpcServer` sends point-to-point client operations over authenticated mesh WebSockets.

Three layers, each building on the previous:

1. **MeshClientRegistry** — tracks which clients are connected where, with metadata
2. **MeshClientService** — adds transparent cross-node client invocation
3. **MeshSrpcServer** — extends SrpcServer with auto-registration, lifecycle callbacks, and distributed invoke

## MeshClientRegistry

Track which clients are connected to which node, with arbitrary metadata.

```typescript
import { MeshClientRegistry, MeshClientRedisRegistry } from '@zyno-io/ts-server-foundation';

interface ClientMeta {
    userId: string;
    role: string;
}

// Usually you don't construct this manually — MeshClientService and MeshSrpcServer create it for you.
// But if you need standalone tracking:
const backend = new MeshClientRedisRegistry<ClientMeta>('my-app');
const registry = new MeshClientRegistry<ClientMeta>(mesh.instanceId, backend);

await registry.register('client-123', { userId: 'user-1', role: 'admin' }, true, 'connection-123');

const client = await registry.getClient('client-123');
// { clientId: 'client-123', nodeId: 1, connectionId: 'connection-123', connectedAt: 1710000000000, metadata: { userId: 'user-1', role: 'admin' } }

const all = await registry.listClients();
const local = await registry.listClientsForNode(mesh.instanceId);

// Update metadata (ownership-safe: only updates if this node owns the registration)
const updated = await registry.updateMetadata(
    'client-123',
    {
        userId: 'user-1',
        role: 'superadmin'
    },
    'connection-123'
);

// Ownership-safe: only removes if this node owns the registration
const removed = await registry.unregister('client-123', 'connection-123'); // true if removed, false if client moved
```

The `MeshClientRegistryBackend` interface is pluggable — implement your own for database-backed tracking:

```typescript
import type { MeshClientRecord, MeshClientRegistryBackend, RegisteredClient, RegisterResult } from '@zyno-io/ts-server-foundation';

class DatabaseClientRegistry<TMeta> implements MeshClientRegistryBackend<TMeta> {
    async register(clientId: string, nodeId: number, metadata: TMeta, allowSupersede: boolean, connectionId: string): Promise<RegisterResult> {
        // Atomically create an active registration, return a conflict when another
        // node owns it and supersession is disabled, or report the superseded node.
        throw new Error('Implement active registration');
    }
    async reserve(clientId: string, nodeId: number, metadata: TMeta, allowSupersede: boolean, connectionId: string): Promise<RegisterResult> {
        // Pending reservations must remain hidden from lookup/list operations.
        throw new Error('Implement pending reservation');
    }
    async activate(clientId: string, nodeId: number, metadata: TMeta, connectionId: string): Promise<boolean> {
        // Promote this node's pending reservation to active without changing ownership.
        throw new Error('Implement reservation activation');
    }
    async unregister(clientId: string, nodeId: number, connectionId: string): Promise<boolean> {
        throw new Error('Implement ownership-safe removal');
    }
    async updateMetadata(clientId: string, nodeId: number, metadata: TMeta, connectionId: string): Promise<boolean> {
        throw new Error('Implement ownership-safe metadata update');
    }
    async getClient(clientId: string): Promise<RegisteredClient<TMeta> | undefined> {
        throw new Error('Implement active lookup');
    }
    async getClientIncludingPending(clientId: string): Promise<MeshClientRecord<TMeta> | undefined> {
        throw new Error('Implement exact active/pending lookup');
    }
    async listClients(): Promise<RegisteredClient<TMeta>[]> {
        throw new Error('Implement active listing');
    }
    async listClientsForNode(nodeId: number): Promise<RegisteredClient<TMeta>[]> {
        throw new Error('Implement active listing by node');
    }
    async cleanupNode(nodeId: number): Promise<RegisteredClient<TMeta>[]> {
        throw new Error('Implement ownership-safe node cleanup');
    }
}
```

Backends that support supersession must implement `claim`, `commitClaim`,
`abortClaim`, `getClientIncludingPending`, `removeClaimPrevious`, and
`removeClaimResult` methods.
`MeshClientService` treats these as one capability set and uses them to make
supersession a two-phase handoff: the old, exact `connectionId` remains
authoritative while the replacement is private; it is synchronously
disconnected and must acknowledge the fence before the replacement is
committed. Commit compares the exact raw preimage. If that same stable
generation changes state while its physical fence is in flight, the claimant
removes only that captured generation and retries once; a different reconnect
is never removed or overwritten. The committed raw record retains only the
opaque claim marker needed to reconcile a lost commit response or remove that
exact result. Claim creation also carries a caller-stable operation ID bound to
the complete requested node, process, connection, state, and metadata payload:
only an identical retry is idempotent, while a different operation or payload
conflicts. An ambiguous creation is retried with that same identity and
byte-identical request until the claim deadline. Lost exact-generation kick
responses are likewise retried against the same target; acknowledgement or a
raw read proving that exact generation absent completes the fence. Commit
reconciliation retries the same claim ID and exact raw read within a bounded
loop. If claim creation, commit, or exact cleanup cannot be proven, the service
fences and stops its entire mesh ownership generation rather than reporting
definite non-delivery while the claimed record could remain. Every registration
record must include a `connectionId`, and custom backends must implement all six
claim methods to support safe cross-node takeovers.
Missing any capability fails closed, because active-only lookup cannot
distinguish absence from a hidden pending owner and same-node conflict
semantics do not protect a reconnect without the exact generation.

### API

#### `new MeshClientRegistry<TMeta>(nodeId: number, backend: MeshClientRegistryBackend<TMeta>)`

Creates a registry bound to a specific mesh node ID.

#### `register(clientId, metadata, allowSupersede?)` → `Promise<RegisterResult>`

Register an active client on this node. A `connectedAt` timestamp (epoch ms) is automatically recorded. The result is `{ status: 'ok', supersededNodeId }` when registration succeeds or `{ status: 'conflict', ownerNodeId }` when another node owns the client. Direct registry registration never steals an active remote owner because it cannot obtain the required revocation acknowledgement; use `MeshClientService` (or the optional claim APIs) for a fenced takeover. `ownerNodeId` can be `null` if the owner disappears during the conflict/readback race.

#### `reserve(clientId, metadata, allowSupersede?)` → `Promise<RegisterResult>`

Atomically reserve ownership without making the client visible to `getClient()`, list operations, or invocation. The result has the same conflict/supersession shape as `register()`.

#### `activate(clientId, metadata)` → `Promise<boolean>`

Promote a pending reservation owned by this node to an active registration and store its final metadata. It returns `false` if the reservation disappeared or ownership moved to another node.

#### `unregister(clientId)` → `Promise<boolean>`

Remove a client registration. Returns `true` if the client was owned by this node and was removed. Returns `false` if the client had already reconnected to a different node (ownership-safe).

#### `updateMetadata(clientId, metadata)` → `Promise<boolean>`

Update metadata for a registered client. Returns `true` if the client was owned by this node and was updated. Returns `false` if the client is not registered or has moved to a different node (ownership-safe).

#### `getClient(clientId)` → `Promise<RegisteredClient<TMeta> | undefined>`

Look up a client by ID across all nodes. The returned `RegisteredClient` includes `clientId`, `nodeId`, `connectedAt` (epoch ms), and `metadata`.

#### `listClients()` → `Promise<RegisteredClient<TMeta>[]>`

List all registered clients across all nodes.

#### `listClientsPage(cursor?)` → `Promise<{ clients, cursor? }>`

Incrementally scan registered clients without materializing the complete Redis hash in one command. Pass the opaque returned `cursor` to the next call; an absent cursor means the scan is complete. Scan pages can repeat an entry while the registry changes, so long-running consumers should deduplicate by `clientId`.

#### `listClientsForNode(nodeId?)` → `Promise<RegisteredClient<TMeta>[]>`

List clients for a specific node. Defaults to this registry's node.

`listClientsForNodePage(nodeId?, cursor?)` provides the corresponding incremental per-node scan.

#### `cleanupNode(nodeId?)` → `Promise<RegisteredClient<TMeta>[]>`

Remove all clients for a node, returning the orphaned clients (with metadata). Only removes clients still owned by that node — clients that reconnected elsewhere are left intact.

---

## MeshClientService

Combines `MeshClientRegistry` with local client delivery. On its own, `MeshClientService` only invokes clients connected to the current node. `MeshSrpcServer` installs the authenticated direct mesh-link transport required for cross-node invocation, metadata updates, disconnects, and exact ownership fencing; those operations do not use Redis pub/sub RPC. A standalone service fails a remote operation rather than falling back to Redis RPC.

```typescript
import { MeshClientService } from '@zyno-io/ts-server-foundation';

// Define broadcast types for type-safe broadcasting
interface MyBroadcasts {
    configUpdated: { keys: string[] };
}

const clientService = new MeshClientService<ClientMeta, MyBroadcasts>({
    key: 'my-app',
    clientInvokeFn: async (clientId, type, data, timeoutMs) => {
        // Deliver to a client connected to this node.
        return localDelivery(clientId, type, data);
    }
});

await clientService.start();

await clientService.registerClient('client-123', { userId: 'user-1', role: 'admin' }, true, 'connection-123');

// Update metadata after registration (ownership-safe)
await clientService.updateClientMetadata('client-123', { userId: 'user-1', role: 'superadmin' });

// Invoke a client connected to this node
const result = await clientService.invoke('client-123', 'notify', { text: 'hello' });

// Broadcast to all nodes
clientService.registerBroadcastHandler('configUpdated', (data, senderInstanceId) => {
    console.log(`Config updated by node ${senderInstanceId}:`, data.keys);
});
await clientService.broadcast('configUpdated', { keys: ['feature-flag-x'] });

const clients = await clientService.clientRegistry.listClients();

await clientService.stop();
```

### API

#### `new MeshClientService<TMeta, TBroadcasts>(options)`

| Option               | Type                                                     | Description                                                                                   |
| -------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `key`                | `string`                                                 | Mesh key (internally namespaced as `_mc:{key}`)                                               |
| `meshOptions`        | `MeshServiceOptions`                                     | Optional tuning for the internal mesh node                                                    |
| `registryBackend`    | `MeshClientRegistryBackend`                              | Optional custom backend (defaults to `MeshClientRedisRegistry`)                               |
| `registryOptions`    | `MeshClientRedisRegistryOptions`                         | Optional limits for the built-in Redis registry; ignored when a custom backend is supplied    |
| `clientInvokeFn`     | `(clientId, type, data, timeoutMs?) => Promise<unknown>` | Delivers local clients for both local and forwarded invocations                               |
| `clientUpdateMetaFn` | `(clientId, metadata) => boolean`                        | Optional owning-node hook that applies a cross-node metadata update to the live local client. |

#### Properties

| Property         | Type                        | Description                   |
| ---------------- | --------------------------- | ----------------------------- |
| `instanceId`     | `number`                    | This node's mesh instance ID  |
| `clientRegistry` | `MeshClientRegistry<TMeta>` | Direct access to the registry |

#### Methods

| Method                                                                                  | Description                                                                                  |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `start()`                                                                               | Start the internal mesh and initialize the registry                                          |
| `stop()`                                                                                | Clean up own clients, stop the mesh                                                          |
| `registerClient(clientId, metadata, allowSupersede, connectionId)` → `Promise<boolean>` | Register this exact connection on this node; false means a non-superseded ownership conflict |
| `reserveClient(clientId, metadata, allowSupersede, connectionId)` → `Promise<boolean>`  | Reserve exact ownership without exposing the client until activation                         |
| `activateClient(clientId, metadata, connectionId)` → `Promise<boolean>`                 | Promote this node's exact reservation to active                                              |
| `unregisterClient(clientId, connectionId)` → `Promise<boolean>`                         | Unregister only that exact connection generation                                             |
| `updateClientMetadata(clientId, metadata)` → `Promise<boolean>`                         | Update metadata (returns false if client moved)                                              |
| `invoke(clientId, type, data, timeoutMs?)`                                              | Invoke on any client, routes automatically                                                   |
| `registerBroadcastHandler(type, handler)`                                               | Register a handler for a broadcast type                                                      |
| `broadcast(type, data, options?)`                                                       | Broadcast to all nodes in the mesh                                                           |
| `onLeaseLost(handler)`                                                                  | Fence local delivery after the mesh lease is lost                                            |

Before `start()`, registration and reservation are accepted as no-op calls, activation/update/unregister return `false`, and `invoke()` throws `ClientNotFoundError`. Callers that need discoverable state must await `start()` first. `start()`/`stop()` are serialized and `clientRegistry` remains the same facade throughout the service lifetime. Local invocation calls `clientInvokeFn` directly. With `MeshSrpcServer`, remote invocation, metadata updates, disconnects, and ownership fences go to the owning stream over its pinned, authenticated mesh WebSocket. A node that does not advertise a direct link fails closed; there is no Redis RPC fallback. A supplied timeout is an end-to-end deadline: routing time is deducted before delivery. Remote metadata updates run `clientUpdateMetaFn` on the owner and persist the accepted metadata in the registry. On lease loss, the service blocks new delivery before running every `onLeaseLost` handler, contains synchronous handler failures, and performs an exact-node registry sweep. That early sweep retains its cleanup obligation so a consumer such as `MeshSrpcServer` can repeat it after queued ownership mutations settle.

---

## MeshSrpcServer

Extends `SrpcServer` with mesh client tracking. Single class — no need to create an SrpcServer separately.

Cross-node client operations require `meshLink.secret` or `MESH_LINK_SECRET`. Without either, `meshStart()` still starts membership, the registry, and broadcasts, but client operations are local-only. Remote operations fail closed; Redis is never used as an RPC fallback.

Application servers can use `getMeshSrpcServerOptions(config, { meshKeySuffix, clientWebSocketPaths })` to construct these common options. It validates the Redis and peer-link settings once, derives the mesh key from `MESH_LINK_NAMESPACE`, and rejects a mesh-link path that overlaps an application WebSocket endpoint.

After authentication succeeds, `MeshSrpcServer` waits for mesh readiness before admitting the stream. Application authorizers should perform application authentication and authorization only; they do not need their own mesh-readiness gate.

```typescript
import { MeshSrpcServer } from '@zyno-io/ts-server-foundation';
import { ClientMessage, ServerMessage } from './generated/proto';

const server = new MeshSrpcServer({
    // SrpcServer options
    logger,
    clientMessage: ClientMessage,
    serverMessage: ServerMessage,
    wsPath: '/srpc',

    // Mesh options
    meshKey: 'my-app',
    // Required for cross-node client operations. It may instead come from
    // the MESH_LINK_SECRET application configuration.
    meshLink: { secret: process.env.MESH_LINK_SECRET! }
});

// Register SRPC handlers as usual
server.registerMessageHandler('uEcho', async (stream, data) => {
    return { message: `Echo: ${data.message}` };
});

// Lifecycle callbacks
server.onClientConnected((clientId, metadata) => {
    console.log(`Client ${clientId} connected`);
    db.updatePresence(clientId, 'online');
});

server.onClientDisconnected((clientId, metadata) => {
    // Only fires if the client actually left — NOT if it reconnected to another node
    console.log(`Client ${clientId} disconnected`);
    db.updatePresence(clientId, 'offline');
});

server.onNodeClientsOrphaned((nodeId, clients) => {
    // One healthy node claims each durable cleanup chunk
    // Only includes clients that didn't reconnect elsewhere
    console.log(`Node ${nodeId} died, ${clients.length} orphaned clients`);
    for (const client of clients) {
        db.updatePresence(client.clientId, 'offline');
    }
});

await server.meshStart();

// Update client metadata at any time (ownership-safe)
await server.updateClientMetadata('client-123', { ...metadata, role: 'superadmin' });

// Type-safe invoke on any client, regardless of which node
await server.invoke('client-123', 'dNotify', { text: 'hello' });

// Broadcast to all nodes (uses MeshService broadcast under the hood)
// Add a TBroadcasts generic to the server for type-safe broadcasts:
//   new MeshSrpcServer<Meta, ClientMsg, ServerMsg, RegistryMeta, MyBroadcasts>(...)
server.registerBroadcastHandler('configUpdated', (data, senderInstanceId) => {
    console.log(`Config updated by node ${senderInstanceId}:`, data);
});
await server.broadcast('configUpdated', { keys: ['feature-flag-x'] });

// Access the registry
const allClients = await server.clientRegistry.listClients();

// Shutdown
await server.meshStop();
server.close();
```

### API

#### Constructor

```typescript
new MeshSrpcServer(options: ISrpcServerOptions & MeshSrpcServerOptions)
```

`MeshSrpcServerOptions`:

| Option                    | Type                             | Description                                                                                                       |
| ------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `meshKey`                 | `string`                         | Mesh key                                                                                                          |
| `meshOptions`             | `MeshServiceOptions`             | Optional mesh tuning                                                                                              |
| `autoLifecycle`           | `boolean`                        | Defaults to `true`; set `false` to call `meshStart()` / `meshStop()` through application-owned lifecycle handling |
| `registryBackend`         | `MeshClientRegistryBackend`      | Optional custom backend                                                                                           |
| `registryOptions`         | `MeshClientRedisRegistryOptions` | Optional limits for the built-in Redis backend                                                                    |
| `extractRegistryMetadata` | `(stream) => TRegistryMeta`      | Optional metadata extraction from SRPC streams                                                                    |
| `meshLink`                | `object`                         | Direct WebSocket configuration; `secret` (or `MESH_LINK_SECRET`) enables cross-node client operations             |

#### Properties

| Property         | Type                                                           | Description                                                                           |
| ---------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `meshInstanceId` | `number`                                                       | This node's mesh instance ID                                                          |
| `clientRegistry` | `MeshClientRegistry<TRegistryMeta>`                            | Direct access to the registry                                                         |
| `startupState`   | `'stopped' \| 'starting' \| 'ready' \| 'draining' \| 'failed'` | Current mesh lifecycle state, including detached cleanup or a durable cleanup failure |

#### Methods

| Method                                       | Description                                                                                                                                                                  |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `meshStart()`                                | Start mesh client tracking                                                                                                                                                   |
| `meshStop()`                                 | Stop mesh client tracking (call before `close()`); detaches controller close work so membership cleanup is bounded, while cancelled startup still rolls back when it settles |
| `updateClientMetadata(clientId, metadata)`   | Update metadata (returns false if client moved); also updates local cache                                                                                                    |
| `invoke(clientId, prefix, data, timeoutMs?)` | Type-safe invoke on any client across any node                                                                                                                               |
| `registerBroadcastHandler(type, handler)`    | Register a handler for a broadcast type (see [MeshService broadcasts](./mesh-service.md))                                                                                    |
| `broadcast(type, data, options?)`            | Broadcast to all nodes in the mesh                                                                                                                                           |
| `listClients()`                              | List connected clients across the mesh                                                                                                                                       |
| `getLocalStreams()`                          | List only streams physically connected to this process                                                                                                                       |
| `onClientConnected(handler)`                 | Fires on the node the client connected to                                                                                                                                    |
| `onClientDisconnected(handler)`              | Fires on the node the client disconnected from                                                                                                                               |
| `onNodeClientsOrphaned(handler)`             | Fires on one durable single-claimer when a dead node's client chunk is cleaned up                                                                                            |

Plus all `SrpcServer` methods: `registerMessageHandler`, `registerConnectionHandler`, `registerDisconnectHandler`, `setClientAuthorizer`, etc.

`MeshSrpcServer` reserves client ownership before SRPC activation, so pending connections never appear in active registry lookups. After activation, top-level assignments and deletions on `stream.meta` are batched in a microtask and synchronized to the registry. Nested mutations are not observable through the proxy; replace the top-level value or call `updateClientMetadata()`. Explicit metadata updates currently merge supplied keys into the live `stream.meta` object while replacing the registry metadata value, so callers that need deletion parity should delete top-level stream keys directly. Calls for a remote client route through the pinned, authenticated mesh WebSocket to the owning SRPC stream. Connected/disconnected callbacks are serialized per client. Exact disconnect unregisters are retained and retried while the lease is safe; absence or a different generation completes the obligation without deleting a reconnect. Offline callbacks run once only after that obligation is confirmed. Persistent ambiguity fences the service so leader cleanup can remove any ghost owner.

Shutdown fences client admission immediately. Controller close is detached from normal and cancelled-start shutdowns so a stuck request cannot delay membership cleanup; `startupState` remains `draining` while that close or a cancelled-start rollback is still pending. A new `meshStart()` waits for the pending cleanup and then starts fresh. If membership, registry, rollback, or detached-close cleanup fails, `startupState` becomes `failed` and later starts fail closed with that error rather than risking overlapping ownership. Lease-loss cleanup drains queued registry mutations before its final exact-node sweep. A failed attempt retains the obligation and schedules an unref retry; `meshStop()` joins an active attempt or starts an immediate retry. Pending-start offline callbacks wait for successful ownership rollback, but do not wait for an unrelated detached controller close.

An exact remote takeover fence defers its offline lifecycle transition through the bounded claim window: a committed replacement suppresses it, while an aborted takeover emits it. Active takeover reconciliation uses exponential backoff. Bulk lease-loss and rollback snapshots make one observation after cleanup and one at the claim deadline instead of polling Redis per client throughout the window. Lifecycle callbacks remain serialized per client, but reconciliation and application callback work do not block membership cleanup or unrelated global restart work.

## Resource limits and orphan delivery

The built-in Redis registry defaults to 1,024 UTF-8 bytes per client ID, 64 KiB of JSON metadata, 10,000 clients per node, 256-entry listing and cleanup batches, 4,096 authentication principals, and 256 live nonces per principal. Configure these through `registryOptions`. Core `SrpcServer` also defaults to 128 pending handshakes, 10,000 live streams, 1,024 client-ID bytes, 64 KiB merged client metadata, and 256 local replay principals.

Registry listing uses incremental Redis scans. Dead-node cleanup removes fenced records in bounded batches and persists active clients in bounded durable orphan chunks; pending reservations do not produce offline callbacks. Each mesh heartbeat refreshes the registry safety TTL for the node's client set and shared client hash, so a healthy quiet node retains its registrations.

Durable orphan callbacks are single-claimer, not leader-affine. The cleanup leader creates the obligation, but any healthy service instance may atomically claim and deliver a chunk. A failed callback NACKs the chunk for redelivery; a lost claim becomes available after its server-time lease expires. Callbacks must therefore be idempotent.

The built-in durable orphan queue has global `registryOptions.maxOrphanItems`
and `maxOrphanBytes` caps (defaults: 4,096 items and 64 MiB), atomically
accounted in Redis. Admission reserves the maximum claim-token growth, so the
stored/accounted total stays within the byte cap while an item is claimed or
NACKed. Legacy unaccounted queues fail closed until a bounded sweep or consumer
fully drains them. A full queue rejects admission so the source cleanup is
retried rather than losing a callback. The non-durable fallback is similarly
bounded with `maxPendingOrphanItems` and `maxPendingOrphanBytes`. A service
stop or mesh-lease loss fences the drain: it makes no new claims, releases its
exact active claim for redelivery, and never ACKs after the boundary.

Fallback orphan snapshots require the backend's
`cleanupNodeForFallback(nodeId, maxItems, maxBytes)` capability. That operation
must compute the exact active-only snapshot, treat any non-empty snapshot as
one item regardless of its client count, reject before mutation when that item
or its serialized bytes exceed the supplied remaining bounds, and otherwise
remove all node records and return that exact snapshot atomically. An empty
snapshot consumes no item or bytes and is not enqueued. Fallback cleanup
admission is serialized across nodes so concurrent cleanups cannot both spend
the same remaining capacity. Expiry frees an obligation even while its callback
is blocked; a late callback completion is fenced to its exact obligation and
cannot delete a replacement or change its accounting. Legacy/custom backends
without the atomic capability fail closed before calling `cleanupNode`.
Callback mutation cannot alter the retained serialized snapshot or its byte
accounting.

Custom backends are considered durable only when
`cleanupNodeAndEnqueueOrphaned`, `claimOrphaned`, `ackOrphaned`, and
`nackOrphaned` are implemented together. A partial implementation uses the
bounded local fallback only when `cleanupNodeForFallback` is also available;
otherwise cleanup fails closed. The service never splits destructive cleanup
from a later durable enqueue across two backend calls.

Mesh-link endpoint pins are capped by `maxEndpointPins` (default: twice
`maxPeers`). Resolver-created pins are globally expiry-pruned and fail closed
at capacity. Explicit owner references remain valid past their TTL until the
last live connection, reservation, or terminal-cleanup obligation releases
them.

Direct v2 handle capabilities distinguish unused sender-ID reservations from
live byte-stream senders. Allocating a sender emits an authenticated activation
for the exact ID and renews its handle; unused reservations do not keep an idle
capability alive. Owner disconnect or idle-capability expiry sends an exact
capability revocation through the bounded terminal retry/ACK path. The remote
requester then marks only that handle stale, destroys its streams, detaches
their disconnect handlers, and releases the cache/pin reference. If revocation
cannot be acknowledged within the bounded retry window, the exact pinned peer
is closed as the fallback fence.

Sender announcements made during a direct remote invocation are provisional
until the invocation result is encoded and returned. Any handler, encoding,
send, or timeout failure sends terminal destroy operations for every announced
sender. A bounded exact-invocation tombstone rejects late announcements with
the same terminal destroy so client sender state and disconnect listeners do
not leak after the request has already failed.

Invocation timeouts are end-to-end deadlines, including registry lookup and cold direct-link connection. Heartbeats report accepted delivery but do not extend the deadline. Once delivery may have occurred, a timeout or link loss can be reported as an indeterminate-delivery error; use application idempotency before retrying non-idempotent work.

Forwarded mesh-client calls and authenticated direct mesh-link invoke frames
carry a relative residual and may retain the caller's absolute epoch. Every
forwarding hop decrements the relative value. The owner
captures a receiver-local expiry from that authenticated residual and never
rejects or expands it by comparing a foreign host's absolute epoch to its own
wall clock. Routing and authentication work on the owner continues to consume
the receiver-local budget.

---

## Error Classes

| Error                            | When                                                                  |
| -------------------------------- | --------------------------------------------------------------------- |
| `ClientNotFoundError`            | `invoke()` called with a clientId not in the registry                 |
| `ClientDisconnectedError`        | Client was in the registry but no longer connected on the target node |
| `ClientInvocationError`          | Remote delivery failed (wraps the original error message)             |
| `SrpcError`                      | The client handler returned an explicit typed sRPC error              |
| `SrpcIndeterminateDeliveryError` | A direct mesh-link delivery may have reached the remote owner         |
