# MeshService

Typed RPC between distributed application instances. Each node gets a unique integer ID and can invoke handlers on any other node (or itself) with full type safety. Uses Redis pub/sub for messaging and sorted sets for node tracking.

## Usage

### Define a message map

```typescript
import { MeshService, MeshMessageMap } from '@zyno-io/ts-server-foundation';

type MyMessages = {
    getStatus: { request: { verbose: boolean }; response: { status: string; uptime: number } };
    invalidateCache: { request: { keys: string[] }; response: { cleared: number } };
};
```

### Create and start a node

```typescript
const mesh = new MeshService<MyMessages>('my-app');

mesh.registerHandler('getStatus', async data => {
    return { status: 'ok', uptime: process.uptime() };
});

mesh.registerHandler('invalidateCache', async data => {
    const cleared = await cache.delete(data.keys);
    return { cleared };
});

await mesh.start();
console.log(`Node started with instance ID: ${mesh.instanceId}`);
```

### Invoke a handler on another node

```typescript
// Call a specific node by its instance ID
const result = await mesh.invoke(targetInstanceId, 'getStatus', { verbose: true });
console.log(result.status); // fully typed

// Calling your own instance ID routes directly to the local handler (no pub/sub)
const local = await mesh.invoke(mesh.instanceId, 'getStatus', { verbose: false });

// Per-request timeout (overrides the service-level default)
const fast = await mesh.invoke(targetInstanceId, 'getStatus', { verbose: false }, 2000);
```

### List nodes in the mesh

```typescript
const nodes = await mesh.getNodes();
for (const node of nodes) {
    console.log(`${node.instanceId} @ ${node.hostname}${node.self ? ' (self)' : ''}`);
}
// 1 @ web-server-01
// 2 @ web-server-02 (self)
// 3 @ web-server-03
```

### Track node departures

```typescript
mesh.setNodeCleanedUpCallback(async instanceId => {
    console.log(`Node ${instanceId} left the mesh`);
    // Clean up resources associated with that node
});
```

### Broadcast to all nodes

Fire-and-forget messages to every node in the mesh. Unlike `invoke`, broadcasts have no response.

```typescript
import { MeshService, MeshBroadcastMap } from '@zyno-io/ts-server-foundation';

type MyBroadcasts = {
    configUpdated: { keys: string[] };
    userLoggedOut: { userId: string };
};

const mesh = new MeshService<MyMessages, MyBroadcasts>('my-app');

// Register handlers for broadcast types
mesh.registerBroadcastHandler('configUpdated', (data, senderInstanceId) => {
    console.log(`Config update from node ${senderInstanceId}:`, data.keys);
    reloadConfig(data.keys);
});

await mesh.start();

// Broadcast to all nodes (including self)
await mesh.broadcast('configUpdated', { keys: ['feature-flags'] });

// Skip self-delivery
await mesh.broadcast('userLoggedOut', { userId: '123' }, { skipSelf: true });
```

### Graceful shutdown

```typescript
await mesh.stop();
```

## API

### `new MeshService<T extends MeshMessageMap, B extends MeshBroadcastMap>(key: string, options?: MeshServiceOptions)`

Creates a new mesh node.

- **`key`** -- Logical mesh name. All nodes using the same key form one mesh. Different keys are fully independent.
- **`options`** -- Optional tuning parameters (see below).

### `MeshServiceOptions`

| Option                | Type                   | Default | Description                                                                                                                |
| --------------------- | ---------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------- |
| `heartbeatIntervalMs` | `number`               | `5000`  | How often this node refreshes its heartbeat in the registry.                                                               |
| `nodeTtlMs`           | `number`               | `15000` | How long a node can go without a heartbeat before the leader removes it.                                                   |
| `requestTimeoutMs`    | `number`               | `10000` | Default timeout for remote invocations. Reset on each heartbeat from the handler, so long-running handlers won't time out. |
| `leaderOptions`       | `LeaderServiceOptions` | —       | Options passed to the internal `LeaderService` used for cleanup leader election.                                           |

### Properties

| Property     | Type     | Description                                                             |
| ------------ | -------- | ----------------------------------------------------------------------- |
| `instanceId` | `number` | Unique integer ID assigned to this node on `start()`. `0` before start. |

### Methods

#### `registerHandler<K>(type: K, handler: (data: T[K]['request']) => T[K]['response'] | Promise<T[K]['response']>): void`

Register a handler for a message type. Handlers can be registered before or after `start()`. Registering a handler for a type that already has one replaces it.

#### `invoke<K>(instanceId: number, type: K, data: T[K]['request'], timeoutMs?: number): Promise<T[K]['response']>`

Send a typed request to a specific node and wait for the response.

- **`timeoutMs`** -- Optional per-request timeout. Falls back to the service-level `requestTimeoutMs` if not provided. The handler-side heartbeat interval automatically adjusts to the caller's timeout.
- If `instanceId` matches the local node, the handler is called directly (no pub/sub, no timeout).
- If the target node doesn't exist or doesn't respond, the promise rejects with `MeshRequestTimeoutError`.
- If the target has no handler for the type, rejects with `MeshNoHandlerError`.
- If the handler throws, rejects with `MeshHandlerError` containing the error message.

#### `registerBroadcastHandler<K>(type: K, handler: (data: B[K], senderInstanceId: number) => void | Promise<void>): void`

Register a handler for a broadcast message type. Broadcast handlers receive the message data and the sender's instance ID. Errors thrown in handlers are logged but do not propagate.

#### `broadcast<K>(type: K, data: B[K], options?: MeshBroadcastOptions): Promise<void>`

Send a fire-and-forget message to all nodes in the mesh (including self, unless `skipSelf: true`).

| Option     | Type      | Default | Description                         |
| ---------- | --------- | ------- | ----------------------------------- |
| `skipSelf` | `boolean` | `false` | Don't deliver the broadcast to self |

#### `getNodes(): Promise<MeshNode[]>`

Returns all live nodes in the mesh. Each `MeshNode` contains:

```typescript
interface MeshNode {
    instanceId: number; // The node's unique integer ID
    hostname: string; // The OS hostname of the machine running the node
    self: boolean; // true if this is the calling node
}
```

The method returns the current heartbeat registry members. Gracefully stopped nodes remove themselves immediately; expired nodes can remain visible until the leader's cleanup pass removes them.

#### `setNodeCleanedUpCallback(cb: (instanceId: number) => void | Promise<void>): void`

Register a callback invoked when the leader detects and removes an expired node. Only fires on the current leader instance. Errors in the callback are logged but don't affect cleanup of other nodes.

#### `start(): Promise<void>`

Join the mesh. Acquires a unique instance ID, subscribes to its pub/sub channel and broadcast channel, registers in the heartbeat set, and starts leader election. Throws if already running.

#### `stop(): Promise<void>`

Leave the mesh. Stops heartbeats, rejects all pending outbound requests with `Error('MeshService stopped')`, unsubscribes from pub/sub, and removes itself from the heartbeat registry. Safe to call before `start()` or multiple times.

## Error Classes

### `MeshRequestTimeoutError`

The target node did not respond within the timeout period. This can happen if the target has crashed, is unreachable, or the Redis pub/sub connection is disrupted.

### `MeshHandlerError`

The target node's handler threw an error. The `message` property contains the original error message from the remote handler.

### `MeshNoHandlerError`

No handler is registered for the requested message type -- either locally (direct invocation) or on the remote node.

## Architecture

### Node Registry

Nodes are tracked in a Redis sorted set (`{prefix}:mesh:{key}:heartbeats`) where the score is the last heartbeat timestamp (from Redis server time, avoiding clock skew) and the member is the instance ID. Node metadata (hostname) is stored in a Redis hash (`{prefix}:mesh:{key}:nodes`).

Unique instance IDs are assigned via `INCR` on `{prefix}:mesh:{key}:next_id`. Both the heartbeat entry and the nodes hash entry are removed on graceful stop or leader-driven cleanup of expired nodes.

### Messaging

Each node subscribes to its own pub/sub channel: `{prefix}:mesh:{key}:node:{instanceId}`.

Three message types flow over these channels:

| Type          | Direction         | Purpose                                                  |
| ------------- | ----------------- | -------------------------------------------------------- |
| **Request**   | Caller -> Handler | `{ requestId, senderInstanceId, type, data, timeoutMs }` |
| **Response**  | Handler -> Caller | `{ requestId, reply: true, data?, error? }`              |
| **Heartbeat** | Handler -> Caller | `{ requestId, heartbeat: true }`                         |

### Broadcast

All nodes also subscribe to a shared broadcast channel: `{prefix}:mesh:{key}:broadcast`. Broadcasts are fire-and-forget — the sender publishes once and all subscribers receive the message. No response is collected.

Channel routing: the subscriber's `message` handler inspects the channel name to distinguish broadcast messages from point-to-point messages on the instance channel.

### Request Heartbeats

While a handler is executing, the handling node sends periodic heartbeat messages back to the caller (every `requestTimeoutMs * 0.75`). The caller resets its timeout timer on each heartbeat. This allows short absolute timeouts while supporting arbitrarily long handler execution.

The handler uses the **caller's** `requestTimeoutMs` (sent in the request message) for its heartbeat interval, so mixed-timeout configurations work correctly.

### Leader Election

Each mesh uses an internal `LeaderService` (key: `mesh:{key}`) for leader election. The leader is responsible for:

1. Running the cleanup Lua script on each heartbeat cycle
2. Removing expired nodes from the sorted set
3. Invoking the `nodeCleanedUpCallback` for each removed node

Only one node (the leader) performs cleanup at any time.

### Local Invocation

When `invoke` is called with the node's own instance ID, the handler is called directly as a function call -- no serialization, no pub/sub, no timeout. Errors propagate as-is.

## Configuration

The Redis connection is configured via environment variables with the `MESH_REDIS_` prefix (falls back to `REDIS_`):

| Variable                   | Description                                                  |
| -------------------------- | ------------------------------------------------------------ |
| `MESH_REDIS_HOST`          | Redis host                                                   |
| `MESH_REDIS_PORT`          | Redis port                                                   |
| `MESH_REDIS_PREFIX`        | Key prefix (falls back to `REDIS_PREFIX`, then package name) |
| `MESH_REDIS_SENTINEL_HOST` | Sentinel host (optional)                                     |
| `MESH_REDIS_SENTINEL_PORT` | Sentinel port (optional)                                     |
| `MESH_REDIS_SENTINEL_NAME` | Sentinel master name (optional)                              |
