# Mesh Client Tracking

Track clients connected across multiple backend nodes and invoke operations on any client regardless of which node it's connected to. Built on top of [MeshService](./mesh-service.md).

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

await registry.register('client-123', { userId: 'user-1', role: 'admin' });

const client = await registry.getClient('client-123');
// { clientId: 'client-123', nodeId: 1, connectedAt: 1710000000000, metadata: { userId: 'user-1', role: 'admin' } }

const all = await registry.listClients();
const local = await registry.listClientsForNode(mesh.instanceId);

// Update metadata (ownership-safe: only updates if this node owns the registration)
const updated = await registry.updateMetadata('client-123', {
    userId: 'user-1',
    role: 'superadmin'
});

// Ownership-safe: only removes if this node owns the registration
const removed = await registry.unregister('client-123'); // true if removed, false if client moved
```

The `MeshClientRegistryBackend` interface is pluggable — implement your own for database-backed tracking:

```typescript
import type { MeshClientRegistryBackend, RegisteredClient, RegisterResult } from '@zyno-io/ts-server-foundation';

class DatabaseClientRegistry<TMeta> implements MeshClientRegistryBackend<TMeta> {
    async register(clientId: string, nodeId: number, metadata: TMeta, allowSupersede = true): Promise<RegisterResult> {
        // Atomically create an active registration, return a conflict when another
        // node owns it and supersession is disabled, or report the superseded node.
        throw new Error('Implement active registration');
    }
    async reserve(clientId: string, nodeId: number, metadata: TMeta, allowSupersede = true): Promise<RegisterResult> {
        // Pending reservations must remain hidden from lookup/list operations.
        throw new Error('Implement pending reservation');
    }
    async activate(clientId: string, nodeId: number, metadata: TMeta): Promise<boolean> {
        // Promote this node's pending reservation to active without changing ownership.
        throw new Error('Implement reservation activation');
    }
    async unregister(clientId: string, nodeId: number): Promise<boolean> {
        throw new Error('Implement ownership-safe removal');
    }
    async updateMetadata(clientId: string, nodeId: number, metadata: TMeta): Promise<boolean> {
        throw new Error('Implement ownership-safe metadata update');
    }
    async getClient(clientId: string): Promise<RegisteredClient<TMeta> | undefined> {
        throw new Error('Implement active lookup');
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

### API

#### `new MeshClientRegistry<TMeta>(nodeId: number, backend: MeshClientRegistryBackend<TMeta>)`

Creates a registry bound to a specific mesh node ID.

#### `register(clientId, metadata, allowSupersede?)` → `Promise<RegisterResult>`

Register an active client on this node. A `connectedAt` timestamp (epoch ms) is automatically recorded. The result is `{ status: 'ok', supersededNodeId }` when registration succeeds or `{ status: 'conflict', ownerNodeId }` when another node owns the client and supersession is disabled. `ownerNodeId` can be `null` if the owner disappears during the conflict/readback race. The built-in Redis backend allows supersession by default.

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

#### `listClientsForNode(nodeId?)` → `Promise<RegisteredClient<TMeta>[]>`

List clients for a specific node. Defaults to this registry's node.

#### `cleanupNode(nodeId?)` → `Promise<RegisteredClient<TMeta>[]>`

Remove all clients for a node, returning the orphaned clients (with metadata). Only removes clients still owned by that node — clients that reconnected elsewhere are left intact.

---

## MeshClientService

Combines MeshClientRegistry with MeshService for transparent cross-node client invocation. You provide a `clientInvokeFn` for delivery to a client connected to this node; it is called for both local invocations and requests forwarded from another node.

```typescript
import { MeshClientService } from '@zyno-io/ts-server-foundation';

// Define broadcast types for type-safe broadcasting
interface MyBroadcasts {
    configUpdated: { keys: string[] };
}

const clientService = new MeshClientService<ClientMeta, MyBroadcasts>({
    key: 'my-app',
    clientInvokeFn: async (clientId, type, data, timeoutMs) => {
        // Deliver to a client connected to this node, whether the caller is local or remote.
        return localDelivery(clientId, type, data);
    }
});

await clientService.start();

await clientService.registerClient('client-123', { userId: 'user-1', role: 'admin' });

// Update metadata after registration (ownership-safe)
await clientService.updateClientMetadata('client-123', { userId: 'user-1', role: 'superadmin' });

// Invoke on any client — routes through mesh if on a different node
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
| `clientInvokeFn`     | `(clientId, type, data, timeoutMs?) => Promise<unknown>` | Delivers local clients for both local and forwarded invocations                               |
| `clientUpdateMetaFn` | `(clientId, metadata) => boolean`                        | Optional owning-node hook that applies a cross-node metadata update to the live local client. |

#### Properties

| Property         | Type                        | Description                   |
| ---------------- | --------------------------- | ----------------------------- |
| `instanceId`     | `number`                    | This node's mesh instance ID  |
| `clientRegistry` | `MeshClientRegistry<TMeta>` | Direct access to the registry |

#### Methods

| Method                                                                     | Description                                                            |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `start()`                                                                  | Start the internal mesh and initialize the registry                    |
| `stop()`                                                                   | Clean up own clients, stop the mesh                                    |
| `registerClient(clientId, metadata, allowSupersede?)` → `Promise<boolean>` | Register on this node; false means a non-superseded ownership conflict |
| `reserveClient(clientId, metadata, allowSupersede?)` → `Promise<boolean>`  | Reserve ownership without exposing the client until activation         |
| `activateClient(clientId, metadata)` → `Promise<boolean>`                  | Promote this node's reservation to active                              |
| `unregisterClient(clientId)` → `Promise<boolean>`                          | Unregister (returns false if client moved elsewhere)                   |
| `updateClientMetadata(clientId, metadata)` → `Promise<boolean>`            | Update metadata (returns false if client moved)                        |
| `invoke(clientId, type, data, timeoutMs?)`                                 | Invoke on any client, routes automatically                             |
| `registerBroadcastHandler(type, handler)`                                  | Register a handler for a broadcast type                                |
| `broadcast(type, data, options?)`                                          | Broadcast to all nodes in the mesh                                     |

Before `start()`, registration and reservation are accepted as no-op compatibility calls, activation/update/unregister return `false`, and `invoke()` throws `ClientNotFoundError`. Callers that need discoverable state must await `start()` first. Local invocation calls `clientInvokeFn` directly. Remote invocation forwards to the owning node and preserves `ClientDisconnectedError`; other delivery failures become `ClientInvocationError`. Remote metadata updates run `clientUpdateMetaFn` on the owner and persist the accepted metadata in the registry.

---

## MeshSrpcServer

Extends `SrpcServer` with mesh client tracking. Single class — no need to create an SrpcServer separately.

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
    meshKey: 'my-app'
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
    // Fires on the leader when a dead node is cleaned up
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

| Option            | Type                        | Description                                    |
| ----------------- | --------------------------- | ---------------------------------------------- |
| `meshKey`         | `string`                    | Mesh key                                       |
| `meshOptions`     | `MeshServiceOptions`        | Optional mesh tuning                           |
| `registryBackend` | `MeshClientRegistryBackend` | Optional custom backend                        |
| `extractMetadata` | `(stream) => TRegistryMeta` | Optional metadata extraction from SRPC streams |

#### Properties

| Property         | Type                                | Description                   |
| ---------------- | ----------------------------------- | ----------------------------- |
| `meshInstanceId` | `number`                            | This node's mesh instance ID  |
| `clientRegistry` | `MeshClientRegistry<TRegistryMeta>` | Direct access to the registry |

#### Methods

| Method                                       | Description                                                                               |
| -------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `meshStart()`                                | Start mesh client tracking                                                                |
| `meshStop()`                                 | Stop mesh client tracking (call before `close()`)                                         |
| `updateClientMetadata(clientId, metadata)`   | Update metadata (returns false if client moved); also updates local cache                 |
| `invoke(clientId, prefix, data, timeoutMs?)` | Type-safe invoke on any client across any node                                            |
| `registerBroadcastHandler(type, handler)`    | Register a handler for a broadcast type (see [MeshService broadcasts](./mesh-service.md)) |
| `broadcast(type, data, options?)`            | Broadcast to all nodes in the mesh                                                        |
| `onClientConnected(handler)`                 | Fires on the node the client connected to                                                 |
| `onClientDisconnected(handler)`              | Fires on the node the client disconnected from                                            |
| `onNodeClientsOrphaned(handler)`             | Fires on the **leader node** when a dead node's clients are cleaned up                    |

Plus all `SrpcServer` methods: `registerMessageHandler`, `registerConnectionHandler`, `registerDisconnectHandler`, `setClientAuthorizer`, etc.

`MeshSrpcServer` reserves client ownership before SRPC activation, so pending connections never appear in active registry lookups. After activation, top-level assignments and deletions on `stream.meta` are batched in a microtask and synchronized to the registry. Nested mutations are not observable through the proxy; replace the top-level value or call `updateClientMetadata()`. Explicit metadata updates currently merge supplied keys into the live `stream.meta` object while replacing the registry metadata value, so callers that need deletion parity should delete top-level stream keys directly. Calls for a remote client route through the mesh to the owning SRPC stream. Connected/disconnected callbacks are serialized per client, and a stale disconnect from a same-node replacement does not unregister the replacement or publish an offline callback.

## Current Limits

- The built-in Redis registry applies a 24-hour safety TTL to its client hash and per-node sets. Registry writes refresh those keys, but mesh heartbeats currently do not; registrations in a completely quiet mesh can therefore expire while clients remain connected.

---

## Error Classes

| Error                     | When                                                                  |
| ------------------------- | --------------------------------------------------------------------- |
| `ClientNotFoundError`     | `invoke()` called with a clientId not in the registry                 |
| `ClientDisconnectedError` | Client was in the registry but no longer connected on the target node |
| `ClientInvocationError`   | Remote delivery failed (wraps the original error message)             |
| `MeshRequestTimeoutError` | The remote node didn't respond to the mesh forwarding request         |
