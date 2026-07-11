# Redis

Utilities for Redis-backed caching, distributed locking, and inter-process communication.

## Client Creation

```typescript
import { createRedis, createRedisOptions } from '@zyno-io/ts-server-foundation';

// Create with default config (REDIS_HOST, REDIS_PORT)
const { client, prefix } = createRedis();

// Create with specific config prefix (uses CACHE_REDIS_* and falls back to REDIS_*)
const { client, prefix } = createRedis('CACHE');
```

Each call creates a separate connection. All clients are tracked and can be disconnected with `disconnectAllRedis()`.

## Cache

Redis-backed cache with TTL support:

```typescript
import { Cache } from '@zyno-io/ts-server-foundation';

// String values
await Cache.set('key', 'value', 3600); // TTL in seconds
const value = await Cache.get('key');

// Object values (auto JSON serialization)
await Cache.setObj('user:123', { name: 'Alice', role: 'admin' }, 3600);
const user = await Cache.getObj<{ name: string; role: string }>('user:123');
```

| Method                        | Description                                    |
| ----------------------------- | ---------------------------------------------- |
| `Cache.get(key)`              | Get a string value (returns `null` if missing) |
| `Cache.set(key, val, ttl)`    | Set a string value with TTL in seconds         |
| `Cache.getObj<T>(key)`        | Get and deserialize a JSON value               |
| `Cache.setObj(key, val, ttl)` | Serialize and set a JSON value with TTL        |

Uses `CACHE_REDIS_*` environment variables (falls back to `REDIS_*`).

## Distributed Mutex

Redis-backed distributed locking for coordinating work across multiple instances:

```typescript
import { withMutex, withMutexes, MutexAcquisitionError } from '@zyno-io/ts-server-foundation';

// Single mutex
const result = await withMutex({
    key: ['user', userId],
    fn: async didWait => {
        // Critical section - only one instance executes at a time
        // didWait: true if we had to wait for the lock
        return await processPayment(userId);
    },
    retryCount: 30, // Max retry attempts (default: 30)
    retryDelay: 1000, // Delay between retries in ms (default: 1000)
    renewInterval: 1000 // Lock renewal interval in ms (default: 1000)
});

// Multiple mutexes (acquired in order)
const result = await withMutexes({
    keys: [
        ['resource', resourceA],
        ['resource', resourceB]
    ],
    fn: async didWait => {
        return await updateResources(resourceA, resourceB);
    }
});
```

### Keys

Mutex keys can be primitives or arrays: `['resource', 123]` becomes `resource:123`.

### Error Handling

Throws `MutexAcquisitionError` if the lock cannot be acquired within the retry window.

### Options

| Option          | Type                               | Default | Description                            |
| --------------- | ---------------------------------- | ------- | -------------------------------------- |
| `key` / `keys`  | `MutexKey`                         | —       | Lock key(s) — string, number, or array |
| `fn`            | `(didWait: boolean) => Promise<T>` | —       | Function to execute under lock         |
| `retryCount`    | `number`                           | `30`    | Max retry attempts                     |
| `retryDelay`    | `number`                           | `1000`  | Delay between retries (ms)             |
| `renewInterval` | `number`                           | `1000`  | Lock renewal interval (ms)             |

### Modes

Configure via `MUTEX_MODE`:

- **`local`** (default) — In-process locking with no Redis dependency. Useful for single-instance or testing scenarios.
- **`redis`** — Uses Redis Lua scripts for atomic acquire/release/renew. Suitable for multi-instance deployments.

Uses `MUTEX_REDIS_*` environment variables (falls back to `REDIS_*`).

### DevConsole Integration

Active mutexes and acquisition history are visible in the [DevConsole](./devconsole.md) Mutex view.

## Broadcast Channels

Redis pub/sub for inter-process communication:

```typescript
import { createBroadcastChannel } from '@zyno-io/ts-server-foundation';

// Create a typed broadcast channel
const channel = createBroadcastChannel<{ userId: string; action: string }>('user-events');

channel.subscribe(data => {
    console.log(`${data.userId}: ${data.action}`);
});

channel.publish({ userId: '123', action: 'login' });
```

### Distributed Methods

Execute a function locally and broadcast to all instances:

```typescript
import { createDistributedMethod } from '@zyno-io/ts-server-foundation';

class CacheManager {
    invalidate = createDistributedMethod<{ key: string }>(
        {
            name: 'invalidate',
            logger: () => this.logger
        },
        async data => {
            this.localCache.delete(data.key);
        }
    );
}

// Calling invalidate() runs locally AND broadcasts to all instances
await cacheManager.invalidate({ key: 'user:123' });
```

The `logger` option takes a getter function so it can reference `this.logger` even when used as a class field initializer. If omitted, a default logger scoped to `Distributed:<name>` is used.

Uses `BROADCAST_REDIS_*` environment variables (falls back to `REDIS_*`).

## Configuration

All Redis utilities support independent connection configuration via environment variable prefixes:

| Utility   | Env Prefix          | Fallback  |
| --------- | ------------------- | --------- |
| Cache     | `CACHE_REDIS_*`     | `REDIS_*` |
| Mutex     | `MUTEX_REDIS_*`     | `REDIS_*` |
| Broadcast | `BROADCAST_REDIS_*` | `REDIS_*` |
| Mesh      | `MESH_REDIS_*`      | `REDIS_*` |
| BullMQ    | `BULL_REDIS_*`      | `REDIS_*` |

Common variables for each prefix:

| Variable                | Description                | Default      |
| ----------------------- | -------------------------- | ------------ |
| `*_REDIS_HOST`          | Redis host                 | unset        |
| `*_REDIS_PORT`          | Redis port                 | `6379`       |
| `*_REDIS_PREFIX`        | Key prefix                 | package name |
| `*_REDIS_SENTINEL_HOST` | Redis Sentinel host        | unset        |
| `*_REDIS_SENTINEL_PORT` | Redis Sentinel port        | `26379`      |
| `*_REDIS_SENTINEL_NAME` | Redis Sentinel master name | unset        |

For the default shared connection, omit the utility prefix and use `REDIS_HOST`, `REDIS_PORT`, `REDIS_PREFIX`, and `REDIS_SENTINEL_*`.
