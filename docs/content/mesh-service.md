# MeshService

`MeshService` provides Redis-backed membership, leader-driven cleanup, and
best-effort broadcast fan-out for a group of service instances. It is not an
RPC transport.

Cross-service requests, responses, client forwarding, and byte streams use
the authenticated mesh WebSocket link exposed by `MeshSrpcServer`. Redis is
limited to mesh membership, the client registry, cleanup obligations, and
optional broadcasts. Protect those Redis key prefixes with your Redis ACL or
network policy.

## Broadcasts

Declare the messages that may be broadcast, register handlers before starting
the mesh, then publish when needed:

```ts
import { MeshService, type MeshBroadcastMap } from '@zyno-io/ts-server-foundation';

interface Broadcasts extends MeshBroadcastMap {
    cacheInvalidated: { key: string };
}

const mesh = new MeshService<Broadcasts>('my-app');

mesh.registerBroadcastHandler('cacheInvalidated', async ({ key }, senderInstanceId, { signal }) => {
    if (signal.aborted) return;
    await invalidateLocalCache(key);
    console.log(`received from mesh node ${senderInstanceId}`);
});

await mesh.start();
await mesh.broadcast('cacheInvalidated', { key: 'users:42' });
```

Broadcast data is JSON-encoded once, before local delivery and Redis publish.
That means local and remote receivers observe the same representation (for
example, `Date` becomes an ISO string and `NaN` becomes `null`). Use
`{ skipSelf: true }` to publish only to other instances.

`broadcast()` rejects with `MeshBroadcastIndeterminateDeliveryError` if Redis
publish fails after local delivery has become possible. Broadcasts are
best-effort; handlers must tolerate duplicates and missed messages.

## Membership and cleanup

`start()` assigns an instance ID, records heartbeat and metadata in Redis, and
subscribes to the broadcast channel. `getNodes()` and `getNode()` return only
instances whose heartbeat is live. Node metadata is updated atomically with
the liveness check through `updateNodeMetadata()`.

One leader drains expired membership records. Register
`setNodeCleanedUpCallback()` for cleanup work associated with a vanished node.
The callback obligation remains in Redis until it succeeds, so a later leader
can retry it.

Mesh membership is a lease. `assertLeaseSafe()` synchronously fences work once
the latest provable lease expires; `setLeaseLostCallback()` lets dependants
close local resources immediately when that happens.

## API

### `new MeshService<B extends MeshBroadcastMap = {}>(key, options?)`

| Option                  |    Default | Meaning                                                             |
| ----------------------- | ---------: | ------------------------------------------------------------------- |
| `heartbeatIntervalMs`   |     `5000` | Membership renewal interval.                                        |
| `nodeTtlMs`             |    `15000` | Membership lease duration. Must be at least the heartbeat interval. |
| `leaderOptions`         |          — | Options for the cleanup leader election.                            |
| `nodeMetadata`          |       `{}` | Initial metadata advertised with this node.                         |
| `maxMessageBytes`       |  `1048576` | Maximum JSON-encoded broadcast size.                                |
| `maxActiveHandlers`     |     `4096` | Maximum concurrent broadcast handlers.                              |
| `maxActiveHandlerBytes` | `67108864` | Maximum bytes retained by active broadcast handlers.                |
| `cleanupBatchSize`      |      `100` | Maximum cleanup records handled in one Lua pass.                    |

### Methods

- `start()` / `stop()` — join or leave membership.
- `getNodes()` / `getNode(instanceId)` — read live nodes.
- `updateNodeMetadata(metadata)` — atomically update metadata for a live node.
- `registerBroadcastHandler(type, handler)` — register a local broadcast
  receiver. The handler receives `(data, senderInstanceId, { signal })`.
- `broadcast(type, data, { skipSelf? })` — fan out an optional Redis broadcast.
- `setNodeCleanedUpCallback(callback)` — handle expired node cleanup.
- `setLeaseLostCallback(callback)` / `assertLeaseSafe()` — react to membership
  fencing.

For request/response calls, create a `MeshSrpcServer` and use its mesh-link
transport instead of `MeshService`.
