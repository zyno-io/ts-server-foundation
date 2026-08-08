import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    getSrpcRegistryMetadata,
    getMeshSrpcServerOptions,
    MeshSrpcServer,
    validateMeshSrpcConfiguration,
    type MeshSrpcConfiguration,
    type SrpcStream
} from '../src';

function meshConfig(overrides: Partial<MeshSrpcConfiguration> = {}): MeshSrpcConfiguration {
    return {
        MESH_LINK_NAMESPACE: 'mesh-alpha',
        REDIS_HOST: 'redis.internal',
        MESH_LINK_PATH: '/_tsf/mesh',
        MESH_LINK_SECRET: 'test-only-mesh-secret',
        MESH_LINK_CONNECT_TIMEOUT_MS: 5_000,
        MESH_LINK_REQUEST_TIMEOUT_MS: 30_000,
        MESH_LINK_IDLE_TIMEOUT_MS: 60_000,
        MESH_LINK_MAX_FRAME_BYTES: 8 * 1024 * 1024,
        MESH_LINK_MAX_BUFFERED_BYTES: 16 * 1024 * 1024,
        ...overrides
    };
}

describe('MeshSrpcServer configuration', () => {
    it('builds an isolated mesh key with shared peer-link settings', () => {
        const config = meshConfig({ MESH_LINK_ADVERTISE_URL: 'wss://10.0.0.12:3000/_tsf/mesh' });

        assert.deepEqual(getMeshSrpcServerOptions(config, { meshKeySuffix: 'devices', clientWebSocketPaths: ['/ws'] }), {
            meshKey: 'mesh-alpha:devices',
            meshLink: {
                advertiseUrl: 'wss://10.0.0.12:3000/_tsf/mesh',
                path: '/_tsf/mesh',
                secret: 'test-only-mesh-secret',
                connectTimeoutMs: 5_000,
                requestTimeoutMs: 30_000,
                idleTimeoutMs: 60_000,
                maxFrameBytes: 8 * 1024 * 1024,
                maxBufferedBytes: 16 * 1024 * 1024
            }
        });
    });

    it('fails closed for missing infrastructure and unsafe transport settings', () => {
        assert.throws(
            () => getMeshSrpcServerOptions(meshConfig({ REDIS_HOST: undefined }), { meshKeySuffix: 'devices' }),
            /requires MESH_REDIS_HOST.*REDIS_SENTINEL_HOST/
        );
        assert.throws(
            () => getMeshSrpcServerOptions(meshConfig({ MESH_LINK_SECRET: 'too-short' }), { meshKeySuffix: 'devices' }),
            /at least 16 bytes/
        );
        assert.throws(
            () => getMeshSrpcServerOptions(meshConfig({ MESH_LINK_PATH: '/ws' }), { meshKeySuffix: 'devices', clientWebSocketPaths: ['/ws'] }),
            /must not overlap/
        );
        assert.throws(
            () =>
                getMeshSrpcServerOptions(meshConfig({ MESH_LINK_ADVERTISE_URL: 'https://mesh.internal/_tsf/mesh' }), {
                    meshKeySuffix: 'devices'
                }),
            /ws: or wss:/
        );
        assert.throws(
            () => getMeshSrpcServerOptions(meshConfig({ MESH_LINK_MAX_BUFFERED_BYTES: 1024 }), { meshKeySuffix: 'devices' }),
            /at least as large/
        );
    });

    it('accepts each supported Redis configuration source independently', () => {
        for (const redisSetting of ['MESH_REDIS_HOST', 'MESH_REDIS_SENTINEL_HOST', 'REDIS_HOST', 'REDIS_SENTINEL_HOST'] as const) {
            const config = meshConfig({
                MESH_REDIS_HOST: undefined,
                MESH_REDIS_SENTINEL_HOST: undefined,
                REDIS_HOST: undefined,
                REDIS_SENTINEL_HOST: undefined,
                [redisSetting]: 'redis.internal'
            });
            assert.doesNotThrow(() => validateMeshSrpcConfiguration(config, { meshKeySuffix: 'devices' }), redisSetting);
        }
    });

    it('validates mesh key segments and authentication-secret byte limits', () => {
        assert.doesNotThrow(() =>
            validateMeshSrpcConfiguration(meshConfig({ MESH_LINK_NAMESPACE: `a${'x'.repeat(127)}` }), {
                meshKeySuffix: `a${'x'.repeat(63)}`
            })
        );
        assert.doesNotThrow(() =>
            validateMeshSrpcConfiguration(meshConfig({ MESH_LINK_NAMESPACE: 'mesh:alpha_beta-1', MESH_LINK_SECRET: 'é'.repeat(8) }), {
                meshKeySuffix: 'devices:mobile_1'
            })
        );

        for (const value of ['', ' mesh', 'mesh ', '-mesh', 'mesh/slash', `a${'x'.repeat(128)}`]) {
            assert.throws(
                () => validateMeshSrpcConfiguration(meshConfig({ MESH_LINK_NAMESPACE: value }), { meshKeySuffix: 'devices' }),
                /MESH_LINK_NAMESPACE/
            );
        }
        for (const value of ['', ' devices', 'devices ', '_devices', 'devices/slash', `a${'x'.repeat(64)}`]) {
            assert.throws(() => validateMeshSrpcConfiguration(meshConfig(), { meshKeySuffix: value }), /meshKeySuffix/);
        }
        for (const value of [undefined, '', 'x'.repeat(15)]) {
            assert.throws(
                () => validateMeshSrpcConfiguration(meshConfig({ MESH_LINK_SECRET: value }), { meshKeySuffix: 'devices' }),
                /MESH_LINK_SECRET/
            );
        }
    });

    it('validates mesh-link paths, timers, and resource limits at their boundaries', () => {
        for (const path of ['/', '/mesh', '/mesh/nodes']) {
            assert.doesNotThrow(() => validateMeshSrpcConfiguration(meshConfig({ MESH_LINK_PATH: path }), { meshKeySuffix: 'devices' }), path);
        }
        for (const path of ['mesh', '/mesh?query=1', '/mesh#fragment']) {
            assert.throws(() => validateMeshSrpcConfiguration(meshConfig({ MESH_LINK_PATH: path }), { meshKeySuffix: 'devices' }), /MESH_LINK_PATH/);
        }
        assert.doesNotThrow(() =>
            validateMeshSrpcConfiguration(meshConfig({ MESH_LINK_PATH: '/mesh' }), {
                meshKeySuffix: 'devices',
                clientWebSocketPaths: ['/meshes']
            })
        );

        const timerCases: Array<[keyof MeshSrpcConfiguration, number, number]> = [
            ['MESH_LINK_CONNECT_TIMEOUT_MS', 100, 2_147_483_647],
            ['MESH_LINK_REQUEST_TIMEOUT_MS', 1, 2_147_483_647],
            ['MESH_LINK_IDLE_TIMEOUT_MS', 1_000, 2_147_483_647]
        ];
        for (const [name, minimum, maximum] of timerCases) {
            assert.doesNotThrow(
                () => validateMeshSrpcConfiguration(meshConfig({ [name]: minimum }), { meshKeySuffix: 'devices' }),
                `${name} minimum`
            );
            assert.doesNotThrow(
                () => validateMeshSrpcConfiguration(meshConfig({ [name]: maximum }), { meshKeySuffix: 'devices' }),
                `${name} maximum`
            );
            for (const value of [minimum - 1, maximum + 1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
                assert.throws(() => validateMeshSrpcConfiguration(meshConfig({ [name]: value }), { meshKeySuffix: 'devices' }), new RegExp(name));
            }
        }

        for (const frameBytes of [1_024, 64 * 1024 * 1024]) {
            assert.doesNotThrow(() =>
                validateMeshSrpcConfiguration(meshConfig({ MESH_LINK_MAX_FRAME_BYTES: frameBytes, MESH_LINK_MAX_BUFFERED_BYTES: frameBytes }), {
                    meshKeySuffix: 'devices'
                })
            );
        }
        for (const frameBytes of [1_023, 64 * 1024 * 1024 + 1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
            assert.throws(
                () => validateMeshSrpcConfiguration(meshConfig({ MESH_LINK_MAX_FRAME_BYTES: frameBytes }), { meshKeySuffix: 'devices' }),
                /MESH_LINK_MAX_FRAME_BYTES/
            );
        }
        for (const bufferedBytes of [8 * 1024 * 1024 - 1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
            assert.throws(
                () => validateMeshSrpcConfiguration(meshConfig({ MESH_LINK_MAX_BUFFERED_BYTES: bufferedBytes }), { meshKeySuffix: 'devices' }),
                /MESH_LINK_MAX_BUFFERED_BYTES/
            );
        }
    });

    it('accepts only unauthenticated websocket advertised URLs with the configured path', () => {
        for (const [path, advertiseUrl] of [
            ['/_tsf/mesh', 'ws://mesh.internal:3000/_tsf/mesh'],
            ['/_tsf/mesh', 'wss://[2001:db8::1]/_tsf/mesh'],
            ['/', 'ws://mesh.internal']
        ] as const) {
            assert.doesNotThrow(
                () =>
                    validateMeshSrpcConfiguration(meshConfig({ MESH_LINK_PATH: path, MESH_LINK_ADVERTISE_URL: advertiseUrl }), {
                        meshKeySuffix: 'devices'
                    }),
                advertiseUrl
            );
        }
        for (const advertiseUrl of [
            'mesh.internal/_tsf/mesh',
            'https://mesh.internal/_tsf/mesh',
            'ws://user:password@mesh.internal/_tsf/mesh',
            'ws://mesh.internal/_tsf/mesh?token=secret',
            'ws://mesh.internal/_tsf/mesh#fragment',
            'ws://mesh.internal/other'
        ]) {
            assert.throws(
                () => validateMeshSrpcConfiguration(meshConfig({ MESH_LINK_ADVERTISE_URL: advertiseUrl }), { meshKeySuffix: 'devices' }),
                /MESH_LINK_ADVERTISE_URL/
            );
        }
    });
});

describe('mesh sRPC metadata helpers', () => {
    it('returns local and remote projections without exposing local metadata remotely', () => {
        type LocalMeta = { deviceId?: string; secret: string };
        type RegistryMetadata = { deviceId: string };
        const local = { $ws: {}, meta: { deviceId: 'device-1', secret: 'local-only' } } as unknown as SrpcStream<LocalMeta>;
        const remote = { meta: { deviceId: 'device-2' } } as never;
        assert.deepEqual(
            getSrpcRegistryMetadata(local, stream => ({ deviceId: stream.meta.deviceId! })),
            {
                deviceId: 'device-1'
            }
        );
        assert.deepEqual(
            getSrpcRegistryMetadata<LocalMeta, RegistryMetadata>(remote, () => ({ deviceId: 'unexpected' })),
            { deviceId: 'device-2' }
        );
    });

    it('lists only physical local streams even when MeshSrpcServer.listClients is mesh-wide', async () => {
        const local = { clientId: 'device-1' } as unknown as SrpcStream;
        const server = Object.create(MeshSrpcServer.prototype) as MeshSrpcServer;
        Object.defineProperty(server, 'streamsByClientId', { value: new Map([[local.clientId, local]]) });

        assert.deepEqual(await server.getLocalStreams(), [local]);
    });

    it('starts the mesh before admitting an authenticated client', async () => {
        const server = Object.create(MeshSrpcServer.prototype) as MeshSrpcServer;
        let readyCalls = 0;
        server.ready = async () => {
            readyCalls++;
        };
        (server as any).clientAuthorizer = () => true;

        assert.equal(await (server as any).validateClientAuth({}, {} as never, 1), true);
        assert.equal(readyCalls, 1);
    });
});
