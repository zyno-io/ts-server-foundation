import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { performance } from 'node:perf_hooks';
import { describe, it } from 'node:test';

import { BaseAppConfig, createApp, createRedis, createRedisOptions, disconnectAllRedis, MeshService, sleepMs } from '../src';

type Fixture = { server: Server; port: number; sockets: Set<Socket> };

async function listen(connection: (socket: Socket) => void): Promise<Fixture> {
    const sockets = new Set<Socket>();
    const server = createServer(socket => {
        sockets.add(socket);
        socket.on('error', () => {});
        socket.on('close', () => sockets.delete(socket));
        connection(socket);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    return { server, port: address.port, sockets };
}

async function close(fixture: Fixture): Promise<void> {
    for (const socket of fixture.sockets) socket.destroy();
    await new Promise<void>(resolve => fixture.server.close(() => resolve()));
}

// Only the RESP bulk-string command arrays used by ioredis are accepted.
// Redis commands and mesh Lua execute on the real test Redis through a proxy.
function commands(socket: Socket, handle: (parts: string[]) => void): void {
    let buffer = Buffer.alloc(0);
    socket.on('data', data => {
        buffer = Buffer.concat([buffer, typeof data === 'string' ? Buffer.from(data) : data]);
        while (buffer.length) {
            const end = buffer.indexOf('\r\n');
            if (end < 0) return;
            assert.equal(buffer[0], 42);
            const count = Number(buffer.subarray(1, end).toString());
            const parts: string[] = [];
            let offset = end + 2;
            for (let index = 0; index < count; index++) {
                const headerEnd = buffer.indexOf('\r\n', offset);
                if (headerEnd < 0) return;
                assert.equal(buffer[offset], 36);
                const length = Number(buffer.subarray(offset + 1, headerEnd).toString());
                if (buffer.length < headerEnd + 2 + length + 2) return;
                parts.push(buffer.subarray(headerEnd + 2, headerEnd + 2 + length).toString());
                offset = headerEnd + 2 + length + 2;
            }
            buffer = buffer.subarray(offset);
            handle(parts);
        }
    });
}

function resp(value: string | number | Array<unknown> | null): string {
    if (value === null) return '$-1\r\n';
    if (typeof value === 'number') return `:${value}\r\n`;
    if (Array.isArray(value)) return `*${value.length}\r\n${value.map(item => resp(item as Parameters<typeof resp>[0])).join('')}`;
    return `$${Buffer.byteLength(value)}\r\n${value}\r\n`;
}

describe('Sentinel recovery', () => {
    it('inherits timeout and discovery policy with independent utility overrides', async () => {
        class Config extends BaseAppConfig {
            REDIS_SENTINEL_HOST = 'sentinel.example';
            REDIS_SENTINEL_NAME = 'redis';
            REDIS_SENTINEL_CONNECT_TIMEOUT_MS = 750;
            REDIS_SENTINEL_COMMAND_TIMEOUT_MS = 800;
            REDIS_SENTINEL_DISCOVER_PEERS = false;
            MESH_REDIS_SENTINEL_CONNECT_TIMEOUT_MS = 500;
            MESH_REDIS_SENTINEL_DISCOVER_PEERS = true;
        }
        const app = createApp({ config: Config, enableHealthcheck: false });
        try {
            const shared = createRedisOptions().options;
            const mesh = createRedisOptions('MESH').options;
            assert.equal(shared.connectTimeout, 750);
            assert.equal(shared.sentinelCommandTimeout, 800);
            assert.equal(shared.updateSentinels, false);
            assert.equal(mesh.connectTimeout, 500);
            assert.equal(mesh.sentinelCommandTimeout, 800);
            assert.equal(mesh.updateSentinels, true);
        } finally {
            await app.stop();
        }
    });

    for (const discoverPeers of [true, false]) {
        it(
            `keeps the actual 15-second mesh lease during stalled Sentinel discovery (discoverPeers=${discoverPeers})`,
            {
                skip: process.env.REDIS_HOST ? false : 'set REDIS_HOST to run the real Redis integration',
                timeout: 30_000
            },
            async t => {
                const backendHost = process.env.REDIS_HOST!;
                const backendPort = Number(process.env.REDIS_PORT ?? 6379);
                const backendSockets = new Set<Socket>();
                const proxy = await listen(socket => {
                    const backend = createConnection({ host: backendHost, port: backendPort });
                    backendSockets.add(backend);
                    backend.on('error', () => socket.destroy());
                    backend.on('close', () => {
                        backendSockets.delete(backend);
                        socket.destroy();
                    });
                    socket.on('close', () => backend.destroy());
                    socket.pipe(backend).pipe(socket);
                });
                let peerAttempts = 0;
                const retiredPeer = await listen(socket =>
                    commands(socket, () => {
                        peerAttempts++;
                    })
                );
                let unavailableUntil = 0;
                const subscribers = new Set<Socket>();
                const sentinel = await listen(socket =>
                    commands(socket, parts => {
                        const command = parts[0].toLowerCase();
                        if (command === 'sentinel') {
                            if (parts[1].toLowerCase() === 'get-master-addr-by-name') {
                                socket.write(resp(performance.now() < unavailableUntil ? null : ['127.0.0.1', String(proxy.port)]));
                            } else {
                                socket.write(resp([['ip', '127.0.0.1', 'port', String(retiredPeer.port), 'flags', 'sentinel']]));
                            }
                        } else if (command === 'subscribe') {
                            subscribers.add(socket);
                            socket.on('close', () => subscribers.delete(socket));
                            socket.write(resp(['subscribe', parts[1], 1]));
                        } else {
                            socket.write('+OK\r\n');
                        }
                    })
                );
                class Config extends BaseAppConfig {
                    REDIS_SENTINEL_HOST = '127.0.0.1';
                    REDIS_SENTINEL_PORT = sentinel.port;
                    REDIS_SENTINEL_NAME = 'redis';
                    REDIS_SENTINEL_DISCOVER_PEERS = discoverPeers;
                    REDIS_PREFIX = `sentinel-test-${randomUUID()}`;
                }
                const app = createApp({ config: Config, enableHealthcheck: false });
                const mesh = new MeshService(`handoff-${randomUUID()}`);
                let fences = 0;
                mesh.setLeaseLostCallback(() => {
                    fences++;
                });
                const { client } = createRedis('MESH');
                client.on('error', () => {});
                try {
                    await mesh.start();
                    const originalId = mesh.instanceId;
                    await client.ping();
                    // Force rediscovery while the service temporarily has no
                    // primary and an advertised retired peer accepts TCP but never
                    // answers commands. Previously this held renewal indefinitely.
                    unavailableUntil = performance.now() + 1_200;
                    const started = performance.now();
                    for (const socket of proxy.sockets) socket.destroy();
                    const pending = client.ping();
                    const result = await Promise.race([pending, sleepMs(4_000).then(() => 'deadline')]);
                    if (result === 'deadline') {
                        await sleepMs(12_100);
                        t.diagnostic(`Recovery exceeded four seconds; actual mesh lease fences: ${fences}`);
                    }
                    assert.equal(result, 'PONG', 'rediscovery must complete within the renewal budget');
                    assert.ok(performance.now() - started < 4_000);
                    if (discoverPeers) assert.ok(peerAttempts > 0, 'exercise the stalled discovered peer');
                    else assert.equal(peerAttempts, 0, 'the HA service must remain the discovery endpoint');
                    // Cross the original registration expiry using the production
                    // 5-second heartbeat / 15-second TTL, without extending either.
                    while (performance.now() - started < 16_000) {
                        mesh.assertLeaseSafe();
                        await sleepMs(100);
                    }
                    assert.equal(fences, 0);
                    assert.equal(mesh.instanceId, originalId);
                    const members = await mesh.getNodes();
                    assert.ok(members.some(member => member.instanceId === originalId));
                    const subscriptions = subscribers.size;
                    assert.ok(subscriptions > 0);
                    await client.quit();
                    for (let attempt = 0; attempt < 20 && subscribers.size === subscriptions; attempt++) await sleepMs(50);
                    assert.ok(subscribers.size < subscriptions, 'QUIT must close the separate Sentinel subscription');
                } finally {
                    // Release the deliberately stalled discovery before cleanup,
                    // including when running this test against the old defaults.
                    unavailableUntil = 0;
                    client.disconnect();
                    await close(retiredPeer);
                    await mesh.stop();
                    await disconnectAllRedis();
                    await app.stop();
                    await close(sentinel);
                    await close(proxy);
                    for (const socket of backendSockets) socket.destroy();
                }
            }
        );
    }
});
