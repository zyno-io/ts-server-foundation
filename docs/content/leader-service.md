# LeaderService

Distributed leader election using a Redis TTL lease with atomic acquisition and periodic renewal. Redis grants the lease to one owner at a time, but an expired holder can still locally report leadership until its next renewal detects the loss, so leader-only work must tolerate lease transitions.

## Usage

```typescript
import { LeaderService } from '@zyno-io/ts-server-foundation';

const leader = new LeaderService('my-feature');

leader.setBecameLeaderCallback(async () => {
    console.log('This instance is now the leader');
    // Start leader-only work (e.g. scheduled jobs, cleanup tasks)
});

leader.setLostLeaderCallback(async () => {
    console.log('Leadership lost');
    // Stop leader-only work
});

leader.start();

// Check leadership status at any time
if (leader.isLeader) {
    // perform leader-only operation
}

// Graceful shutdown
await leader.stop();
```

## API

### `new LeaderService(key: string, options?: LeaderServiceOptions)`

Creates a new leader election instance.

- **`key`** -- Logical name for the leadership group. All instances using the same key compete for the same lock. The full Redis key is derived as `{prefix}:leader:{key}`.
- **`options`** -- Optional tuning parameters (see below).

### `LeaderServiceOptions`

| Option              | Type     | Default | Description                                                                                            |
| ------------------- | -------- | ------- | ------------------------------------------------------------------------------------------------------ |
| `ttlMs`             | `number` | `30000` | Lock TTL in milliseconds. If the leader crashes without releasing, the lock expires after this period. |
| `renewalIntervalMs` | `number` | `10000` | How often the leader renews its lock. Should be well below `ttlMs` to avoid accidental expiry.         |
| `retryDelayMs`      | `number` | `5000`  | Delay between acquisition attempts for non-leader instances.                                           |

### Properties

| Property   | Type      | Description                                                                               |
| ---------- | --------- | ----------------------------------------------------------------------------------------- |
| `isLeader` | `boolean` | Whether this instance most recently acquired the lease and has not yet detected its loss. |

### Methods

#### `setBecameLeaderCallback(callback: () => void | Promise<void>): void`

Register a callback invoked when this instance acquires leadership. Errors thrown by the callback are logged but do not affect leader status.

#### `setLostLeaderCallback(callback: () => void | Promise<void>): void`

Register a callback invoked when this instance loses leadership (e.g. renewal failure, network partition). Errors are logged and do not prevent re-election attempts.

#### `start(): void`

Begin participating in leader election. Throws if already running. Acquisition is asynchronous -- the instance may not be leader immediately after `start()` returns.

#### `stop(): Promise<void>`

Stop participating and release the lock if currently leader. Safe to call multiple times.

## How It Works

1. **Acquisition**: Each instance attempts to set a Redis key with `NX` (set-if-not-exists) semantics and a TTL via a Lua script. If the key doesn't exist, the caller becomes leader.
2. **Renewal**: The leader periodically refreshes the TTL on its lock. If the key's value no longer matches (another instance took over), leadership is considered lost.
3. **Release**: On `stop()`, the leader deletes its key (only if the value still matches), allowing immediate failover.
4. **Retry**: Non-leaders retry acquisition on a timer. If the leader crashes, the lock expires after `ttlMs` and another instance acquires it.

All Redis operations use Lua scripts for atomicity:

- **ACQUIRE** -- `SET key value PX ttl` only if the key doesn't exist
- **RENEW** -- `PEXPIRE key ttl` only if the value matches
- **RELEASE** -- `DEL key` only if the value matches

## Configuration

The Redis connection is configured via environment variables with the `MUTEX_REDIS_` prefix (falls back to `REDIS_`):

| Variable                    | Description                                                  |
| --------------------------- | ------------------------------------------------------------ |
| `MUTEX_REDIS_HOST`          | Redis host                                                   |
| `MUTEX_REDIS_PORT`          | Redis port                                                   |
| `MUTEX_REDIS_PREFIX`        | Key prefix (falls back to `REDIS_PREFIX`, then package name) |
| `MUTEX_REDIS_SENTINEL_HOST` | Sentinel host (optional)                                     |
| `MUTEX_REDIS_SENTINEL_PORT` | Sentinel port (optional)                                     |
| `MUTEX_REDIS_SENTINEL_NAME` | Sentinel master name (optional)                              |
