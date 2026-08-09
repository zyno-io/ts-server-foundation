import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { finished } from 'node:stream/promises';
import { afterEach, describe, it } from 'node:test';

import {
    acquireMeshLinkRuntime,
    createLogger,
    createApp,
    getMeshLinkProcessId,
    getCurrentApp,
    installUpgradeClaimHandling,
    MeshLinkProtocolVersion,
    MeshClientService,
    MeshSrpcServer,
    SrpcBackpressureError,
    SrpcByteStream,
    SrpcMeshAuthenticationError,
    SrpcOwnerUnavailableError,
    SrpcStaleConnectionError,
    type BaseMessage,
    type IByteStreamable,
    type RegisteredClient,
    setCurrentApp,
    type SrpcMeta
} from '../src';
import { MeshLinkCapabilityError, MeshSrpcLinkController } from '../src/services/mesh-client/mesh-srpc-link-controller';
import { MeshRemoteSrpcConnection } from '../src/services/mesh-client/mesh-srpc-remote-connection';

const secret = 'mesh-controller-test-secret-with-enough-entropy';
const path = '/_tsf/mesh-controller';
const servers: Server[] = [];
const runtimes: ReturnType<typeof acquireMeshLinkRuntime>[] = [];

type FullClientMeta = { role: string; secret: string };

const JsonMessage = {
    encode(message: BaseMessage) {
        return Buffer.from(JSON.stringify(message));
    },
    decode(input: Buffer) {
        return JSON.parse(input.toString('utf8')) as BaseMessage;
    }
};

// Remote handles expose the registry shape while local handles retain full
// client metadata, so reduced extractRegistryMetadata remains supported.
type ReducedRemoteMetadataIsSupported = MeshSrpcServer<FullClientMeta, BaseMessage, BaseMessage, { role: string }>;
type PrimitiveRemoteMetadataIsSupported = MeshSrpcServer<FullClientMeta, BaseMessage, BaseMessage, string>;

declare const reducedMetadataServer: ReducedRemoteMetadataIsSupported;
declare const primitiveMetadataServer: PrimitiveRemoteMetadataIsSupported;

async function verifyReducedRemoteMetadataType(): Promise<void> {
    const connection = await reducedMetadataServer.resolveClient('client-1');
    if (!connection) return;
    const metadata: FullClientMeta | { role: string } = connection.meta;
    void metadata;
    // @ts-expect-error Remote registry metadata may omit local-only fields.
    connection.meta.secret;
}

async function verifyPrimitiveRemoteMetadataType(): Promise<void> {
    const connection = await primitiveMetadataServer.resolveClient('client-1');
    if (!connection) return;
    const metadata: FullClientMeta | string = connection.meta;
    void metadata;
    // Registry projections may be primitive when read, but updates always
    // describe a partial mutation of the owning full stream metadata.
    // @ts-expect-error Primitive registry projections cannot replace full stream metadata.
    await primitiveMetadataServer.updateClientMetadata(connection, 'replacement');
}

afterEach(async () => {
    for (const runtime of runtimes.splice(0)) runtime.close();
    await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

describe('MeshSrpcLinkController', () => {
    it('can opt out of automatic App mesh lifecycle registration', async () => {
        let previousApp: ReturnType<typeof getCurrentApp> | undefined;
        try {
            previousApp = getCurrentApp();
        } catch {
            // The test installs its own minimal lifecycle host below.
        }
        const app = createApp({ enableHealthcheck: false });
        const originalOn = app.on.bind(app);
        let registrations = 0;
        (app as any).on = (token: unknown, handler: unknown) => {
            registrations++;
            return originalOn(token as any, handler as any);
        };
        try {
            const automatic = new MeshSrpcServer({
                logger: createLogger('MeshLifecycleDefault'),
                clientMessage: JsonMessage,
                serverMessage: JsonMessage,
                wsPath: '/lifecycle-default',
                meshKey: 'lifecycle-default'
            });
            assert.equal(registrations, 2);
            automatic.close();

            const manual = new MeshSrpcServer({
                logger: createLogger('MeshLifecycleManual'),
                clientMessage: JsonMessage,
                serverMessage: JsonMessage,
                wsPath: '/lifecycle-manual',
                meshKey: 'lifecycle-manual',
                autoLifecycle: false
            });
            assert.equal(registrations, 2);
            manual.close();
        } finally {
            await app.stop();
            if (previousApp) setCurrentApp(previousApp);
        }
    });

    it('does not activate a stream while mesh startup is only partially initialized', async () => {
        const server = Object.create(MeshSrpcServer.prototype) as any;
        let activations = 0;
        let metadataSyncs = 0;
        const stream = { id: 'connection-1', clientId: 'client-1', lastPingAt: Date.now(), meta: { role: 'client' } };
        server.meshClientService = {
            instanceId: 7,
            isRunning: false,
            activateClient: async () => {
                activations++;
                return true;
            }
        };
        server.clientRegistryMetadata = new Map();
        server.isCurrentStream = (candidate: unknown) => candidate === stream;
        server.enqueueClientRegistry = async (_clientId: string, fn: () => Promise<boolean>) => fn();
        server.syncStreamMeta = () => {
            metadataSyncs++;
        };
        server.enqueueClientCallback = async (_clientId: string, fn: () => Promise<void>) => fn();
        server.streamsByClientId = new Map([[stream.clientId, stream]]);
        server.lifecycleConnectedStreams = new WeakSet();
        server.connectedCallbacks = new Set();

        await server.onStreamWillActivate(stream);
        await server.onStreamActivated(stream);

        delete server.syncStreamMeta;
        server.pendingSyncs = new Set();
        server.installMetaProxy(stream);
        stream.meta.role = 'changed-during-startup';
        await Promise.resolve();

        assert.equal(activations, 0);
        assert.equal(metadataSyncs, 0);
        assert.deepEqual(server.clientRegistryMetadata.get('client-1'), { role: 'changed-during-startup' });
    });

    it('waits for in-flight startup backfill when a locally reserved stream crosses into mesh activation', async () => {
        const server = Object.create(MeshSrpcServer.prototype) as any;
        let releaseStart: (() => void) | undefined;
        const startBlocked = new Promise<void>(resolve => {
            releaseStart = resolve;
        });
        let reservations = 0;
        let activations = 0;
        const stream = { id: 'connection-1', clientId: 'client-1', lastPingAt: Date.now(), supersede: false, meta: { role: 'client' } };
        const meshClientService = {
            isRunning: false,
            reserveClient: async () => {
                reservations++;
                return true;
            },
            activateClient: async () => {
                activations++;
                return true;
            }
        };
        server.clientRegistryMetadata = new Map();
        server.meshClientService = meshClientService;
        server.isCurrentStream = (candidate: unknown) => candidate === stream;
        server.enqueueClientRegistry = async (_clientId: string, fn: () => Promise<boolean>) => fn();
        server.installMetaProxy = () => {};

        // The stream reserves locally before MeshClientService reaches its
        // running state. Startup flips that state before its backfill settles.
        assert.equal(await server.postEstablishCheck(stream), false);
        assert.equal(reservations, 1);
        meshClientService.isRunning = true;
        server.meshStartPromise = startBlocked;

        const activating = server.onStreamWillActivate(stream);
        await Promise.resolve();
        assert.equal(activations, 0);

        releaseStart!();
        await activating;
        assert.equal(activations, 1);
    });

    it('fences a running mesh while backfill is pending and rejects new admission', async () => {
        const server = Object.create(MeshSrpcServer.prototype) as any;
        let releaseBackfill: (() => void) | undefined;
        const backfillBlocked = new Promise<void>(resolve => {
            releaseBackfill = resolve;
        });
        let fenced = 0;
        const meshClientService = {
            isRunning: false,
            instanceId: 1,
            setRemoteTransport: () => {},
            prepareStart: () => {},
            start: async () => {
                meshClientService.isRunning = true;
            },
            stop: async () => {
                meshClientService.isRunning = false;
            },
            fenceForShutdown: () => {
                fenced++;
                meshClientService.isRunning = false;
            },
            registerClient: async () => {
                await backfillBlocked;
                return true;
            },
            reserveClient: async () => meshClientService.isRunning,
            activateClient: async () => meshClientService.isRunning
        };
        const stream = { id: 'backfill-connection', clientId: 'backfill-client', isActivated: true, supersede: false, meta: { role: 'client' } };
        server.meshRunning = false;
        server.meshStopping = false;
        server.meshClosed = false;
        server.meshStartGeneration = 0;
        server.clientRegistryMetadata = new Map();
        server.pendingStreamsByClientId = new Map();
        server.streamsByClientId = new Map([[stream.clientId, stream]]);
        server.clientRegistryChains = new Map();
        server.clientCallbackChains = new Map();
        server.meshClientService = meshClientService;
        server.resolveMeshLinkConfig = () => undefined;
        server.getCurrentStreamByClientId = () => stream;
        server.installMetaProxy = () => {};
        server.enqueueClientRegistry = async (_clientId: string, fn: () => Promise<boolean>) => fn();
        server.disconnectAllMeshStreams = () => {};

        const start = server.meshStart();
        await Promise.resolve();
        await server.meshStop();

        assert.equal(fenced, 1);
        assert.equal(await meshClientService.reserveClient(), false);
        assert.equal(await meshClientService.activateClient(), false);

        releaseBackfill!();
        await assert.rejects(start, /startup was cancelled/);
        await server.meshPendingStartCleanup;
    });

    it('keeps a failed cancelled-start cleanup as a barrier for queued restarts', async () => {
        const server = Object.create(MeshSrpcServer.prototype) as any;
        let starts = 0;
        let rollbacks = 0;
        server.meshRunning = false;
        server.meshStopping = false;
        server.meshClosed = false;
        server.meshStartGeneration = 0;
        server.meshLogger = { warn: () => {} };
        server.clientRegistryMetadata = new Map();
        server.meshClientService = {
            prepareStart: () => {},
            fenceForShutdown: () => {}
        };
        server.startMesh = async () => {
            starts++;
            throw new Error('start failed');
        };
        server.rollbackMeshStart = async () => {
            rollbacks++;
            throw new Error('rollback failed');
        };
        server.releaseMeshLinkResources = async () => {};
        server.disconnectAllMeshStreams = () => {};

        const start = server.meshStart();
        const stop = server.meshStop();
        await assert.rejects(start, /rollback failed/);
        await stop;
        await assert.rejects(server.meshStart(), /rollback failed/);

        assert.equal(starts, 1);
        assert.equal(rollbacks, 2);
        assert.equal(server.startupState, 'failed');
    });

    it('permits restart when a cancelled-start rollback retry succeeds', async () => {
        const server = Object.create(MeshSrpcServer.prototype) as any;
        let starts = 0;
        let rollbacks = 0;
        let deferredDisconnectDispatches = 0;
        server.meshRunning = false;
        server.meshStopping = false;
        server.meshClosed = false;
        server.meshStartGeneration = 0;
        server.meshLogger = { warn: () => {} };
        server.clientRegistryMetadata = new Map();
        server.meshClientService = {
            prepareStart: () => {},
            fenceForShutdown: () => {},
            setRemoteTransport: () => {}
        };
        server.startMesh = async () => {
            starts++;
            if (starts === 1) throw new Error('start failed');
        };
        server.rollbackMeshStart = async () => {
            rollbacks++;
            if (rollbacks === 1) throw undefined;
        };
        server.dispatchPendingStartDisconnects = async () => {
            deferredDisconnectDispatches++;
        };
        server.disconnectAllMeshStreams = () => {};

        const start = server.meshStart();
        const stop = server.meshStop();
        await assert.rejects(start, /undefined/);
        await stop;
        await server.meshPendingStartCleanup;

        await server.meshStart();
        assert.equal(starts, 2);
        assert.equal(rollbacks, 2);
        assert.equal(deferredDisconnectDispatches, 1);
        assert.equal(server.meshCleanupFailure, undefined);
    });

    it('rejects pre-start client admission after a shutdown fence', async () => {
        const service = new MeshClientService<{ role: string }>({
            key: `admission-fence-${Date.now()}-${process.pid}`,
            clientInvokeFn: async () => undefined
        });
        service.fenceForShutdown();

        assert.equal(await service.reserveClient('client-1', { role: 'client' }, false, 'connection-1'), false);
        assert.equal(await service.registerClient('client-1', { role: 'client' }, false, 'connection-1'), false);
    });

    it('cleans retained registry ownership when the shutdown fence stops mesh membership first', async () => {
        const service = Object.create(MeshClientService.prototype) as any;
        let cleaned = 0;
        let meshStops = 0;
        service.running = true;
        service.hasStarted = true;
        service.registryCleanupNodeId = 17;
        service.admissionFenced = false;
        service.ownershipGeneration = 0;
        service.lifecycle = Promise.resolve();
        service.stopRegistryTimers = () => {};
        service.registry = { cleanupNode: async () => cleaned++ };
        service.mesh = {
            instanceId: 17,
            stop: async () => {
                meshStops++;
                service.mesh.instanceId = 0;
            }
        };

        service.fenceForShutdown();
        await service.stop();
        await service.stop();

        assert.equal(cleaned, 1);
        assert.equal(meshStops, 1);
    });

    it('fences late handshakes while a running mesh drains its existing cleanup', async () => {
        const server = Object.create(MeshSrpcServer.prototype) as any;
        let releaseCleanup: (() => void) | undefined;
        const cleanupBlocked = new Promise<void>(resolve => {
            releaseCleanup = resolve;
        });
        let fenced = 0;
        let existingUnregisters = 0;
        let disconnectedCallbacks = 0;
        let cleanedClientId: string | undefined;
        const existingStream = { id: 'existing-connection', clientId: 'existing-client', meta: { role: 'client' } };
        const meshClientService = {
            isRunning: true,
            admissionFenced: false,
            fenceAdmission: () => {
                fenced++;
                meshClientService.admissionFenced = true;
            },
            reserveClient: async () => !meshClientService.admissionFenced,
            activateClient: async () => !meshClientService.admissionFenced,
            unregisterClient: async (clientId: string) => {
                assert.equal(clientId, existingStream.clientId);
                existingUnregisters++;
                return meshClientService.isRunning;
            },
            setRemoteTransport: () => {},
            stop: async () => {}
        };
        server.meshRunning = true;
        server.meshStopping = false;
        server.meshLogger = { warn: () => {} };
        server.logger = { error: () => {} };
        server.publishedStreams = new Set([existingStream]);
        server.streamDisconnectionHandlers = [];
        server.lifecycleConnectedStreams = new WeakSet([existingStream]);
        server.clientRegistryMetadata = new Map([[existingStream.clientId, { role: 'client' }]]);
        server.clientRegistryChains = new Map([['existing-client', cleanupBlocked]]);
        server.clientCallbackChains = new Map();
        server.meshClientService = meshClientService;
        server.disconnectAllMeshStreams = () => {
            server.onStreamDisconnected(existingStream, 'disconnect');
        };
        server.pendingStreamsByClientId = new Map();
        server.streamsByClientId = new Map();
        server.streamsById = new Map([[existingStream.id, existingStream]]);
        server.meshLinkController = { invalidateConnection: () => {}, close: async () => {} };
        server.connectedCallbacks = [];
        server.disconnectedCallbacks = [async () => disconnectedCallbacks++];
        server.installMetaProxy = () => {};
        server.enqueueClientRegistry = async (_clientId: string, fn: () => Promise<boolean>) => fn();
        server.isCurrentStream = () => true;
        server.cleanupStream = (stream: { clientId: string }) => {
            cleanedClientId = stream.clientId;
        };

        const stop = server.meshStop();
        await Promise.resolve();
        const lateStream = { id: 'late-connection', clientId: 'late-client', lastPingAt: Date.now(), meta: { role: 'client' }, supersede: false };
        const rejected = await server.postEstablishCheck(lateStream);

        assert.equal(fenced, 1);
        assert.equal(existingUnregisters, 1);
        assert.equal(meshClientService.isRunning, true);
        assert.equal(rejected, true);
        assert.equal(cleanedClientId, lateStream.clientId);
        assert.equal(await meshClientService.activateClient(), false);

        releaseCleanup!();
        await stop;
        assert.equal(disconnectedCallbacks, 1);
    });

    it('returns from pending-start shutdown when mesh-link close never settles and keeps restart fenced', async () => {
        const server = Object.create(MeshSrpcServer.prototype) as any;
        let releaseStart: (() => void) | undefined;
        const startBlocked = new Promise<void>(resolve => {
            releaseStart = resolve;
        });
        const closeBlocked = new Promise<void>(() => {});
        const old = { id: 'connection-old', clientId: 'client-1', meta: { role: 'client' } };
        let disconnectedCallbacks = 0;
        server.meshRunning = false;
        server.meshStopping = false;
        server.meshClosed = false;
        server.meshStartGeneration = 0;
        server.clientRegistryMetadata = new Map([[old.clientId, { role: 'client' }]]);
        server.pendingStreamsByClientId = new Map();
        server.streamsByClientId = new Map([[old.clientId, old]]);
        server.streamsById = new Map([[old.id, old]]);
        server.publishedStreams = new Set([old]);
        server.streamDisconnectionHandlers = [];
        server.logger = { error: () => {} };
        server.meshLogger = { warn: () => {} };
        server.lifecycleConnectedStreams = new Set([old]);
        server.pendingStartDisconnects = new Map();
        server.pendingStartDisconnectFenceDeadlines = new Map();
        server.pendingStartDisconnectCallbackQueued = new WeakSet();
        server.rollbackGatedDisconnects = new WeakSet();
        server.meshSupersedeReconcileMs = 1;
        server.meshSupersedeReconcileRetryMs = 1;
        server.clientRegistryChains = new Map();
        server.clientCallbackChains = new Map();
        server.meshClientService = {
            instanceId: 1,
            setRemoteTransport: () => {},
            start: async () => startBlocked,
            stop: async () => {},
            fenceForShutdown: () => {},
            unregisterClient: async () => false,
            clientRegistry: { getClient: async () => undefined }
        };
        server.meshLinkController = { close: () => closeBlocked, invalidateConnection: () => {} };
        server.resolveMeshLinkConfig = () => undefined;
        server.connectedCallbacks = [];
        server.disconnectedCallbacks = [async () => disconnectedCallbacks++];
        server.isCurrentStream = () => true;
        server.disconnectAllMeshStreams = () => server.onStreamDisconnected(old, 'disconnect');

        const start = server.meshStart();
        await Promise.resolve();
        await server.meshStop();
        assert.equal(server.meshLinkController, undefined);

        releaseStart!();
        await assert.rejects(start, /startup was cancelled/);
        await waitFor(() => disconnectedCallbacks === 1);
        assert.equal(disconnectedCallbacks, 1);
        const queuedStart = server.meshStart();
        let queuedSettled = false;
        void queuedStart.then(
            () => {
                queuedSettled = true;
            },
            () => {
                queuedSettled = true;
            }
        );
        await Promise.resolve();
        assert.equal(queuedSettled, false);
        assert.equal(server.startupState, 'draining');
    });

    it('does not let a never-settling controller close delay normal membership cleanup or restart', async () => {
        const server = Object.create(MeshSrpcServer.prototype) as any;
        const closeBlocked = new Promise<void>(() => {});
        let stops = 0;
        server.meshRunning = true;
        server.meshStopping = false;
        server.clientRegistryMetadata = new Map();
        server.clientRegistryChains = new Map();
        server.clientCallbackChains = new Map();
        server.meshClientService = {
            fenceAdmission: () => {},
            setRemoteTransport: () => {},
            stop: async () => {
                stops++;
            },
            prepareStart: () => {}
        };
        server.disconnectAllMeshStreams = () => {};
        server.meshLinkController = { close: () => closeBlocked };

        await server.meshStop();
        assert.equal(stops, 1);
        assert.equal(server.startupState, 'draining');
        const restart = server.meshStart();
        let restartSettled = false;
        void restart.then(
            () => (restartSettled = true),
            () => (restartSettled = true)
        );
        await Promise.resolve();
        assert.equal(restartSettled, false);
    });

    it('does not let a never-settling application callback delay normal membership cleanup', async () => {
        const server = Object.create(MeshSrpcServer.prototype) as any;
        let stops = 0;
        server.meshRunning = true;
        server.meshStopping = false;
        server.clientRegistryMetadata = new Map();
        server.clientRegistryChains = new Map();
        server.clientCallbackChains = new Map([['client-1', new Promise<void>(() => {})]]);
        server.meshClientService = {
            fenceAdmission: () => {},
            setRemoteTransport: () => {},
            stop: async () => stops++
        };
        server.disconnectAllMeshStreams = () => {};

        const stopped = await Promise.race([
            server.meshStop().then(() => true),
            new Promise<boolean>(resolve => setTimeout(() => resolve(false), 50))
        ]);

        assert.equal(stopped, true);
        assert.equal(stops, 1);
    });

    it('fails closed after a detached controller close rejects with an empty value', async () => {
        const server = Object.create(MeshSrpcServer.prototype) as any;
        server.meshRunning = true;
        server.meshStopping = false;
        server.meshClosed = false;
        server.meshStartGeneration = 0;
        server.meshLogger = { warn: () => {} };
        server.clientRegistryMetadata = new Map();
        server.clientRegistryChains = new Map();
        server.clientCallbackChains = new Map();
        server.meshClientService = {
            fenceAdmission: () => {},
            setRemoteTransport: () => {},
            stop: async () => {},
            prepareStart: () => {}
        };
        server.disconnectAllMeshStreams = () => {};
        server.meshLinkController = { close: () => Promise.reject(undefined) };

        await server.meshStop();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(server.startupState, 'failed');
        await assert.rejects(server.meshStart(), error => error instanceof Error && error.message === 'undefined');
    });

    it('fails closed after ordinary mesh membership cleanup rejects', async () => {
        const server = Object.create(MeshSrpcServer.prototype) as any;
        server.meshRunning = true;
        server.meshStopping = false;
        server.meshClosed = false;
        server.meshStartGeneration = 0;
        server.meshLogger = { warn: () => {} };
        server.clientRegistryMetadata = new Map();
        server.clientRegistryChains = new Map();
        server.clientCallbackChains = new Map();
        server.meshClientService = {
            fenceAdmission: () => {},
            setRemoteTransport: () => {},
            stop: async () => {
                throw new Error('registry cleanup failed');
            },
            prepareStart: () => {}
        };
        server.disconnectAllMeshStreams = () => {};
        server.meshLinkController = { close: async () => {} };

        await assert.rejects(server.meshStop(), /registry cleanup failed/);
        assert.equal(server.startupState, 'failed');
        await assert.rejects(server.meshStart(), /registry cleanup failed/);
    });

    it('normalizes empty ordinary cleanup rejections into durable failures', async () => {
        for (const rejection of [undefined, null]) {
            const server = Object.create(MeshSrpcServer.prototype) as any;
            server.meshRunning = true;
            server.meshStopping = false;
            server.meshClosed = false;
            server.meshStartGeneration = 0;
            server.meshLogger = { warn: () => {} };
            server.clientRegistryMetadata = new Map();
            server.clientRegistryChains = new Map();
            server.clientCallbackChains = new Map();
            server.meshClientService = {
                fenceAdmission: () => {},
                setRemoteTransport: () => {},
                stop: async () => Promise.reject(rejection),
                prepareStart: () => {}
            };
            server.disconnectAllMeshStreams = () => {};

            await assert.rejects(server.meshStop(), error => error instanceof Error && error.message === String(rejection));
            assert.equal(server.startupState, 'failed');
            await assert.rejects(server.meshStart(), error => error === server.meshCleanupFailure);
        }
    });

    it('attempts normal membership cleanup after synchronous mesh-link release failure', async () => {
        const server = Object.create(MeshSrpcServer.prototype) as any;
        let stops = 0;
        server.meshRunning = true;
        server.meshStopping = false;
        server.meshClosed = false;
        server.meshStartGeneration = 0;
        server.meshLogger = { warn: () => {} };
        server.clientRegistryMetadata = new Map();
        server.clientRegistryChains = new Map();
        server.clientCallbackChains = new Map();
        server.meshClientService = {
            fenceAdmission: () => {},
            stop: async () => stops++
        };
        server.disconnectAllMeshStreams = () => {};
        server.releaseMeshLinkResources = async () => {
            throw new Error('route release failed');
        };

        await assert.rejects(server.meshStop(), /route release failed/);
        assert.equal(stops, 1);
        assert.equal(server.startupState, 'failed');
    });

    it('returns from shutdown while mesh startup is pending and rolls it back once it settles', async () => {
        const server = Object.create(MeshSrpcServer.prototype) as any;
        let releaseStart: (() => void) | undefined;
        const startBlocked = new Promise<void>(resolve => {
            releaseStart = resolve;
        });
        let stops = 0;
        server.meshRunning = false;
        server.meshStopping = false;
        server.meshClosed = false;
        server.meshStartGeneration = 0;
        server.clientRegistryMetadata = new Map();
        server.pendingStreamsByClientId = new Map();
        server.streamsByClientId = new Map();
        server.clientRegistryChains = new Map();
        server.clientCallbackChains = new Map();
        server.meshClientService = {
            instanceId: 1,
            setRemoteTransport: () => {},
            start: async () => startBlocked,
            stop: async () => {
                stops++;
            }
        };
        server.resolveMeshLinkConfig = () => undefined;

        const start = server.meshStart();
        await Promise.resolve();
        await server.meshStop();
        assert.equal(stops, 0, 'shutdown must not wait for or stop through the blocked startup lifecycle');

        releaseStart!();
        await assert.rejects(start, /startup was cancelled/);
        await server.meshPendingStartCleanup;
        assert.equal(stops, 1);
        assert.equal(server.meshRunning, false);
    });

    it('installs cancelled-start rollback despite a pending-stop route-release failure', async () => {
        const server = Object.create(MeshSrpcServer.prototype) as any;
        let releaseStart!: () => void;
        const startBlocked = new Promise<void>(resolve => {
            releaseStart = resolve;
        });
        let starts = 0;
        let rollbacks = 0;
        let releases = 0;
        server.meshRunning = false;
        server.meshStopping = false;
        server.meshClosed = false;
        server.meshStartGeneration = 0;
        server.meshLogger = { warn: () => {} };
        server.clientRegistryMetadata = new Map();
        server.pendingStreamsByClientId = new Map();
        server.streamsByClientId = new Map();
        server.clientRegistryChains = new Map();
        server.clientCallbackChains = new Map();
        server.meshClientService = {
            prepareStart: () => {},
            fenceForShutdown: () => {}
        };
        server.startMesh = async (generation: number) => {
            starts++;
            if (starts === 1) {
                await startBlocked;
                server.assertMeshStartCurrent(generation);
            }
        };
        server.rollbackMeshStart = async () => {
            rollbacks++;
        };
        server.disconnectAllMeshStreams = () => {};
        server.releaseMeshLinkResources = async () => {
            releases++;
            if (releases === 1) throw new Error('route release failed');
        };

        const start = server.meshStart();
        await Promise.resolve();
        await assert.rejects(server.meshStop(), /route release failed/);

        releaseStart();
        await assert.rejects(start, /startup was cancelled/);
        await server.meshPendingStartCleanup;
        assert.equal(rollbacks, 2);

        await server.meshStart();
        assert.equal(starts, 2);
        assert.equal(server.meshCleanupFailure, undefined);
    });

    it('rejects unsafe public invocation and mesh-link request timers eagerly', async () => {
        const server = Object.create(MeshSrpcServer.prototype) as any;
        for (const timeout of [0, Number.NaN, Number.POSITIVE_INFINITY, 1.5, 0x80000000]) {
            await assert.rejects(server.invoke('client-1', 'dNotify', {}, timeout), /safe positive integer/);
        }
        server.meshLinkOptions = {
            secret,
            requestTimeoutMs: Number.POSITIVE_INFINITY
        };
        server.options = { wsPath: '/client' };
        assert.throws(() => server.resolveMeshLinkConfig(), /safe positive integer/);
    });

    it('uses the application listener by default and supports an explicit mesh-link listener override', () => {
        const clientListener = createServer();
        const explicitMeshListener = createServer();
        const server = Object.create(MeshSrpcServer.prototype) as any;
        server.meshLinkOptions = { secret };
        server.options = { wsPath: '/client', httpServer: clientListener };
        server.resolveMeshLinkHttpServer = () => undefined;

        assert.equal(server.resolveMeshLinkConfig().httpServer, undefined);
        const source = (MeshSrpcServer.prototype as any).startMesh.toString();
        assert.ok(source.includes('httpServer: linkConfig.httpServer'), 'advertised address must use the selected application listener');

        server.meshLinkOptions = { secret, httpServer: explicitMeshListener };
        server.resolveMeshLinkHttpServer = () => explicitMeshListener;
        assert.equal(server.resolveMeshLinkConfig().httpServer, explicitMeshListener);
    });

    it('reads registered clients without reserving a remote handle and projects local pre-start streams', async () => {
        const record = {
            clientId: 'remote-client',
            nodeId: 41,
            connectionId: 'remote-generation',
            connectedAt: 1234,
            metadata: { role: 'remote' }
        };
        const running = Object.create(MeshSrpcServer.prototype) as any;
        running.meshRunning = true;
        running.meshClientService = {
            instanceId: 7,
            clientRegistry: {
                getClient: async (clientId: string) => (clientId === record.clientId ? record : undefined),
                listClients: async () => [record]
            }
        };
        running.resolveClient = async () => {
            throw new Error('registry reads must not resolve remote handles');
        };

        assert.deepEqual(await running.getRegisteredClient(record.clientId), record);
        assert.deepEqual(await running.listRegisteredClients(), [record]);

        const local = Object.create(MeshSrpcServer.prototype) as any;
        local.meshRunning = false;
        local.meshClientService = { instanceId: 9 };
        local.extractRegistryMetadataFn = (stream: { meta: FullClientMeta }) => ({ role: stream.meta.role });
        local.streamsByClientId = new Map([
            ['local-client', { clientId: 'local-client', id: 'local-generation', connectedAt: 5678, meta: { role: 'local', secret: 'hidden' } }]
        ]);

        assert.deepEqual(await local.getRegisteredClient('local-client'), {
            clientId: 'local-client',
            nodeId: 9,
            connectionId: 'local-generation',
            connectedAt: 5678,
            metadata: { role: 'local' }
        });
        assert.deepEqual((await local.listRegisteredClients())[0], {
            clientId: 'local-client',
            nodeId: 9,
            connectionId: 'local-generation',
            connectedAt: 5678,
            metadata: { role: 'local' }
        });

        local.extractRegistryMetadataFn = undefined;
        const localRegistration = await local.getRegisteredClient('local-client');
        assert.ok(localRegistration);
        (localRegistration.metadata as FullClientMeta).role = 'mutated-through-registration';
        assert.equal(local.streamsByClientId.get('local-client').meta.role, 'local');
    });

    it('preserves the supersede disconnect cause when another mesh node claims the exact generation', async () => {
        const stream = { id: 'generation-old', clientId: 'client-1' };
        let cleanupCause: string | undefined;
        const server = Object.create(MeshSrpcServer.prototype) as any;
        server.streamsById = new Map([[stream.id, stream]]);
        server.streamsByClientId = new Map([[stream.clientId, stream]]);
        server.pendingStartDisconnects = new Map();
        server.pendingStartDisconnectFenceDeadlines = new Map();
        server.rollbackGatedDisconnects = new WeakSet();
        server.meshLogger = { info: () => {} };
        server.cleanupStream = (_stream: unknown, cause: string) => {
            cleanupCause = cause;
        };

        assert.equal(await server.handleClientSuperseded(stream.clientId, stream.id, 'supersede'), true);
        assert.equal(cleanupCause, 'supersede');
    });

    it('reconciles live takeover lifecycle callbacks: committed replacement suppresses, abort emits once, and ordinary exact disconnect is immediate', async () => {
        const run = async (reason: 'supersede' | 'disconnect', committed: boolean, queueConnected = false) => {
            const stream = { id: 'generation-old', clientId: 'client-1', meta: { role: 'old' } };
            let callbacks = 0;
            const callbackOrder: string[] = [];
            const server = Object.create(MeshSrpcServer.prototype) as any;
            server.meshLogger = { info: () => {}, warn: () => {} };
            server.logger = { error: () => {} };
            server.publishedStreams = new Set([stream]);
            server.streamDisconnectionHandlers = [];
            server.lifecycleConnectedStreams = new Set([stream]);
            server.pendingStartDisconnects = new Map();
            server.pendingStartDisconnectFenceDeadlines = new Map();
            server.pendingStartDisconnectCallbackQueued = new WeakSet();
            server.rollbackGatedDisconnects = new WeakSet();
            server.meshSupersedeReconcileMs = 1;
            server.meshSupersedeReconcileRetryMs = 1;
            server.clientRegistryChains = new Map();
            server.clientCallbackChains = new Map();
            server.clientRegistryMetadata = new Map([[stream.clientId, stream.meta]]);
            server.streamsById = new Map([[stream.id, stream]]);
            server.streamsByClientId = new Map([[stream.clientId, stream]]);
            server.pendingStreamsByClientId = new Map();
            server.connectedCallbacks = [];
            server.disconnectedCallbacks = [
                async () => {
                    callbacks++;
                    callbackOrder.push('disconnected');
                }
            ];
            server.meshLinkController = { invalidateConnection: () => {} };
            server.meshClientService = {
                instanceId: 1,
                unregisterClient: async () => true,
                clientRegistry: {
                    getClient: async () => (committed ? { clientId: stream.clientId, nodeId: 2, connectionId: 'replacement' } : undefined)
                }
            };
            server.cleanupStream = (target: any, cause: any) => server.onStreamDisconnected(target, cause);

            await server.handleClientSuperseded(stream.clientId, stream.id, reason);
            if (queueConnected) {
                void server.enqueueClientCallback(stream.clientId, async () => {
                    callbackOrder.push('connected');
                });
            }
            await Promise.all([...server.clientRegistryChains.values()]);
            await new Promise(resolve => setTimeout(resolve, 5));
            await Promise.all([...server.clientCallbackChains.values()]);
            return { callbacks, callbackOrder, server };
        };

        assert.equal((await run('supersede', true)).callbacks, 0);
        assert.equal((await run('supersede', false)).callbacks, 1);
        const ordinary = await run('disconnect', false);
        assert.equal(ordinary.callbacks, 1);
        assert.equal(ordinary.server.pendingStartDisconnectFenceDeadlines.size, 0);
        const ordered = await run('supersede', false, true);
        assert.deepEqual(ordered.callbackOrder, ['disconnected', 'connected']);
    });

    it('uses the supersede fence rather than an ordinary disconnect for remote ownership handoffs', async () => {
        const stream = { id: 'generation-old', clientId: 'client-1' };
        let ordinaryDisconnects = 0;
        const fences: Array<{ clientId: string; connectionId: string; reason: string | undefined }> = [];
        const controller = new MeshSrpcLinkController<SrpcMeta, SrpcMeta>({
            meshKey: 'remote-fence-cause',
            requestTimeoutMs: 1_000,
            runtime: { onPeerClosed: () => () => {} } as any,
            service: { instanceId: 1, clientRegistry: { getClient: async () => undefined }, mesh: {} } as any,
            getLocalConnection: clientId => (clientId === stream.clientId ? (stream as any) : undefined),
            invokeLocal: async () => Buffer.alloc(0),
            reserveLocalSenderIds: () => [],
            writeLocalStream: async () => {},
            finishLocalStream: async () => {},
            destroyLocalStream: async () => {},
            attachLocalReceiver: () => {
                throw new Error('not needed');
            },
            disconnectLocal: async () => {
                ordinaryDisconnects++;
            },
            fenceLocal: async (clientId, connectionId, reason) => {
                fences.push({ clientId, connectionId, reason });
            },
            updateLocalMetadata: async () => {}
        });
        (controller as any).verifyPeerMembership = async () => {};
        (controller as any).assertLeaseSafe = () => {};

        try {
            await controller.route(
                { connected: true } as any,
                {
                    header: { type: 'fenceClient', clientId: stream.clientId, connectionId: stream.id, reason: 'supersede' },
                    body: Buffer.alloc(0)
                } as any
            );
            assert.equal(ordinaryDisconnects, 0);
            assert.deepEqual(fences, [{ clientId: stream.clientId, connectionId: stream.id, reason: 'supersede' }]);
        } finally {
            await controller.close();
        }
    });

    it('routes production controller fences through deferred generations after stream removal', async () => {
        const removed = { id: 'generation-removed', clientId: 'client-1' };
        const calls: Array<{ clientId: string; connectionId: string; reason: string | undefined }> = [];
        const server = Object.create(MeshSrpcServer.prototype) as any;
        server.meshKey = 'server-controller-fence';
        server.meshLinkRequestTimeoutMs = 1_000;
        server.meshClientService = { mesh: {}, clientRegistry: {}, instanceId: 1 };
        server.streamsByClientId = new Map();
        server.streamsById = new Map();
        server.pendingStartDisconnects = new Map([[removed, { clientId: removed.clientId, connectionId: removed.id, nodeId: 1, metadata: {} }]]);
        server.handleClientSuperseded = async (clientId: string, connectionId: string, reason: string | undefined) => {
            calls.push({ clientId, connectionId, reason });
            return true;
        };

        const controller = server.createMeshLinkController({ onPeerClosed: () => () => {} } as any);
        const options = (controller as any).options;
        try {
            assert.equal(options.hasLocalFenceConnection(removed.clientId, removed.id), true);
            assert.equal(await options.fenceLocal(removed.clientId, removed.id, 'supersede'), true);
            assert.deepEqual(calls, [{ clientId: removed.clientId, connectionId: removed.id, reason: 'supersede' }]);
        } finally {
            await controller.close();
        }
    });

    it('cleans registry ownership before callbacks and releases the mesh route after lease failure', async () => {
        let controllerCloses = 0;
        let routeUnregistrations = 0;
        const remoteTransports: unknown[] = [];
        const lifecycle: string[] = [];
        let releaseCleanup!: () => void;
        const cleanupBlocked = new Promise<void>(resolve => {
            releaseCleanup = resolve;
        });
        const server = Object.create(MeshSrpcServer.prototype) as any;
        server.meshLogger = { warn: () => {} };
        server.meshRunning = true;
        server.streamsByClientId = new Map();
        server.pendingStreamsByClientId = new Map();
        server.clientRegistryMetadata = new Map();
        server.meshLinkRuntime = {};
        server.meshLinkController = { close: async () => controllerCloses++ };
        server.unregisterMeshLinkRoute = () => routeUnregistrations++;
        server.meshClientService = {
            cleanupRegistryOwnership: async () => {
                await cleanupBlocked;
                lifecycle.push('registry-cleanup');
            },
            setRemoteTransport: (transport: unknown) => remoteTransports.push(transport)
        };
        server.dispatchPendingStartDisconnects = async () => lifecycle.push('callbacks');

        const failure = new Error('lease lost');
        const cleanup = server.handleMeshLeaseLost(failure);
        await new Promise<void>(resolve => setImmediate(resolve));

        assert.deepEqual(lifecycle, []);
        assert.equal(controllerCloses, 0);
        assert.equal(routeUnregistrations, 0);

        releaseCleanup();
        await cleanup;

        assert.equal(server.meshRunning, false);
        assert.strictEqual(server.meshLeaseFailure, failure);
        assert.deepEqual(lifecycle, ['registry-cleanup', 'callbacks']);
        assert.equal(controllerCloses, 1);
        assert.deepEqual(remoteTransports, [undefined]);
        assert.equal(routeUnregistrations, 1);
        assert.equal(server.meshLinkController, undefined);
        assert.equal(server.meshLinkRuntime, undefined);
    });

    it('preinstalls the lease cleanup join barrier before synchronous teardown can reenter meshStop', async () => {
        const server = new MeshSrpcServer({
            logger: createLogger('MeshLeaseCleanupJoin'),
            clientMessage: JsonMessage,
            serverMessage: JsonMessage,
            wsPath: '/lease-cleanup-join',
            meshKey: 'lease-cleanup-join',
            autoLifecycle: false
        });
        let releaseCleanup!: () => void;
        const cleanupBlocked = new Promise<void>(resolve => {
            releaseCleanup = resolve;
        });
        let stopped = false;
        let reentrantStop: Promise<void> | undefined;
        (server as any).handleMeshLeaseLost = () => {
            reentrantStop = server.meshStop().then(() => {
                stopped = true;
            });
            return cleanupBlocked;
        };
        const leaseCallback = (server as any).meshClientService.leaseLostCallbacks[0] as (reason?: Error) => Promise<void>;
        const leaseCleanup = leaseCallback(new Error('lease lost'));
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(stopped, false);
        assert.ok(reentrantStop);

        releaseCleanup();
        await Promise.all([leaseCleanup, reentrantStop]);
        assert.equal(stopped, true);
        server.close();
    });

    it('retains failed lease cleanup for explicit meshStop retries', async () => {
        const server = new MeshSrpcServer({
            logger: createLogger('MeshLeaseCleanupRetry'),
            clientMessage: JsonMessage,
            serverMessage: JsonMessage,
            wsPath: '/lease-cleanup-retry',
            meshKey: 'lease-cleanup-retry',
            autoLifecycle: false
        });
        // Keep the test deterministic: production schedules the same retry on
        // an unref timer, while meshStop always retries immediately.
        (server as any).meshClosed = true;
        let attempts = 0;
        (server as any).handleMeshLeaseLost = async () => {
            attempts++;
            if (attempts <= 2) throw new Error(`cleanup unavailable ${attempts}`);
        };
        const leaseCallback = (server as any).meshClientService.leaseLostCallbacks[0] as (reason?: Error) => Promise<void>;

        await assert.rejects(leaseCallback(new Error('lease lost')), /cleanup unavailable 1/);
        assert.equal((server as any).meshLeaseCleanupRequired, true);
        await assert.rejects(server.meshStop(), /cleanup unavailable 2/);
        assert.equal((server as any).meshLeaseCleanupRequired, true);
        await server.meshStop();

        assert.equal(attempts, 3);
        assert.equal((server as any).meshLeaseCleanupRequired, false);
        server.close();
    });

    it('automatically retries lease cleanup without overlapping or escaping a concurrent meshStop join', async () => {
        const server = new MeshSrpcServer({
            logger: createLogger('MeshLeaseCleanupAutomaticRetry'),
            clientMessage: JsonMessage,
            serverMessage: JsonMessage,
            wsPath: '/lease-cleanup-automatic-retry',
            meshKey: 'lease-cleanup-automatic-retry',
            autoLifecycle: false
        });
        (server as any).meshLeaseCleanupRetryMs = 20;
        let attempts = 0;
        let activeAttempts = 0;
        let maxActiveAttempts = 0;
        let releaseRetry!: () => void;
        const retryBlocked = new Promise<void>(resolve => {
            releaseRetry = resolve;
        });
        (server as any).handleMeshLeaseLost = async () => {
            attempts++;
            activeAttempts++;
            maxActiveAttempts = Math.max(maxActiveAttempts, activeAttempts);
            try {
                if (attempts === 1) throw new Error('initial cleanup unavailable');
                await retryBlocked;
            } finally {
                activeAttempts--;
            }
        };
        const leaseCallback = (server as any).meshClientService.leaseLostCallbacks[0] as (reason?: Error) => Promise<void>;

        await assert.rejects(leaseCallback(new Error('lease lost')), /initial cleanup unavailable/);
        const retryTimer = (server as any).meshLeaseCleanupRetryTimer as ReturnType<typeof setTimeout>;
        assert.ok(retryTimer);
        assert.equal(retryTimer.hasRef(), false);
        await waitFor(() => attempts === 2);

        let stopped = false;
        const stop = server.meshStop().then(() => {
            stopped = true;
        });
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(stopped, false);
        assert.equal(attempts, 2);
        assert.equal(maxActiveAttempts, 1);

        releaseRetry();
        await stop;
        assert.equal(stopped, true);
        assert.equal((server as any).meshLeaseCleanupRequired, false);
        assert.equal((server as any).meshLeaseCleanupRetryTimer, undefined);
        server.close();
    });

    it('does not emit an offline lifecycle event after a remote ownership fence', async () => {
        const stream = { id: 'generation-old', clientId: 'client-1' };
        let disconnected = 0;
        const server = Object.create(MeshSrpcServer.prototype) as any;
        server.publishedStreams = new Set([stream]);
        server.streamDisconnectionHandlers = new Set();
        server.logger = { error: () => {} };
        server.meshLogger = { warn: () => {} };
        server.lifecycleConnectedStreams = new WeakSet([stream]);
        server.clientRegistryChains = new Map();
        server.clientCallbackChains = new Map();
        server.pendingStreamsByClientId = new Map();
        server.streamsByClientId = new Map();
        server.clientRegistryMetadata = new Map([[stream.clientId, { role: 'old' }]]);
        server.meshLinkController = { invalidateConnection: () => {} };
        server.meshClientService = { unregisterClient: async () => true };
        server.disconnectedCallbacks = new Set([() => disconnected++]);

        server.onStreamDisconnected(stream, 'supersede');
        await Promise.all([...server.clientRegistryChains.values()]);
        await Promise.all([...server.clientCallbackChains.values()]);

        assert.equal(disconnected, 0);
        assert.equal(server.clientRegistryMetadata.has(stream.clientId), false);
    });

    it('rejects stale local handles before updating replacement metadata', async () => {
        const stale = { id: 'connection-1', clientId: 'client-1', meta: { role: 'stale' } };
        const current = { id: 'connection-2', clientId: 'client-1', meta: { role: 'current' } };
        const server = Object.create(MeshSrpcServer.prototype) as any;
        server.streamsByClientId = new Map([[current.clientId, current]]);
        server.clientRegistryMetadata = new Map([[current.clientId, { ...current.meta }]]);
        server.meshClientService = {
            updateClientMetadata: async (_clientId: string, metadata: SrpcMeta) => {
                Object.assign(current.meta, metadata);
                return true;
            }
        };

        await assert.rejects(server.updateClientMetadata(stale, { role: 'retargeted' }), SrpcStaleConnectionError);
        assert.deepEqual(current.meta, { role: 'current' });
    });

    it('rejects metadata updates fenced while their registry CAS is in flight', async () => {
        const server = Object.create(MeshSrpcServer.prototype) as any;
        let updateStarted!: () => void;
        let pendingUpdate = Promise.resolve();
        let registeredClient: RegisteredClient<{ role: string }>;
        const registry = {
            updateMetadata: async () => {
                updateStarted!();
                await pendingUpdate;
                return true;
            },
            getClient: async () => registeredClient
        };
        server.meshKey = 'metadata-race';
        server.meshLinkRequestTimeoutMs = 1_000;
        server.pendingStreamsByClientId = new Map();
        server.streamsByClientId = new Map();
        server.streamsById = new Map();
        server.clientRegistryMetadata = new Map();
        server.meshClientService = { instanceId: 1, clientRegistry: registry };

        const controller = server.createMeshLinkController({
            registerEndpointPinResolver: () => () => {},
            onPeerClosed: () => () => {}
        });

        const assertFenced = async (update: (stream: any) => Promise<unknown>) => {
            const old = { id: 'connection-old', clientId: 'client-1', connected: true, meta: { role: 'old' } };
            const replacement = { id: 'connection-new', clientId: 'client-1', connected: true, meta: { role: 'replacement' } };
            server.streamsByClientId.set(old.clientId, old);
            server.streamsById.set(old.id, old);
            server.clientRegistryMetadata.set(old.clientId, { ...old.meta });
            registeredClient = {
                clientId: old.clientId,
                nodeId: 1,
                connectionId: old.id,
                connectedAt: Date.now(),
                metadata: { ...old.meta }
            };
            const started = new Promise<void>(resolve => {
                updateStarted = resolve;
            });
            let resolveRelease!: () => void;
            pendingUpdate = new Promise<void>(resolve => {
                resolveRelease = resolve;
            });

            const updating = update(old);
            await started;
            server.streamsByClientId.set(old.clientId, replacement);
            server.streamsById.delete(old.id);
            server.streamsById.set(replacement.id, replacement);
            registeredClient = {
                clientId: replacement.clientId,
                nodeId: 2,
                connectionId: replacement.id,
                connectedAt: Date.now(),
                metadata: { ...replacement.meta }
            };
            resolveRelease();

            await assert.rejects(updating, SrpcStaleConnectionError);
            assert.deepEqual(old.meta, { role: 'old' });
            assert.deepEqual(server.clientRegistryMetadata.get(old.clientId), { role: 'old' });
        };

        try {
            await assertFenced(stream => server.updateClientMetadata(stream, { role: 'updated' }));
            await assertFenced(stream => (controller as any).options.updateLocalMetadata(stream.clientId, stream.id, { role: 'updated' }));
        } finally {
            await controller.close();
        }
    });

    it('always exact-CAS unregisters a superseded local generation while preserving a committed replacement', async () => {
        const runCleanup = async (registeredConnectionId: string, replaceWhileUnregistering = false) => {
            const old = { id: 'connection-old', clientId: 'client-1', meta: { role: 'old' } };
            const replacement = { id: 'connection-new', clientId: 'client-1', meta: { role: 'replacement' } };
            let currentRegistration: string | undefined = registeredConnectionId;
            let releaseUnregister: (() => void) | undefined;
            let unregisterStarted = false;
            const unregisterBlocked = new Promise<void>(resolve => {
                releaseUnregister = resolve;
            });
            const server = Object.create(MeshSrpcServer.prototype) as any;
            server.publishedStreams = new Set([old]);
            server.streamDisconnectionHandlers = [];
            server.logger = { error: () => {} };
            server.meshLogger = { warn: () => {} };
            server.lifecycleConnectedStreams = new Set([old]);
            server.clientRegistryChains = new Map();
            server.clientCallbackChains = new Map();
            server.pendingStreamsByClientId = replaceWhileUnregistering ? new Map() : new Map([[old.clientId, replacement]]);
            server.streamsByClientId = new Map();
            server.clientRegistryMetadata = new Map([[old.clientId, { role: 'replacement' }]]);
            server.connectedCallbacks = [];
            server.disconnectedCallbacks = [];
            server.meshLinkController = { invalidateConnection: () => {} };
            server.meshClientService = {
                unregisterClient: async (_clientId: string, connectionId: string) => {
                    unregisterStarted = true;
                    if (replaceWhileUnregistering) await unregisterBlocked;
                    if (currentRegistration !== connectionId) return false;
                    currentRegistration = undefined;
                    return true;
                }
            };

            server.onStreamDisconnected(old, 'supersede');
            const cleanup = [...server.clientRegistryChains.values()][0] as Promise<void>;
            if (replaceWhileUnregistering) {
                await waitFor(() => unregisterStarted);
                server.pendingStreamsByClientId.set(old.clientId, replacement);
                currentRegistration = replacement.id;
                releaseUnregister!();
            }
            await cleanup;
            assert.deepEqual(server.clientRegistryMetadata.get(old.clientId), { role: 'replacement' });
            return currentRegistration;
        };

        // If replacement reservation later fails, the physically closed old
        // generation is no longer left as phantom ownership.
        assert.equal(await runCleanup('connection-old'), undefined);
        // If replacement commit won the race first, the old generation's exact
        // unregister cannot delete it.
        assert.equal(await runCleanup('connection-new'), 'connection-new');
        // The replacement check is performed after the awaited CAS, so a
        // replacement that becomes current during Redis I/O keeps its metadata.
        assert.equal(await runCleanup('connection-old', true), 'connection-new');
    });

    it('emits one disconnect callback only after exact unregister is confirmed', async () => {
        const old = { id: 'connection-old', clientId: 'client-1', meta: { role: 'old' } };
        let confirmUnregister!: (removed: boolean) => void;
        const unregister = new Promise<boolean>(resolve => {
            confirmUnregister = resolve;
        });
        let callbacks = 0;
        const server = Object.create(MeshSrpcServer.prototype) as any;
        server.publishedStreams = new Set([old]);
        server.streamDisconnectionHandlers = [];
        server.logger = { error: () => {} };
        server.meshLogger = { warn: () => {} };
        server.lifecycleConnectedStreams = new Set([old]);
        server.clientRegistryChains = new Map();
        server.clientCallbackChains = new Map();
        server.pendingStreamsByClientId = new Map();
        server.streamsByClientId = new Map();
        server.streamsById = new Map([[old.id, old]]);
        server.clientRegistryMetadata = new Map([[old.clientId, { role: 'old' }]]);
        server.connectedCallbacks = [];
        server.disconnectedCallbacks = [
            async () => {
                callbacks++;
            }
        ];
        server.meshLinkController = { invalidateConnection: () => {} };
        server.meshClientService = {
            unregisterClient: async () => unregister
        };

        server.onStreamDisconnected(old, 'disconnect');
        const cleanup = [...server.clientRegistryChains.values()][0] as Promise<void>;
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(callbacks, 0);
        confirmUnregister(true);
        await cleanup;
        await Promise.all([...server.clientCallbackChains.values()]);
        assert.equal(callbacks, 1);

        server.onStreamDisconnected(old, 'disconnect');
        await Promise.all([...server.clientRegistryChains.values()]);
        await Promise.all([...server.clientCallbackChains.values()]);
        assert.equal(callbacks, 1);
    });

    it('defers a cancelled-start disconnect callback until ownership cleanup completes', async () => {
        const old = { id: 'connection-old', clientId: 'client-1', meta: { role: 'old' } };
        let callbacks = 0;
        const server = Object.create(MeshSrpcServer.prototype) as any;
        server.publishedStreams = new Set([old]);
        server.streamDisconnectionHandlers = [];
        server.logger = { error: () => {} };
        server.meshLogger = { warn: () => {} };
        server.lifecycleConnectedStreams = new Set([old]);
        server.pendingStartDisconnects = new Map();
        server.pendingStartDisconnectFenceDeadlines = new Map();
        server.pendingStartDisconnectCallbackQueued = new WeakSet();
        server.rollbackGatedDisconnects = new WeakSet();
        server.meshSupersedeReconcileMs = 1;
        server.meshSupersedeReconcileRetryMs = 1;
        server.clientRegistryChains = new Map();
        server.clientCallbackChains = new Map();
        server.pendingStreamsByClientId = new Map();
        server.streamsByClientId = new Map([[old.clientId, old]]);
        server.streamsById = new Map([[old.id, old]]);
        server.clientRegistryMetadata = new Map([[old.clientId, { role: 'old' }]]);
        server.connectedCallbacks = [];
        server.disconnectedCallbacks = [async () => callbacks++];
        server.meshLinkController = { invalidateConnection: () => {} };
        server.meshClientService = {
            instanceId: 1,
            unregisterClient: async () => false,
            clientRegistry: { getClient: async () => undefined }
        };
        server.isCurrentStream = () => true;

        server.capturePendingStartDisconnects();
        server.streamsByClientId.clear();
        server.onStreamDisconnected(old, 'disconnect');
        await Promise.all([...server.clientRegistryChains.values()]);
        await Promise.all([...server.clientCallbackChains.values()]);

        assert.equal(callbacks, 0);
        assert.equal(server.pendingStartDisconnects.size, 1);

        await server.dispatchPendingStartDisconnects();
        await Promise.all([...server.clientCallbackChains.values()]);
        assert.equal(callbacks, 1);
        assert.equal(server.pendingStartDisconnects.size, 0);

        await server.dispatchPendingStartDisconnects();
        assert.equal(callbacks, 1);
    });

    it('retains a deferred disconnect snapshot through a rejected local replacement', async () => {
        const old = { id: 'connection-old', clientId: 'client-1', meta: { role: 'old' } };
        const replacement = { id: 'connection-replacement', clientId: 'client-1', meta: { role: 'replacement' } };
        let callbacks = 0;
        const server = Object.create(MeshSrpcServer.prototype) as any;
        server.publishedStreams = new Set([old]);
        server.streamDisconnectionHandlers = [];
        server.logger = { error: () => {} };
        server.meshLogger = { warn: () => {} };
        server.lifecycleConnectedStreams = new Set([old]);
        server.pendingStartDisconnects = new Map([[old, { clientId: old.clientId, connectionId: old.id, nodeId: 1, metadata: { role: 'old' } }]]);
        server.clientRegistryChains = new Map();
        server.clientCallbackChains = new Map();
        server.pendingStreamsByClientId = new Map();
        server.streamsByClientId = new Map([[old.clientId, replacement]]);
        server.streamsById = new Map([
            [old.id, old],
            [replacement.id, replacement]
        ]);
        server.clientRegistryMetadata = new Map([[old.clientId, { role: 'old' }]]);
        server.connectedCallbacks = [];
        server.disconnectedCallbacks = [async () => callbacks++];
        server.meshLinkController = { invalidateConnection: () => {} };
        server.meshClientService = {
            unregisterClient: async () => false,
            clientRegistry: { getClient: async () => undefined }
        };

        server.onStreamDisconnected(old, 'disconnect');
        await Promise.all([...server.clientRegistryChains.values()]);
        assert.equal(server.pendingStartDisconnects.size, 1);

        server.streamsByClientId.clear();
        await server.dispatchPendingStartDisconnects();
        assert.equal(callbacks, 1);
    });

    it('suppresses a deferred disconnect when a remote exact fence commits before reconciliation', async () => {
        const old = { id: 'connection-old', clientId: 'client-1', meta: { role: 'old' } };
        let callbacks = 0;
        let committed = false;
        let lookups = 0;
        const server = Object.create(MeshSrpcServer.prototype) as any;
        server.meshLogger = { info: () => {}, warn: () => {} };
        server.meshSupersedeReconcileMs = 50;
        server.meshSupersedeReconcileRetryMs = 1;
        server.pendingStartDisconnects = new Map([[old, { clientId: old.clientId, connectionId: old.id, nodeId: 1, metadata: { role: 'old' } }]]);
        server.pendingStartDisconnectFenceDeadlines = new Map();
        server.pendingStartDisconnectCallbackQueued = new WeakSet();
        server.rollbackGatedDisconnects = new WeakSet();
        server.clientCallbackChains = new Map();
        server.disconnectedCallbacks = [async () => callbacks++];
        server.streamsById = new Map();
        server.meshClientService = {
            clientRegistry: {
                getClient: async () => {
                    lookups++;
                    return committed ? { clientId: old.clientId, nodeId: 2, connectionId: 'remote-connection' } : undefined;
                }
            }
        };

        assert.equal(await server.handleClientSuperseded(old.clientId, old.id, 'supersede'), true);
        await server.dispatchPendingStartDisconnects();
        await waitFor(() => lookups > 0);
        committed = true;
        await Promise.all([...server.clientCallbackChains.values()]);
        assert.equal(callbacks, 0);
        assert.equal(server.pendingStartDisconnects.size, 0);
    });

    it('suppresses rollback offline when a delayed fence commits after physical stream removal', async () => {
        const old = { id: 'connection-old', clientId: 'client-1' };
        let committed = false;
        let callbacks = 0;
        const server = Object.create(MeshSrpcServer.prototype) as any;
        server.meshLogger = { info: () => {}, warn: () => {} };
        server.meshSupersedeReconcileMs = 50;
        server.meshSupersedeReconcileRetryMs = 1;
        server.pendingStartDisconnects = new Map([[old, { clientId: old.clientId, connectionId: old.id, nodeId: 1, metadata: {} }]]);
        server.pendingStartDisconnectFenceDeadlines = new Map();
        server.pendingStartDisconnectCallbackQueued = new WeakSet();
        server.rollbackGatedDisconnects = new WeakSet([old]);
        server.clientCallbackChains = new Map();
        server.disconnectedCallbacks = [async () => callbacks++];
        server.streamsById = new Map();
        server.meshClientService = {
            clientRegistry: {
                getClient: async () => (committed ? { clientId: old.clientId, nodeId: 2, connectionId: 'remote-connection' } : undefined)
            }
        };

        await server.dispatchPendingStartDisconnects();
        assert.equal(server.pendingStartDisconnects.size, 0);
        assert.equal(await server.handleClientSuperseded(old.clientId, old.id, 'supersede'), true);
        committed = true;
        await Promise.all([...server.clientCallbackChains.values()]);

        assert.equal(callbacks, 0);
    });

    it('emits the deferred offline callback when a remote fence claim aborts', async () => {
        const old = { id: 'connection-old', clientId: 'client-1', meta: { role: 'old' } };
        let callbacks = 0;
        const server = Object.create(MeshSrpcServer.prototype) as any;
        server.meshLogger = { info: () => {}, warn: () => {} };
        server.meshSupersedeReconcileMs = 1;
        server.meshSupersedeReconcileRetryMs = 1;
        server.pendingStartDisconnects = new Map([[old, { clientId: old.clientId, connectionId: old.id, nodeId: 1, metadata: { role: 'old' } }]]);
        server.pendingStartDisconnectFenceDeadlines = new Map();
        server.pendingStartDisconnectCallbackQueued = new WeakSet();
        server.rollbackGatedDisconnects = new WeakSet();
        server.clientCallbackChains = new Map();
        server.disconnectedCallbacks = [async () => callbacks++];
        server.streamsById = new Map();
        server.meshClientService = { clientRegistry: { getClient: async () => undefined } };

        assert.equal(await server.handleClientSuperseded(old.clientId, old.id, 'supersede'), true);
        await server.dispatchPendingStartDisconnects();
        await Promise.all([...server.clientCallbackChains.values()]);
        assert.equal(callbacks, 1);
    });

    it('recovers from transient registry lookup failure inside the takeover reconciliation window', async () => {
        let attempts = 0;
        const server = Object.create(MeshSrpcServer.prototype) as any;
        server.meshSupersedeReconcileRetryMs = 1;
        server.meshClientService = {
            clientRegistry: {
                getClient: async () => {
                    attempts++;
                    if (attempts === 1) throw new Error('transient registry failure');
                    return { clientId: 'client-1', nodeId: 2, connectionId: 'replacement' };
                }
            }
        };

        assert.equal(
            await server.shouldDispatchPendingStartDisconnect(
                { clientId: 'client-1', connectionId: 'old', nodeId: 1, metadata: {} },
                Date.now() + 50
            ),
            false
        );
        assert.equal(attempts, 2);
    });

    it('keeps normal supersede reconciliation scoped away from unrelated rollback-gated snapshots', async () => {
        const normal = { id: 'connection-normal', clientId: 'client-normal' };
        const rollback = { id: 'connection-rollback', clientId: 'client-rollback' };
        const callbacks: string[] = [];
        const server = Object.create(MeshSrpcServer.prototype) as any;
        server.meshSupersedeReconcileRetryMs = 1;
        server.pendingStartDisconnects = new Map([
            [normal, { clientId: normal.clientId, connectionId: normal.id, nodeId: 1, metadata: { role: 'normal' } }],
            [rollback, { clientId: rollback.clientId, connectionId: rollback.id, nodeId: 1, metadata: { role: 'rollback' } }]
        ]);
        server.pendingStartDisconnectFenceDeadlines = new Map([[normal, Date.now() + 1]]);
        server.pendingStartDisconnectCallbackQueued = new WeakSet();
        server.rollbackGatedDisconnects = new WeakSet([rollback]);
        server.clientCallbackChains = new Map();
        server.disconnectedCallbacks = [async (clientId: string) => callbacks.push(clientId)];
        server.meshLogger = { warn: () => {} };
        server.meshClientService = { clientRegistry: { getClient: async () => undefined } };

        await server.dispatchPendingStartDisconnects(normal);
        await Promise.all([...server.clientCallbackChains.values()]);

        assert.deepEqual(callbacks, [normal.clientId]);
        assert.equal(server.pendingStartDisconnects.has(normal), false);
        assert.equal(server.pendingStartDisconnects.has(rollback), true);
    });

    it('bounds rollback reconciliation reads across many disconnected clients', async () => {
        const clientCount = 250;
        const entries: Array<[object, { clientId: string; connectionId: string; nodeId: number; metadata: object }]> = [];
        const rollbackStreams: object[] = [];
        for (let index = 0; index < clientCount; index++) {
            const stream = { id: `connection-${index}`, clientId: `client-${index}` };
            rollbackStreams.push(stream);
            entries.push([stream, { clientId: stream.clientId, connectionId: stream.id, nodeId: 1, metadata: {} }]);
        }
        let registryReads = 0;
        let callbacks = 0;
        const server = Object.create(MeshSrpcServer.prototype) as any;
        server.meshSupersedeReconcileMs = 15;
        server.meshSupersedeReconcileRetryMs = 1;
        server.pendingStartDisconnects = new Map(entries);
        server.pendingStartDisconnectFenceDeadlines = new Map();
        server.pendingStartDisconnectCallbackQueued = new WeakSet();
        server.rollbackGatedDisconnects = new WeakSet(rollbackStreams);
        server.clientCallbackChains = new Map();
        server.disconnectedCallbacks = [async () => callbacks++];
        server.meshLogger = { warn: () => {} };
        server.meshClientService = {
            clientRegistry: {
                getClient: async () => {
                    registryReads++;
                    return undefined;
                }
            }
        };

        await server.dispatchPendingStartDisconnects();
        await Promise.all([...server.clientCallbackChains.values()]);

        assert.equal(callbacks, clientCount);
        // One post-cleanup observation plus one claim-deadline observation per
        // client. The previous 1ms fixed polling loop performs thousands here
        // and scales that churn linearly into an outage.
        assert.ok(registryReads <= clientCount * 2, `expected at most ${clientCount * 2} registry reads, got ${registryReads}`);
    });

    it('requires rollback-gated registry reconciliation before releasing its restart barrier', async () => {
        const old = { id: 'connection-old', clientId: 'client-1' };
        for (const current of ['lookup-error', 'exact-old'] as const) {
            const server = Object.create(MeshSrpcServer.prototype) as any;
            server.pendingStartDisconnects = new Map([[old, { clientId: old.clientId, connectionId: old.id, nodeId: 1, metadata: {} }]]);
            server.pendingStartDisconnectFenceDeadlines = new Map([[old, Date.now() + 50]]);
            server.pendingStartDisconnectCallbackQueued = new WeakSet();
            server.rollbackGatedDisconnects = new WeakSet([old]);
            server.clientCallbackChains = new Map();
            server.disconnectedCallbacks = [];
            server.meshClientService = {
                clientRegistry: {
                    getClient: async () => {
                        if (current === 'lookup-error') throw new Error('registry unavailable');
                        return { clientId: old.clientId, nodeId: 1, connectionId: old.id };
                    }
                }
            };

            await assert.rejects(
                server.dispatchPendingStartDisconnects(),
                current === 'lookup-error' ? /registry unavailable/ : /exact old generation is still registered/
            );
            assert.equal(server.pendingStartDisconnects.has(old), true);
            assert.equal(server.clientCallbackChains.size, 0);
        }

        const replaced = Object.create(MeshSrpcServer.prototype) as any;
        replaced.pendingStartDisconnects = new Map([[old, { clientId: old.clientId, connectionId: old.id, nodeId: 1, metadata: {} }]]);
        replaced.pendingStartDisconnectFenceDeadlines = new Map([[old, Date.now() + 50]]);
        replaced.pendingStartDisconnectCallbackQueued = new WeakSet();
        replaced.rollbackGatedDisconnects = new WeakSet([old]);
        replaced.clientCallbackChains = new Map();
        replaced.disconnectedCallbacks = [];
        replaced.meshClientService = {
            clientRegistry: { getClient: async () => ({ clientId: old.clientId, nodeId: 2, connectionId: 'replacement' }) }
        };
        await replaced.dispatchPendingStartDisconnects();
        assert.equal(replaced.pendingStartDisconnects.size, 0);
        assert.equal(replaced.pendingStartDisconnectFenceDeadlines.size, 0);
    });

    it('fences delivery and performs explicit cleanup when deferred reconciliation fails', async () => {
        const old = { id: 'connection-old', clientId: 'client-1' };
        const other = { id: 'connection-other', clientId: 'client-2', meta: { role: 'other' } };
        let admissionFences = 0;
        let deliveryDisconnects = 0;
        let linkReleases = 0;
        let serviceStops = 0;
        let otherDisconnects = 0;
        let releaseServiceStop!: () => void;
        const serviceStopBlocked = new Promise<void>(resolve => {
            releaseServiceStop = resolve;
        });
        const server = Object.create(MeshSrpcServer.prototype) as any;
        server.meshRunning = true;
        server.meshClosed = false;
        server.meshSupersedeReconcileMs = 1;
        server.meshSupersedeReconcileRetryMs = 1;
        server.pendingStartDisconnects = new Map([[old, { clientId: old.clientId, connectionId: old.id, nodeId: 1, metadata: {} }]]);
        server.pendingStartDisconnectFenceDeadlines = new Map([[old, Date.now()]]);
        server.pendingStartDisconnectCallbackQueued = new WeakSet();
        server.rollbackGatedDisconnects = new WeakSet();
        server.clientRegistryChains = new Map();
        server.clientCallbackChains = new Map();
        server.pendingStreamsByClientId = new Map();
        server.streamsByClientId = new Map([[other.clientId, other]]);
        server.streamsById = new Map([[other.id, other]]);
        server.lifecycleConnectedStreams = new Set([other]);
        server.clientRegistryMetadata = new Map([[other.clientId, other.meta]]);
        server.isCurrentStream = (stream: unknown) => stream === other;
        server.disconnectedCallbacks = [
            async (clientId: string) => {
                if (clientId === other.clientId) otherDisconnects++;
            }
        ];
        server.meshLogger = { warn: () => {} };
        server.meshClientService = {
            instanceId: 1,
            clientRegistry: {
                getClient: async (clientId: string) =>
                    clientId === old.clientId ? { clientId: old.clientId, nodeId: 1, connectionId: old.id } : undefined
            },
            fenceForShutdown: () => admissionFences++,
            stop: async () => {
                serviceStops++;
                await serviceStopBlocked;
            }
        };
        server.disconnectAllMeshStreams = () => deliveryDisconnects++;
        server.releaseMeshLinkResources = async () => linkReleases++;

        server.queuePendingStartDisconnectCallback(old, server.pendingStartDisconnects.get(old), Date.now());
        await Promise.all([...server.clientCallbackChains.values()]);
        await waitFor(() => serviceStops === 1);
        const joinedStop = server.meshStop();
        let joined = false;
        void joinedStop.then(() => (joined = true));
        await Promise.resolve();
        assert.equal(joined, false);
        releaseServiceStop();
        await joinedStop;
        await Promise.all([...server.clientCallbackChains.values()]);

        assert.equal(admissionFences, 1);
        assert.equal(deliveryDisconnects, 1);
        assert.equal(linkReleases, 1);
        assert.equal(otherDisconnects, 1);
        assert.equal(server.meshRunning, false);
        assert.match(server.meshCleanupFailure.message, /exact old generation is still registered/);
        await assert.rejects(server.meshStart(), error => error === server.meshCleanupFailure);
    });

    it('does not let a deferred disconnect callback block global restart work while preserving same-client order', async () => {
        const old = { id: 'connection-old', clientId: 'client-1', meta: { role: 'old' } };
        let sameClientFollowup = false;
        let otherClientWork = false;
        const server = Object.create(MeshSrpcServer.prototype) as any;
        server.meshLogger = { warn: () => {} };
        server.pendingStartDisconnects = new Map([[old, { clientId: old.clientId, connectionId: old.id, nodeId: 1, metadata: { role: 'old' } }]]);
        server.clientCallbackChains = new Map();
        server.disconnectedCallbacks = [async () => new Promise<void>(() => {})];
        server.meshClientService = { clientRegistry: { getClient: async () => undefined } };

        await server.dispatchPendingStartDisconnects();
        void server.enqueueClientCallback(old.clientId, async () => {
            sameClientFollowup = true;
        });
        await server.enqueueClientCallback('other-client', async () => {
            otherClientWork = true;
        });

        assert.equal(sameClientFollowup, false);
        assert.equal(otherClientWork, true);
    });

    it('routes public resolution through the mesh generation fence', async () => {
        const stale = { id: 'connection-1', clientId: 'client-1', meta: { role: 'stale' } };
        const current = { id: 'connection-2', clientId: 'client-1', meta: { role: 'current' } };
        const server = Object.create(MeshSrpcServer.prototype) as any;
        server.streamsByClientId = new Map([[stale.clientId, stale]]);
        server.meshLinkController = {
            resolveClient: async (clientId: string) => {
                assert.equal(clientId, stale.clientId);
                return current;
            }
        };

        assert.strictEqual(await server.resolveClient(stale.clientId), current);
    });

    it('projects owner metadata after applying full-stream updates', () => {
        const server = Object.create(MeshSrpcServer.prototype) as any;
        server.extractRegistryMetadataFn = (stream: { meta: FullClientMeta }) => ({ role: stream.meta.role });
        const stream = { meta: { role: 'before', secret: 'local-only' } };

        const projected = server.applyMetadataToLocalStream(stream, { role: 'after' });

        assert.deepEqual(projected, { role: 'after' });
        assert.deepEqual(stream.meta, { role: 'after', secret: 'local-only' });
        server.extractRegistryMetadataFn = (candidate: { meta: FullClientMeta }) => candidate.meta.role;
        assert.equal(server.applyMetadataToLocalStream(stream, { role: 'primitive' }), 'primitive');
    });

    it('preserves an existing undefined projection when a fenced metadata update is rejected', async () => {
        const stream = { id: 'connection-1', clientId: 'client-1', meta: { role: 'before', secret: 'local-only' } };
        const server = Object.create(MeshSrpcServer.prototype) as any;
        server.streamsByClientId = new Map([[stream.clientId, stream]]);
        server.clientRegistryMetadata = new Map([[stream.clientId, undefined]]);
        server.extractRegistryMetadataFn = () => undefined;
        server.meshClientService = { clientRegistry: { updateMetadata: async () => false } };

        await assert.rejects(server.updateClientMetadata(stream, { role: 'after' }), SrpcStaleConnectionError);
        assert.equal(server.clientRegistryMetadata.has(stream.clientId), true);
        assert.equal(server.clientRegistryMetadata.get(stream.clientId), undefined);
    });

    it('keeps failed metadata sync dirty and retries before updating the cache', async () => {
        const stream = {
            id: 'connection-1',
            clientId: 'client-1',
            meta: { role: 'after' },
            lastPingAt: 1
        };
        let attempts = 0;
        const server = Object.create(MeshSrpcServer.prototype) as any;
        server.streamsByClientId = new Map([[stream.clientId, stream]]);
        server.pendingStreamsByClientId = new Map();
        server.clientRegistryMetadata = new Map([[stream.clientId, { role: 'before' }]]);
        server.clientRegistryChains = new Map();
        server.meshLinkRequestTimeoutMs = 20;
        server.meshLogger = { warn: () => {} };
        server.extractRegistryMetadataFn = (clientStream: { meta: SrpcMeta }) => ({ ...clientStream.meta });
        server.meshClientService = {
            isRunning: true,
            clientRegistry: {
                updateMetadata: async () => {
                    attempts++;
                    return attempts > 1;
                }
            }
        };

        server.syncStreamMeta(stream);
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(attempts, 1);
        assert.deepEqual(server.clientRegistryMetadata.get(stream.clientId), { role: 'before' });
        await waitFor(() => attempts === 2);
        await waitFor(() => server.clientRegistryMetadata.get(stream.clientId)?.role === 'after');
    });

    it('uses mesh metadata delivery before a direct handle exists, but never after direct delivery starts', async () => {
        const server = Object.create(MeshSrpcServer.prototype) as any;
        const fallback = { updateClientMetadata: async () => true };
        server.meshClientService = fallback;
        server.meshLinkController = undefined;

        assert.equal(await server.updateClientMetadata('client-1', { role: 'fallback' }), true);

        let fallbackCalls = 0;
        server.meshClientService = {
            updateClientMetadata: async () => {
                fallbackCalls++;
                return true;
            }
        };
        server.meshLogger = { debug: () => {} };
        server.meshLinkController = {};
        server.resolveClient = async () => {
            throw new MeshLinkCapabilityError('owner does not support direct links');
        };
        await assert.rejects(server.updateClientMetadata('client-1', { role: 'fallback-owner' }), MeshLinkCapabilityError);
        assert.equal(fallbackCalls, 0);
        fallbackCalls = 0;
        server.meshLinkController = {
            updateMetadata: async () => {
                throw new Error('direct delivery was indeterminate');
            }
        };
        const connection = new MeshRemoteSrpcConnection({
            id: 'connection-1',
            clientId: 'client-1',
            meta: { role: 'remote' },
            connectedAt: Date.now(),
            ownerNodeId: 2,
            senderIds: [],
            transport: {
                reserveSenderIds: async () => [],
                disconnect: async () => {},
                writeStream: async () => {},
                finishStream: async () => {},
                destroyStream: async () => {},
                attachReceiver: async () => {}
            }
        });

        await assert.rejects(server.updateClientMetadata(connection, { role: 'direct' }), /indeterminate/);
        assert.equal(fallbackCalls, 0);
    });

    it('keeps a shared runtime alive when a sibling server fails after route acquisition', async () => {
        const httpServer = await listen();
        const shared = runtime(httpServer);
        const unregisterHealthy = shared.register('healthy-route', async () => ({ header: { type: 'result' }, body: Buffer.alloc(0) }));
        const failing = Object.create(MeshSrpcServer.prototype) as any;
        failing.meshRunning = false;
        failing.meshClosed = false;
        failing.meshStartGeneration = 0;
        failing.meshMessageSecurityResolved = false;
        failing.meshLogger = { warn: () => {}, debug: () => {} };
        failing.clientRegistryMetadata = new Map([['backfill-client', { role: 'backfill' }]]);
        const backfillStream = {
            id: 'backfill-connection',
            clientId: 'backfill-client',
            isActivated: true,
            protocolVersion: 2,
            supersede: true,
            lastPingAt: 1,
            meta: { role: 'backfill' }
        };
        failing.pendingStreamsByClientId = new Map();
        failing.streamsByClientId = new Map([[backfillStream.clientId, backfillStream]]);
        failing.clientRegistryChains = new Map();
        failing.clientCallbackChains = new Map();
        failing.disconnectAllMeshStreams = () => {};
        failing.options = { httpServer };
        failing.resolveMeshLinkConfig = () => ({
            path,
            secret,
            httpServer,
            connectTimeoutMs: 1_000,
            idleTimeoutMs: 10_000,
            maxFrameBytes: 1024 * 1024,
            maxBufferedBytes: 1024 * 1024,
            requestTimeoutMs: 1_000
        });
        failing.createMeshLinkController = () => ({ close: () => {}, route: async () => ({ header: { type: 'result' }, body: Buffer.alloc(0) }) });
        let startAttempts = 0;
        let backfillAttempts = 0;
        failing.meshClientService = {
            mesh: {
                updateNodeMetadata: async () => {}
            },
            setRemoteTransport: () => {},
            start: async () => {
                startAttempts++;
                if (startAttempts === 1) throw new Error('startup failed');
            },
            stop: async () => {},
            registerClient: async () => {
                backfillAttempts++;
                if (backfillAttempts === 1) throw new Error('backfill failed');
                return true;
            },
            instanceId: 1
        };

        const start = failing.meshStart();
        const stop = failing.meshStop();
        await assert.rejects(start, /startup was cancelled/);
        await stop;
        await assert.rejects(failing.meshStart(), /startup failed/);
        await assert.rejects(failing.meshStart(), /backfill failed/);
        await failing.meshStart();
        assert.equal(backfillAttempts, 2);
        failing.streamsByClientId.clear();
        await failing.meshStop();

        const preconfigured = Object.create(MeshSrpcServer.prototype) as any;
        preconfigured.meshRunning = false;
        preconfigured.meshClosed = false;
        preconfigured.clientRegistryMetadata = new Map();
        preconfigured.pendingStreamsByClientId = new Map();
        preconfigured.streamsByClientId = new Map();
        preconfigured.clientRegistryChains = new Map();
        preconfigured.clientCallbackChains = new Map();
        preconfigured.options = { httpServer };
        preconfigured.resolveMeshLinkConfig = failing.resolveMeshLinkConfig;
        preconfigured.createMeshLinkController = failing.createMeshLinkController;
        preconfigured.meshClientService = {
            mesh: {
                updateNodeMetadata: async () => {}
            },
            setRemoteTransport: () => {},
            start: async () => {},
            stop: async () => {},
            instanceId: 1
        };
        await preconfigured.meshStart();
        await preconfigured.meshStop();

        const unregisterAfterFailure = shared.register('still-healthy', async () => ({ header: { type: 'result' }, body: Buffer.alloc(0) }));
        unregisterAfterFailure();
        unregisterHealthy();
    });

    it('joins concurrent mesh stops and cleans up a server that is already running', async () => {
        const server = Object.create(MeshSrpcServer.prototype) as any;
        let stops = 0;
        let releaseStop: (() => void) | undefined;
        const stopped = new Promise<void>(resolve => {
            releaseStop = resolve;
        });
        server.meshRunning = true;
        server.meshStopping = false;
        server.clientRegistryMetadata = new Map();
        server.meshClientService = {
            setRemoteTransport: () => {},
            stop: async () => {
                stops++;
                await stopped;
            }
        };
        server.meshLinkController = { close: () => {} };

        const first = server.meshStop();
        const second = server.meshStop();
        releaseStop!();
        await Promise.all([first, second]);
        assert.equal(stops, 1);
        assert.equal(server.meshRunning, false);
    });

    it('queues a start requested while an in-flight startup is already scheduled to stop', async () => {
        const server = Object.create(MeshSrpcServer.prototype) as any;
        let starts = 0;
        let stops = 0;
        let releaseFirstStart: (() => void) | undefined;
        const firstStartBlocked = new Promise<void>(resolve => {
            releaseFirstStart = resolve;
        });
        server.meshRunning = false;
        server.meshStopping = false;
        server.meshClosed = false;
        server.clientRegistryMetadata = new Map();
        server.startMesh = async () => {
            starts++;
            if (starts === 1) await firstStartBlocked;
            server.meshRunning = true;
        };
        server.meshClientService = {
            setRemoteTransport: () => {},
            stop: async () => {
                stops++;
            }
        };

        const firstStart = server.meshStart();
        const stop = server.meshStop();
        const queuedStart = server.meshStart();
        releaseFirstStart!();
        await Promise.all([firstStart, stop, queuedStart]);

        assert.equal(starts, 2);
        assert.equal(stops, 1);
        assert.equal(server.meshRunning, true);
    });

    it('uses one transparent remote handle for unary calls and byte streams', async () => {
        const firstServer = await listen();
        const secondServer = await listen();
        const firstRuntime = runtime(firstServer);
        const secondRuntime = runtime(secondServer);
        const record: RegisteredClient<SrpcMeta> = {
            clientId: 'client-1',
            nodeId: 2,
            connectionId: 'connection-1',
            processId: getMeshLinkProcessId(),
            connectedAt: Date.now(),
            metadata: { role: 'endpoint' }
        };
        const records = new Map([[record.clientId, record]]);
        const nodes = new Map([
            [
                1,
                {
                    instanceId: 1,
                    hostname: 'first',
                    self: true,
                    processId: getMeshLinkProcessId(),
                    linkEndpointId: firstRuntime.id,
                    linkEndpointPublicKey: firstRuntime.publicKey,
                    linkUrl: url(firstServer)
                }
            ],
            [
                2,
                {
                    instanceId: 2,
                    hostname: 'second',
                    self: false,
                    processId: getMeshLinkProcessId(),
                    linkEndpointId: secondRuntime.id,
                    linkEndpointPublicKey: secondRuntime.publicKey,
                    linkUrl: url(secondServer)
                }
            ]
        ]);
        const ownerStream = { id: record.connectionId, clientId: record.clientId } as any;
        const ownerByteParent = createByteParent(record.connectionId!);
        const writes: Buffer[] = [];
        let finishedStreamId: number | undefined;
        const directInvocations: { type: string; data: unknown; timeoutMs: number }[] = [];
        let nextId = 2;

        const first = new MeshSrpcLinkController<SrpcMeta, SrpcMeta>({
            meshKey: 'controller-test',
            requestTimeoutMs: 2_000,
            runtime: firstRuntime,
            service: fakeService(1, records, nodes),
            getLocalConnection: () => undefined,
            invokeLocal: async () => {
                throw new Error('not local');
            },
            reserveLocalSenderIds: () => [],
            writeLocalStream: async () => {},
            finishLocalStream: async () => {},
            destroyLocalStream: async () => {},
            attachLocalReceiver: () => {
                throw new Error('not local');
            },
            disconnectLocal: async () => {},
            updateLocalMetadata: async () => {}
        });
        const second = new MeshSrpcLinkController<SrpcMeta, SrpcMeta>({
            meshKey: 'controller-test',
            requestTimeoutMs: 2_000,
            runtime: secondRuntime,
            service: fakeService(2, records, nodes),
            getLocalConnection: clientId => (clientId === record.clientId ? ownerStream : undefined),
            invokeLocal: async (_clientId, _connectionId, _prefix, data) => ({
                body: Buffer.from(data).reverse(),
                issuedSenderIds: [9, 11]
            }),
            serviceInvokeLocal: async (_clientId, _connectionId, type, data, timeoutMs) => {
                directInvocations.push({ type, data, timeoutMs });
                return { delivered: true };
            },
            reserveLocalSenderIds: (_clientId, _connectionId, count) =>
                Array.from({ length: count }, () => {
                    const id = nextId;
                    nextId += 2;
                    return id;
                }),
            writeLocalStream: async (_clientId, _connectionId, _streamId, data) => {
                writes.push(Buffer.from(data));
            },
            finishLocalStream: async (_clientId, _connectionId, streamId) => {
                finishedStreamId = streamId;
            },
            destroyLocalStream: async () => {},
            attachLocalReceiver: (_clientId, _connectionId, streamId) => SrpcByteStream.createReceiver(ownerByteParent, streamId),
            disconnectLocal: async () => {
                records.delete(record.clientId);
            },
            updateLocalMetadata: async (_clientId, _connectionId, metadata) => {
                record.metadata = metadata;
            }
        });
        firstRuntime.register('controller-test', (peer, frame) => first.route(peer, frame));
        secondRuntime.register('controller-test', (peer, frame) => second.route(peer, frame));

        assert.deepEqual(
            await first.invokeClient(2, {
                clientId: record.clientId,
                connectionId: record.connectionId,
                type: 'notify',
                data: { source: 'direct-link' },
                timeoutMs: 2_000
            }),
            { delivered: true }
        );
        assert.equal(directInvocations.length, 1);
        assert.equal(directInvocations[0].type, 'notify');
        assert.deepEqual(directInvocations[0].data, { source: 'direct-link' });
        assert.equal(
            await first.updateClientMetadata(2, {
                clientId: record.clientId,
                connectionId: record.connectionId,
                metadata: { role: 'updated' }
            }),
            true
        );
        assert.deepEqual(record.metadata, { role: 'updated' });

        const connections = await Promise.all(Array.from({ length: 8 }, () => first.resolveClient(record.clientId)));
        const connection = connections[0];
        assert.ok(connection);
        for (const candidate of connections) assert.strictEqual(candidate, connection);
        assert.equal(connection.id, record.connectionId);
        assert.deepEqual(connection.meta, { role: 'updated' });
        assert.equal((second as any).senderRoutes.size, 32);

        const response = await first.invoke(connection, 'dBinary', Buffer.from([0, 1, 2, 255]), 2_000);
        assert.deepEqual(response, Buffer.from([255, 2, 1, 0]));

        const sender = SrpcByteStream.createSender(connection);
        sender.end(Buffer.from('remote sender'));
        await finished(sender, { readable: false });
        assert.deepEqual(writes, [Buffer.from('remote sender')]);
        assert.equal(finishedStreamId, sender.id);

        const received: Buffer[] = [];
        const receiver = SrpcByteStream.createReceiver(connection, 9);
        receiver.on('data', chunk => received.push(Buffer.from(chunk)));
        await waitFor(() => SrpcByteStream.hasReceiver(ownerByteParent, 9));
        SrpcByteStream.writeReceiver(ownerByteParent, 9, Buffer.from('client data'));
        SrpcByteStream.finishReceiver(ownerByteParent, 9);
        await finished(receiver, { writable: false });
        assert.deepEqual(received, [Buffer.from('client data')]);

        const destroyedReceiver = SrpcByteStream.createReceiver(connection, 11);
        const destroyed = new Promise<void>(resolve => destroyedReceiver.once('close', resolve));
        await waitFor(() => SrpcByteStream.hasReceiver(ownerByteParent, 11));
        SrpcByteStream.destroySubstream(ownerByteParent, 11);
        await destroyed;

        const idleSender = SrpcByteStream.createSender(connection);
        const idleSenderClosed = new Promise<void>(resolve => idleSender.once('close', resolve));
        await waitFor(() => (second as any).senderRoutes.get(`${record.connectionId}:${idleSender.id}`)?.active === true);
        const capability = (connection as MeshRemoteSrpcConnection<SrpcMeta>).capability!;
        const ownerHandle = (second as any).handleCapabilities.get(capability);
        assert.ok(ownerHandle);
        ownerHandle.expiresAt = 0;
        (second as any).pruneReservations();
        assert.ok((second as any).handleCapabilities.get(capability)?.expiresAt > Date.now());
        assert.equal(connection.connected, true);

        second.invalidateConnection(record.clientId, record.connectionId!);
        await idleSenderClosed;
        await waitFor(() => !connection.connected && (second as any).terminalForwards.size === 0);
        assert.equal(idleSender.destroyed, true);
        assert.equal((connection as any).disconnectHandlers.size, 0);
        assert.equal((first as any).remoteConnections.size, 0);
        assert.equal((second as any).handleCapabilities.has(capability), false);
        assert.equal((second as any).senderRoutes.size, 0);

        secondRuntime.close();
        await assert.rejects(first.invoke(connection, 'dBinary', Buffer.from('stale'), 2_000), SrpcStaleConnectionError);
        assert.equal(connection.connected, false);
    });

    it('revokes an expired unused capability over the authenticated controller transport', async () => {
        const requesterServer = await listen();
        const ownerServer = await listen();
        const requesterRuntime = runtime(requesterServer);
        const ownerRuntime = runtime(ownerServer);
        const record: RegisteredClient<SrpcMeta> = {
            clientId: 'expiry-client',
            nodeId: 2,
            connectionId: 'expiry-connection',
            processId: getMeshLinkProcessId(),
            connectedAt: Date.now(),
            metadata: { role: 'expiry' }
        };
        const records = new Map([[record.clientId, record]]);
        const nodes = new Map([
            [
                1,
                {
                    instanceId: 1,
                    hostname: 'requester',
                    self: true,
                    processId: getMeshLinkProcessId(),
                    linkEndpointId: requesterRuntime.id,
                    linkEndpointPublicKey: requesterRuntime.publicKey,
                    linkUrl: url(requesterServer)
                }
            ],
            [
                2,
                {
                    instanceId: 2,
                    hostname: 'owner',
                    self: false,
                    processId: getMeshLinkProcessId(),
                    linkEndpointId: ownerRuntime.id,
                    linkEndpointPublicKey: ownerRuntime.publicKey,
                    linkUrl: url(ownerServer)
                }
            ]
        ]);
        let nextId = 2;
        const requester = new MeshSrpcLinkController<SrpcMeta, SrpcMeta>({
            meshKey: 'capability-expiry-transport',
            requestTimeoutMs: 2_000,
            runtime: requesterRuntime,
            service: fakeService(1, records, nodes),
            getLocalConnection: () => undefined,
            invokeLocal: async () => Buffer.alloc(0),
            reserveLocalSenderIds: () => [],
            writeLocalStream: async () => {},
            finishLocalStream: async () => {},
            destroyLocalStream: async () => {},
            attachLocalReceiver: () => {
                throw new Error('not local');
            },
            disconnectLocal: async () => {},
            updateLocalMetadata: async () => {}
        });
        const owner = new MeshSrpcLinkController<SrpcMeta, SrpcMeta>({
            meshKey: 'capability-expiry-transport',
            requestTimeoutMs: 2_000,
            runtime: ownerRuntime,
            service: fakeService(2, records, nodes),
            getLocalConnection: clientId =>
                clientId === record.clientId ? ({ id: record.connectionId, clientId: record.clientId } as any) : undefined,
            invokeLocal: async () => Buffer.alloc(0),
            reserveLocalSenderIds: (_clientId, _connectionId, count) =>
                Array.from({ length: count }, () => {
                    const id = nextId;
                    nextId += 2;
                    return id;
                }),
            writeLocalStream: async () => {},
            finishLocalStream: async () => {},
            destroyLocalStream: async () => {},
            attachLocalReceiver: () => {
                throw new Error('not needed');
            },
            disconnectLocal: async () => {},
            updateLocalMetadata: async () => {}
        });
        requesterRuntime.register('capability-expiry-transport', (peer, frame) => requester.route(peer, frame));
        ownerRuntime.register('capability-expiry-transport', (peer, frame) => owner.route(peer, frame));

        const connection = (await requester.resolveClient(record.clientId)) as MeshRemoteSrpcConnection<SrpcMeta>;
        const capability = connection.capability!;
        assert.equal((owner as any).senderRoutes.size, 32);
        (owner as any).handleCapabilities.get(capability).expiresAt = 0;
        (owner as any).pruneReservations();

        await waitFor(() => !connection.connected && (owner as any).terminalForwards.size === 0);
        assert.equal((requester as any).remoteConnections.size, 0);
        assert.equal((requester as any).endpointPinUnregisters.size, 0);
        assert.equal((owner as any).handleCapabilities.size, 0);
        assert.equal((owner as any).senderRoutes.size, 0);
        assert.ok((requester as any).revokedRemoteCapabilities.size <= 8_192);

        await Promise.all([requester.close(), owner.close()]);
    });

    it('removes sender routes after normally finished remote streams', async () => {
        const owner = { id: 'connection-1', clientId: 'client-1' } as any;
        let nextId = 2;
        let destructiveDestroys = 0;
        const controller = new MeshSrpcLinkController<SrpcMeta, SrpcMeta>({
            meshKey: 'route-cleanup',
            requestTimeoutMs: 1_000,
            runtime: { onPeerClosed: () => () => {} } as any,
            service: {
                mesh: { getNodes: async () => [{ processId: 'remote-peer', linkEndpointId: 'remote-endpoint' }] }
            } as any,
            getLocalConnection: () => owner,
            invokeLocal: async () => Buffer.alloc(0),
            reserveLocalSenderIds: (_clientId, _connectionId, count) =>
                Array.from({ length: count }, () => {
                    const id = nextId;
                    nextId += 2;
                    return id;
                }),
            writeLocalStream: async () => {},
            finishLocalStream: async () => {},
            destroyLocalStream: async () => {
                destructiveDestroys++;
            },
            attachLocalReceiver: () => {
                throw new Error('not needed');
            },
            disconnectLocal: async () => {},
            updateLocalMetadata: async () => {}
        });
        const peer = { processId: 'remote-peer', endpointId: 'remote-endpoint', protocolVersion: 2, connected: true } as any;

        for (let round = 0; round < 3; round++) {
            const reservationId = `route-cleanup-reservation-${round}`;
            const reservation = await controller.route(peer, {
                header: {
                    type: 'reserveStreamIds',
                    version: 2,
                    clientId: owner.clientId,
                    connectionId: owner.id,
                    count: 4,
                    reservationId
                },
                body: Buffer.alloc(0)
            });
            const capability = reservation.header.capability!;
            await controller.route(peer, {
                header: {
                    type: 'confirmStreamIds',
                    version: 2,
                    clientId: owner.clientId,
                    connectionId: owner.id,
                    reservationId,
                    capability
                },
                body: Buffer.alloc(0)
            });
            for (const streamId of reservation.header.ids ?? []) {
                assert.equal(controller.hasSenderRoute(owner.id, streamId), true);
                await controller.route(peer, {
                    header: { type: 'streamFinish', version: 2, clientId: owner.clientId, connectionId: owner.id, streamId, capability },
                    body: Buffer.alloc(0)
                });
                // A receiver may auto-destroy after observing the terminal
                // finish. The bounded terminal marker authenticates and
                // consumes that late destroy without touching the live client.
                assert.equal(controller.hasSenderRoute(owner.id, streamId), true);
                await controller.route(peer, {
                    header: { type: 'streamDestroy', version: 2, clientId: owner.clientId, connectionId: owner.id, streamId, capability },
                    body: Buffer.alloc(0)
                });
                assert.equal(controller.hasSenderRoute(owner.id, streamId), false);
            }
        }

        assert.equal((controller as any).senderRoutes.size, 0);
        assert.equal(destructiveDestroys, 0);
        await controller.close();
    });

    it('retries terminal forwards until the exact peer acknowledges them', async () => {
        let attempts = 0;
        let peerCloses = 0;
        const controller = new MeshSrpcLinkController<SrpcMeta, SrpcMeta>({
            meshKey: 'terminal-retry',
            requestTimeoutMs: 1_000,
            runtime: {
                onPeerClosed: () => () => {},
                requestPeer: async () => {
                    attempts++;
                    if (attempts === 1) throw new Error('temporary terminal failure');
                    return { header: { type: 'result' }, body: Buffer.alloc(0) };
                },
                closePeer: () => {
                    peerCloses++;
                }
            } as any,
            service: { mesh: {} } as any,
            getLocalConnection: () => undefined,
            invokeLocal: async () => Buffer.alloc(0),
            reserveLocalSenderIds: () => [],
            writeLocalStream: async () => {},
            finishLocalStream: async () => {},
            destroyLocalStream: async () => {},
            attachLocalReceiver: () => {
                throw new Error('not needed');
            },
            disconnectLocal: async () => {},
            updateLocalMetadata: async () => {}
        });

        (controller as any).queueTerminalForward(
            'owner-process',
            'owner-endpoint',
            'owner-public-key',
            {
                type: 'streamFinish',
                meshKey: 'terminal-retry',
                clientId: 'client-1',
                connectionId: 'connection-1',
                streamId: 9,
                capability: 'terminal-capability-000000000001'
            },
            new Uint8Array()
        );
        await waitFor(() => {
            const terminal = [...(controller as any).terminalForwards.values()][0];
            return attempts === 1 && (controller as any).terminalForwards.size === 1 && !terminal?.retrying;
        });
        await (controller as any).retryTerminalForwards(true);

        assert.equal(attempts, 2);
        assert.equal((controller as any).terminalForwards.size, 0);
        assert.equal(peerCloses, 0);
        await controller.close();
    });

    it('retains independent retries for exact capability revocations on one connection', async () => {
        const attempts = new Map<string, number>();
        const controller = new MeshSrpcLinkController<SrpcMeta, SrpcMeta>({
            meshKey: 'terminal-revoke-identity',
            requestTimeoutMs: 1_000,
            runtime: {
                onPeerClosed: () => () => {},
                requestPeer: async (_processId: string, _endpointId: string, header: { capability: string }) => {
                    const count = (attempts.get(header.capability) ?? 0) + 1;
                    attempts.set(header.capability, count);
                    if (count === 1) throw new Error('temporary revocation failure');
                    return { header: { type: 'result' }, body: Buffer.alloc(0) };
                }
            } as any,
            service: { mesh: {} } as any,
            getLocalConnection: () => undefined,
            invokeLocal: async () => Buffer.alloc(0),
            reserveLocalSenderIds: () => [],
            writeLocalStream: async () => {},
            finishLocalStream: async () => {},
            destroyLocalStream: async () => {},
            attachLocalReceiver: () => {
                throw new Error('not needed');
            },
            disconnectLocal: async () => {},
            updateLocalMetadata: async () => {}
        });
        const capabilities = ['revocation-capability-000000000001', 'revocation-capability-000000000002'];
        for (const capability of capabilities) {
            (controller as any).queueTerminalForward(
                'same-process',
                'same-endpoint',
                'same-public-key',
                {
                    type: 'revokeCapability',
                    meshKey: 'terminal-revoke-identity',
                    clientId: 'same-client',
                    connectionId: 'same-connection',
                    capability
                },
                new Uint8Array()
            );
        }
        await waitFor(
            () =>
                capabilities.every(capability => attempts.get(capability) === 1) &&
                (controller as any).terminalForwards.size === 2 &&
                [...(controller as any).terminalForwards.values()].every((terminal: any) => !terminal.retrying)
        );

        await (controller as any).retryTerminalForwards(true);

        assert.deepEqual(
            capabilities.map(capability => attempts.get(capability)),
            [2, 2]
        );
        assert.equal((controller as any).terminalForwards.size, 0);
        await controller.close();
    });

    it('rechecks lease safety after awaited membership before local side effects', async () => {
        let leaseSafe = true;
        let allocations = 0;
        const controller = new MeshSrpcLinkController<SrpcMeta, SrpcMeta>({
            meshKey: 'lease-recheck',
            requestTimeoutMs: 1_000,
            runtime: { onPeerClosed: () => () => {} } as any,
            service: {
                mesh: {
                    assertLeaseSafe: () => {
                        if (!leaseSafe) throw new Error('lease fenced');
                    },
                    getNodes: async () => {
                        leaseSafe = false;
                        return [{ processId: 'remote-process' }];
                    }
                }
            } as any,
            getLocalConnection: () => ({ id: 'connection-1', clientId: 'client-1' }) as any,
            invokeLocal: async () => Buffer.alloc(0),
            reserveLocalSenderIds: () => {
                allocations++;
                return [2];
            },
            writeLocalStream: async () => {},
            finishLocalStream: async () => {},
            destroyLocalStream: async () => {},
            attachLocalReceiver: () => {
                throw new Error('not needed');
            },
            disconnectLocal: async () => {},
            updateLocalMetadata: async () => {}
        });

        await assert.rejects(
            controller.route({ processId: 'remote-process', connected: true } as any, {
                header: {
                    type: 'reserveStreamIds',
                    clientId: 'client-1',
                    connectionId: 'connection-1',
                    count: 1
                },
                body: Buffer.alloc(0)
            }),
            /lease fenced/
        );
        assert.equal(allocations, 0);
        await controller.close();
    });

    it('bounds registry resolution with the caller absolute deadline', async () => {
        const controller = new MeshSrpcLinkController<SrpcMeta, SrpcMeta>({
            meshKey: 'resolution-deadline',
            requestTimeoutMs: 1_000,
            runtime: { onPeerClosed: () => () => {} } as any,
            service: {
                clientRegistry: { getClient: () => new Promise(() => {}) },
                mesh: {}
            } as any,
            getLocalConnection: () => undefined,
            invokeLocal: async () => Buffer.alloc(0),
            reserveLocalSenderIds: () => [],
            writeLocalStream: async () => {},
            finishLocalStream: async () => {},
            destroyLocalStream: async () => {},
            attachLocalReceiver: () => {
                throw new Error('not needed');
            },
            disconnectLocal: async () => {},
            updateLocalMetadata: async () => {}
        });

        await assert.rejects(controller.resolveClient('client-1', Date.now() + 10), SrpcOwnerUnavailableError);
        await controller.close();
    });

    it('retains a cold-resolution endpoint pin, then releases it after its last obligation', async () => {
        let unregisters = 0;
        const runtimePins = new Set<string>();
        const controller = new MeshSrpcLinkController<SrpcMeta, SrpcMeta>({
            meshKey: 'pin-resolution-lifetime',
            requestTimeoutMs: 1_000,
            runtime: {
                onPeerClosed: () => () => {},
                pinEndpoint: (endpointId: string) => {
                    runtimePins.add(endpointId);
                    return () => {
                        runtimePins.delete(endpointId);
                        unregisters++;
                    };
                }
            } as any,
            service: { mesh: {} } as any,
            getLocalConnection: () => undefined,
            invokeLocal: async () => Buffer.alloc(0),
            reserveLocalSenderIds: () => [],
            writeLocalStream: async () => {},
            finishLocalStream: async () => {},
            destroyLocalStream: async () => {},
            attachLocalReceiver: () => {
                throw new Error('not needed');
            },
            disconnectLocal: async () => {},
            updateLocalMetadata: async () => {}
        });
        const mutable = controller as any;
        mutable.pinNode({ linkEndpointId: 'cold-endpoint', linkEndpointPublicKey: 'key' });
        mutable.resolvingRemoteConnections.set('cold', { clientId: 'client', connectionId: 'connection', endpointId: 'cold-endpoint' });
        mutable.pruneEndpointPins();
        assert.equal(unregisters, 0);
        mutable.resolvingRemoteConnections.clear();
        mutable.pruneEndpointPins();
        assert.equal(unregisters, 1);
        mutable.pinNode({ linkEndpointId: 'terminal-endpoint', linkEndpointPublicKey: 'key' });
        mutable.terminalForwards.set('terminal', {
            processId: 'process',
            endpointId: 'terminal-endpoint',
            expiresAt: Date.now() + 1_000,
            attempts: 0,
            nextRetryAt: 0,
            header: { type: 'streamDestroy' },
            body: Buffer.alloc(0)
        });
        mutable.pruneEndpointPins();
        assert.equal(unregisters, 1);
        mutable.terminalForwards.clear();
        mutable.pruneEndpointPins();
        assert.equal(unregisters, 2);
        for (let index = 0; index < 8_193; index++) {
            mutable.pinNode({ linkEndpointId: `churn-${index}`, linkEndpointPublicKey: `key-${index}` });
        }
        assert.ok(mutable.endpointPinUnregisters.size <= 8_192);
        assert.equal(runtimePins.size, mutable.endpointPinUnregisters.size);
        await controller.close();
    });

    it('caps a skewed authenticated owner deadline by the receive-time relative residual', async () => {
        const peer = { processId: 'deadline-peer', endpointId: 'deadline-endpoint', protocolVersion: 2, connected: true } as any;
        const local = { id: 'connection', clientId: 'client' } as any;
        let invokes = 0;
        const controller = new MeshSrpcLinkController<SrpcMeta, SrpcMeta>({
            meshKey: 'owner-deadline',
            requestTimeoutMs: 1_000,
            runtime: { onPeerClosed: () => () => {} } as any,
            service: {
                mesh: {
                    getNodes: async () => {
                        await new Promise(resolve => setTimeout(resolve, 10));
                        return [{ processId: peer.processId, linkEndpointId: peer.endpointId }];
                    }
                }
            } as any,
            getLocalConnection: () => local,
            invokeLocal: async () => {
                invokes++;
                return Buffer.alloc(0);
            },
            reserveLocalSenderIds: () => [],
            writeLocalStream: async () => {},
            finishLocalStream: async () => {},
            destroyLocalStream: async () => {},
            attachLocalReceiver: () => {
                throw new Error('not needed');
            },
            disconnectLocal: async () => {},
            updateLocalMetadata: async () => {}
        });
        const capability = 'owner-deadline-capability-00000001';
        (controller as any).handleCapabilities.set(capability, {
            clientId: 'client',
            connectionId: 'connection',
            capability,
            peerIdentity: peer.endpointId,
            peerProcessId: peer.processId,
            peerEndpointId: peer.endpointId
        });
        await assert.rejects(
            controller.route(peer, {
                header: {
                    type: 'invoke',
                    version: 2,
                    clientId: 'client',
                    connectionId: 'connection',
                    prefix: 'dRead',
                    capability,
                    timeoutMs: 5,
                    deadlineAt: Date.now() + 60_000
                },
                body: Buffer.alloc(0)
            }),
            SrpcOwnerUnavailableError
        );
        assert.equal(invokes, 0);
        await controller.close();
    });

    it('accepts positive direct residual budgets from owner clocks ahead and behind without extending them', async () => {
        const peer = { processId: 'skew-peer', endpointId: 'skew-endpoint', protocolVersion: 2, connected: true } as any;
        const local = { id: 'connection', clientId: 'client' } as any;
        const observed: number[] = [];
        const controller = new MeshSrpcLinkController<SrpcMeta, SrpcMeta>({
            meshKey: 'foreign-owner-clock',
            requestTimeoutMs: 1_000,
            runtime: { onPeerClosed: () => () => {} } as any,
            service: {
                mesh: { getNodes: async () => [{ processId: peer.processId, linkEndpointId: peer.endpointId }] }
            } as any,
            getLocalConnection: () => local,
            invokeLocal: async (_clientId, _connectionId, _prefix, _body, timeoutMs) => {
                observed.push(timeoutMs);
                return Buffer.from('ok');
            },
            reserveLocalSenderIds: () => [],
            writeLocalStream: async () => {},
            finishLocalStream: async () => {},
            destroyLocalStream: async () => {},
            attachLocalReceiver: () => {
                throw new Error('not needed');
            },
            disconnectLocal: async () => {},
            updateLocalMetadata: async () => {}
        });
        const capability = 'foreign-clock-capability-00000001';
        (controller as any).handleCapabilities.set(capability, {
            clientId: local.clientId,
            connectionId: local.id,
            capability,
            peerIdentity: peer.endpointId,
            peerProcessId: peer.processId,
            peerEndpointId: peer.endpointId
        });
        for (const skewMs of [-30_000, 30_000]) {
            const response = await controller.route(peer, {
                header: {
                    type: 'invoke',
                    version: 2,
                    clientId: local.clientId,
                    connectionId: local.id,
                    prefix: 'dRead',
                    capability,
                    timeoutMs: 50,
                    deadlineAt: Date.now() + skewMs
                },
                body: Buffer.alloc(0)
            });
            assert.deepEqual(response.body, Buffer.from('ok'));
        }
        assert.equal(observed.length, 2);
        for (const residual of observed) assert.ok(residual > 0 && residual <= 50);
        await controller.close();
    });

    it('immediately rejects and abandons an expired issued sender grant', async () => {
        const destroyed: number[] = [];
        const controller = new MeshSrpcLinkController<SrpcMeta, SrpcMeta>({
            meshKey: 'expired-grant',
            requestTimeoutMs: 1_000,
            runtime: { onPeerClosed: () => () => {} } as any,
            service: { mesh: {} } as any,
            getLocalConnection: () => undefined,
            invokeLocal: async () => Buffer.alloc(0),
            reserveLocalSenderIds: () => [],
            writeLocalStream: async () => {},
            finishLocalStream: async () => {},
            destroyLocalStream: async (_clientId, _connectionId, streamId) => {
                destroyed.push(streamId);
            },
            attachLocalReceiver: () => {
                throw new Error('not needed');
            },
            disconnectLocal: async () => {},
            updateLocalMetadata: async () => {}
        });
        const peer = {
            processId: 'remote-process',
            endpointId: 'remote-endpoint',
            protocolVersion: 2
        } as any;
        const capability = 'expired-grant-capability-0000000001';
        (controller as any).issuedSenderGrants.set('connection-1:9', {
            clientId: 'client-1',
            capability,
            peerIdentity: peer.endpointId,
            peerProcessId: peer.processId,
            peerEndpointId: peer.endpointId,
            expiresAt: Date.now() - 1
        });

        assert.throws(
            () => (controller as any).assertIssuedSenderGrant(peer, { capability }, 'client-1', 'connection-1', 9),
            SrpcMeshAuthenticationError
        );
        await waitFor(() => destroyed.length === 1);
        assert.deepEqual(destroyed, [9]);
        assert.equal((controller as any).issuedSenderGrants.size, 0);
        await controller.close();
    });

    it('reconstructs stale remote errors and invalidates the cached handle', async () => {
        const record: RegisteredClient<SrpcMeta> = {
            clientId: 'client-1',
            nodeId: 2,
            connectionId: 'connection-1',
            connectedAt: Date.now(),
            metadata: {}
        };
        const node = {
            instanceId: 2,
            processId: 'owner-process',
            linkEndpointId: 'owner-endpoint',
            linkEndpointPublicKey: 'owner-public-key',
            linkUrl: 'ws://owner.test/mesh'
        };
        const controller = new MeshSrpcLinkController<SrpcMeta, SrpcMeta>({
            meshKey: 'remote-error-reconstruction',
            requestTimeoutMs: 10,
            runtime: {
                onPeerClosed: () => () => {},
                request: async () => {
                    const error = new Error('owner generation is stale');
                    error.name = 'SrpcStaleConnectionError';
                    throw error;
                },
                closePeer: () => {}
            } as any,
            service: {
                clientRegistry: { getClient: async () => record },
                mesh: { getNode: async () => node }
            } as any,
            getLocalConnection: () => undefined,
            invokeLocal: async () => Buffer.alloc(0),
            reserveLocalSenderIds: () => [],
            writeLocalStream: async () => {},
            finishLocalStream: async () => {},
            destroyLocalStream: async () => {},
            attachLocalReceiver: () => {
                throw new Error('not needed');
            },
            disconnectLocal: async () => {},
            updateLocalMetadata: async () => {}
        });
        const connection = new MeshRemoteSrpcConnection<SrpcMeta>({
            id: record.connectionId!,
            clientId: record.clientId,
            meta: {},
            connectedAt: record.connectedAt,
            ownerNodeId: record.nodeId,
            ownerProcessId: node.processId,
            ownerEndpointId: node.linkEndpointId,
            ownerEndpointPublicKey: node.linkEndpointPublicKey,
            capability: 'remote-error-capability-0000000001',
            senderIds: [],
            transport: controller
        });
        (controller as any).remoteConnections.set('client-1:connection-1', connection);

        await assert.rejects(controller.invoke(connection, 'dTest', Buffer.alloc(0), 100), error => error instanceof SrpcStaleConnectionError);
        assert.equal(connection.connected, false);
        assert.equal((controller as any).remoteConnections.size, 0);
        await controller.close();
    });

    it('binds v2 stream reservations to a confirmed peer capability and replays reservation IDs safely', async () => {
        let allocations = 0;
        const owner = { id: 'connection-1', clientId: 'client-1' } as any;
        const controller = new MeshSrpcLinkController<SrpcMeta, SrpcMeta>({
            meshKey: 'capability-owner',
            requestTimeoutMs: 1_000,
            runtime: { onPeerClosed: () => () => {} } as any,
            service: { mesh: { getNodes: async () => [{ processId: 'remote-peer', linkEndpointId: 'remote-endpoint' }] } } as any,
            getLocalConnection: () => owner,
            invokeLocal: async () => Buffer.alloc(0),
            reserveLocalSenderIds: (_clientId, _connectionId, count) => {
                allocations++;
                return Array.from({ length: count }, (_, index) => index + 2);
            },
            writeLocalStream: async () => {},
            finishLocalStream: async () => {},
            destroyLocalStream: async () => {},
            attachLocalReceiver: () => {
                throw new Error('not needed');
            },
            disconnectLocal: async () => {},
            updateLocalMetadata: async () => {}
        });
        const peer = { processId: 'remote-peer', endpointId: 'remote-endpoint', protocolVersion: 2, connected: true } as any;
        const reservationId = 'reservation-id-000000000000000001';
        const reserve = { type: 'reserveStreamIds' as const, version: 2, clientId: owner.clientId, connectionId: owner.id, count: 2, reservationId };

        const first = await controller.route(peer, { header: reserve, body: Buffer.alloc(0) });
        const replay = await controller.route(peer, { header: reserve, body: Buffer.alloc(0) });
        assert.deepEqual(replay.header.ids, first.header.ids);
        assert.equal(allocations, 1);
        const capability = first.header.capability!;
        await assert.rejects(
            controller.route(peer, {
                header: { type: 'streamFinish', version: 2, clientId: owner.clientId, connectionId: owner.id, streamId: 2, capability },
                body: Buffer.alloc(0)
            }),
            /handle is not owned/
        );
        await controller.route(peer, {
            header: { type: 'confirmStreamIds', version: 2, clientId: owner.clientId, connectionId: owner.id, reservationId, capability },
            body: Buffer.alloc(0)
        });
        await assert.rejects(
            controller.route(peer, {
                header: {
                    type: 'streamFinish',
                    version: 2,
                    clientId: owner.clientId,
                    connectionId: owner.id,
                    streamId: 2,
                    capability: 'wrong-capability-00000000000000001'
                },
                body: Buffer.alloc(0)
            }),
            /handle is not owned/
        );
        await controller.route(peer, {
            header: { type: 'streamFinish', version: 2, clientId: owner.clientId, connectionId: owner.id, streamId: 2, capability },
            body: Buffer.alloc(0)
        });
        controller.close();
    });

    it('releases inactive stream reservations without destroying local streams', async () => {
        const owner = { id: 'connection-1', clientId: 'client-1' } as any;
        const destroyed: number[] = [];
        const controller = new MeshSrpcLinkController<SrpcMeta, SrpcMeta>({
            meshKey: 'inactive-reservation-release',
            requestTimeoutMs: 1_000,
            runtime: { onPeerClosed: () => () => {} } as any,
            service: { mesh: { getNodes: async () => [{ processId: 'remote-peer', linkEndpointId: 'remote-endpoint' }] } } as any,
            getLocalConnection: () => owner,
            invokeLocal: async () => Buffer.alloc(0),
            reserveLocalSenderIds: () => [2],
            writeLocalStream: async () => {},
            finishLocalStream: async () => {},
            destroyLocalStream: async (_clientId, _connectionId, streamId) => {
                destroyed.push(streamId);
            },
            attachLocalReceiver: () => {
                throw new Error('not needed');
            },
            disconnectLocal: async () => {},
            updateLocalMetadata: async () => {}
        });
        const peer = { processId: 'remote-peer', endpointId: 'remote-endpoint', protocolVersion: 2, connected: true } as any;
        const reserved = await controller.route(peer, {
            header: {
                type: 'reserveStreamIds',
                version: 2,
                clientId: owner.clientId,
                connectionId: owner.id,
                count: 1,
                reservationId: 'inactive-reservation-release-0001'
            },
            body: Buffer.alloc(0)
        });
        const streamId = reserved.header.ids![0];
        await controller.route(peer, {
            header: {
                type: 'releaseStreamIds',
                version: 2,
                clientId: owner.clientId,
                connectionId: owner.id,
                ids: [streamId],
                capability: reserved.header.capability
            },
            body: Buffer.alloc(0)
        });

        assert.deepEqual(destroyed, []);
        assert.equal((controller as any).senderRoutes.has(`${owner.id}:${streamId}`), false);
        await controller.close();
    });

    it('rechecks the handle-capability limit when provisional reservations are confirmed', async () => {
        const owner = { id: 'connection-1', clientId: 'client-1' } as any;
        const peer = {
            processId: 'remote-peer',
            endpointId: 'remote-endpoint',
            protocolVersion: 2,
            connected: true
        } as any;
        let nextStreamId = 2;
        const destroyed: number[] = [];
        const controller = new MeshSrpcLinkController<SrpcMeta, SrpcMeta>({
            meshKey: 'confirmation-capability-limit',
            requestTimeoutMs: 1_000,
            runtime: { onPeerClosed: () => () => {} } as any,
            service: {
                mesh: {
                    getNodes: async () => [{ processId: peer.processId, linkEndpointId: peer.endpointId }]
                }
            } as any,
            getLocalConnection: () => owner,
            invokeLocal: async () => Buffer.alloc(0),
            reserveLocalSenderIds: () => {
                const id = nextStreamId;
                nextStreamId += 2;
                return [id];
            },
            writeLocalStream: async () => {},
            finishLocalStream: async () => {},
            destroyLocalStream: async (_clientId, _connectionId, streamId) => {
                destroyed.push(streamId);
            },
            attachLocalReceiver: () => {
                throw new Error('not needed');
            },
            disconnectLocal: async () => {},
            updateLocalMetadata: async () => {}
        });
        for (let index = 0; index < 8_191; index++) {
            const capability = `existing-capability-${index}`;
            (controller as any).handleCapabilities.set(capability, {
                clientId: `existing-client-${index}`,
                connectionId: `existing-connection-${index}`,
                capability,
                peerIdentity: `existing-endpoint-${index}`,
                peerProcessId: `existing-process-${index}`,
                peerEndpointId: `existing-endpoint-${index}`,
                expiresAt: Number.POSITIVE_INFINITY
            });
        }
        const reserve = async (reservationId: string) =>
            controller.route(peer, {
                header: {
                    type: 'reserveStreamIds',
                    version: 2,
                    clientId: owner.clientId,
                    connectionId: owner.id,
                    count: 1,
                    reservationId
                },
                body: Buffer.alloc(0)
            });
        const firstReservationId = 'capacity-reservation-first-000001';
        const secondReservationId = 'capacity-reservation-second-00001';
        const first = await reserve(firstReservationId);
        const second = await reserve(secondReservationId);
        const firstCapability = first.header.capability!;
        const secondCapability = second.header.capability!;
        const firstStreamId = first.header.ids![0];
        const secondStreamId = second.header.ids![0];
        const confirm = (reservationId: string, capability: string) =>
            controller.route(peer, {
                header: {
                    type: 'confirmStreamIds',
                    version: 2,
                    clientId: owner.clientId,
                    connectionId: owner.id,
                    reservationId,
                    capability
                },
                body: Buffer.alloc(0)
            });

        await confirm(firstReservationId, firstCapability);
        assert.equal((controller as any).handleCapabilities.size, 8_192);
        await assert.rejects(confirm(secondReservationId, secondCapability), SrpcBackpressureError);

        assert.equal((controller as any).handleCapabilities.size, 8_192);
        assert.equal((controller as any).handleCapabilities.has(firstCapability), true);
        assert.equal((controller as any).handleCapabilities.has(secondCapability), false);
        assert.equal(
            [...(controller as any).reservations.values()].some((reservation: any) => reservation.capability === secondCapability),
            false
        );
        assert.equal((controller as any).senderRoutes.has(`${owner.id}:${firstStreamId}`), true);
        assert.equal((controller as any).senderRoutes.has(`${owner.id}:${secondStreamId}`), false);
        assert.deepEqual(destroyed, []);

        (controller as any).handleCapabilities.clear();
        (controller as any).reservations.clear();
        (controller as any).senderRoutes.clear();
        await controller.close();
    });

    it('binds announced client streams to the exact invoking handle', async () => {
        const owner = { id: 'connection-1', clientId: 'client-1' } as any;
        const parent = createByteParent(owner.id);
        const peerA = {
            processId: 'remote-process',
            endpointId: 'remote-endpoint-a',
            protocolVersion: 2,
            connected: true
        } as any;
        const peerB = {
            processId: 'remote-process',
            endpointId: 'remote-endpoint-b',
            protocolVersion: 2,
            connected: true
        } as any;
        let nextRouteId = 2;
        let nextIssuedId = 9;
        const controller = new MeshSrpcLinkController<SrpcMeta, SrpcMeta>({
            meshKey: 'issued-stream-owner',
            requestTimeoutMs: 1_000,
            runtime: {
                onPeerClosed: () => () => {},
                requestPeer: async () => ({ header: { type: 'result' }, body: Buffer.alloc(0) })
            } as any,
            service: {
                mesh: {
                    getNodes: async () => [
                        { processId: peerA.processId, linkEndpointId: peerA.endpointId },
                        { processId: peerB.processId, linkEndpointId: peerB.endpointId }
                    ]
                }
            } as any,
            getLocalConnection: () => owner,
            invokeLocal: async () => {
                const streamId = nextIssuedId;
                nextIssuedId += 2;
                return { body: Buffer.from('ok'), issuedSenderIds: [streamId] };
            },
            reserveLocalSenderIds: (_clientId, _connectionId, count) =>
                Array.from({ length: count }, () => {
                    const id = nextRouteId;
                    nextRouteId += 2;
                    return id;
                }),
            writeLocalStream: async () => {},
            finishLocalStream: async () => {},
            destroyLocalStream: async () => {},
            attachLocalReceiver: (_clientId, _connectionId, streamId) => {
                const receiver = SrpcByteStream.createReceiver(parent, streamId);
                receiver.on('error', () => {});
                return receiver;
            },
            disconnectLocal: async () => {},
            updateLocalMetadata: async () => {}
        });
        const openHandle = async (peer: any, reservationId: string) => {
            const reserved = await controller.route(peer, {
                header: {
                    type: 'reserveStreamIds',
                    version: 2,
                    clientId: owner.clientId,
                    connectionId: owner.id,
                    count: 1,
                    reservationId
                },
                body: Buffer.alloc(0)
            });
            const capability = reserved.header.capability!;
            await controller.route(peer, {
                header: {
                    type: 'confirmStreamIds',
                    version: 2,
                    clientId: owner.clientId,
                    connectionId: owner.id,
                    reservationId,
                    capability
                },
                body: Buffer.alloc(0)
            });
            return capability;
        };
        const capabilityA = await openHandle(peerA, 'reservation-id-handle-a-00000001');
        const capabilityB = await openHandle(peerB, 'reservation-id-handle-b-00000001');
        const invoke = (peer: any, capability: string) =>
            controller.route(peer, {
                header: {
                    type: 'invoke',
                    version: 2,
                    clientId: owner.clientId,
                    connectionId: owner.id,
                    prefix: 'dProduce',
                    capability
                },
                body: Buffer.alloc(0)
            });

        await invoke(peerA, capabilityA);
        await assert.rejects(
            controller.route(peerB, {
                header: {
                    type: 'streamAttach',
                    version: 2,
                    clientId: owner.clientId,
                    connectionId: owner.id,
                    streamId: 9,
                    capability: capabilityB
                },
                body: Buffer.alloc(0)
            }),
            /was not issued to this handle/
        );
        assert.equal(SrpcByteStream.hasReceiver(parent, 9), false);
        await controller.route(peerA, {
            header: {
                type: 'streamAttach',
                version: 2,
                clientId: owner.clientId,
                connectionId: owner.id,
                streamId: 9,
                capability: capabilityA
            },
            body: Buffer.alloc(0)
        });
        assert.equal(SrpcByteStream.hasReceiver(parent, 9), true);

        await invoke(peerB, capabilityB);
        await assert.rejects(
            controller.route(peerB, {
                header: {
                    type: 'releaseStreamIds',
                    version: 2,
                    clientId: owner.clientId,
                    connectionId: owner.id,
                    ids: [],
                    closeCapability: true,
                    capability: capabilityA
                },
                body: Buffer.alloc(0)
            }),
            /not owned/
        );
        for (let attempt = 0; attempt < 2; attempt++) {
            await controller.route(peerA, {
                header: {
                    type: 'releaseStreamIds',
                    version: 2,
                    clientId: owner.clientId,
                    connectionId: owner.id,
                    ids: [],
                    closeCapability: true,
                    capability: capabilityA
                },
                body: Buffer.alloc(0)
            });
        }
        await controller.route(peerB, {
            header: {
                type: 'streamAttach',
                version: 2,
                clientId: owner.clientId,
                connectionId: owner.id,
                streamId: 11,
                capability: capabilityB
            },
            body: Buffer.alloc(0)
        });
        assert.equal(SrpcByteStream.hasReceiver(parent, 11), true);
        controller.close();
    });

    it('does not issue stream grants after an invoking handle closes', async () => {
        const owner = { id: 'connection-1', clientId: 'client-1' } as any;
        const peer = {
            processId: 'remote-process',
            endpointId: 'remote-endpoint',
            protocolVersion: 2,
            connected: true
        } as any;
        const capability = 'invoke-race-capability-000000000001';
        let finishInvoke: ((result: { body: Uint8Array; issuedSenderIds: number[] }) => void) | undefined;
        let markInvokeStarted: (() => void) | undefined;
        const invokeStarted = new Promise<void>(resolve => {
            markInvokeStarted = resolve;
        });
        const invokeResult = new Promise<{ body: Uint8Array; issuedSenderIds: number[] }>(resolve => {
            finishInvoke = resolve;
        });
        const destroyed: number[] = [];
        const controller = new MeshSrpcLinkController<SrpcMeta, SrpcMeta>({
            meshKey: 'invoke-grant-race',
            requestTimeoutMs: 1_000,
            runtime: {
                onPeerClosed: () => () => {},
                requestPeer: async () => ({ header: { type: 'result' }, body: Buffer.alloc(0) })
            } as any,
            service: {
                mesh: {
                    getNodes: async () => [{ processId: peer.processId, linkEndpointId: peer.endpointId }]
                }
            } as any,
            getLocalConnection: () => owner,
            invokeLocal: async () => {
                markInvokeStarted!();
                return invokeResult;
            },
            reserveLocalSenderIds: () => [],
            writeLocalStream: async () => {},
            finishLocalStream: async () => {},
            destroyLocalStream: async (_clientId, _connectionId, streamId) => {
                destroyed.push(streamId);
            },
            attachLocalReceiver: () => {
                throw new Error('not needed');
            },
            disconnectLocal: async () => {},
            updateLocalMetadata: async () => {}
        });
        (controller as any).handleCapabilities.set(capability, {
            clientId: owner.clientId,
            connectionId: owner.id,
            capability,
            peerIdentity: peer.endpointId,
            peerProcessId: peer.processId,
            peerEndpointId: peer.endpointId
        });
        const invocation = controller.route(peer, {
            header: {
                type: 'invoke',
                version: 2,
                clientId: owner.clientId,
                connectionId: owner.id,
                prefix: 'dProduce',
                capability
            },
            body: Buffer.alloc(0)
        });
        await invokeStarted;
        await controller.route(peer, {
            header: {
                type: 'releaseStreamIds',
                version: 2,
                clientId: owner.clientId,
                connectionId: owner.id,
                ids: [],
                closeCapability: true,
                capability
            },
            body: Buffer.alloc(0)
        });
        finishInvoke!({ body: Buffer.from('late'), issuedSenderIds: [9] });

        await assert.rejects(invocation, SrpcStaleConnectionError);
        assert.deepEqual(destroyed, [9]);
        assert.equal((controller as any).issuedSenderGrants.size, 0);
        await controller.close();
    });

    it('preserves backpressure when grant-cap cleanup itself rejects', async () => {
        const owner = { id: 'connection-1', clientId: 'client-1' } as any;
        const peer = {
            processId: 'remote-process',
            endpointId: 'remote-endpoint',
            publicKey: 'remote-key',
            protocolVersion: 2,
            connected: true
        } as any;
        const capability = 'grant-cleanup-capability-000000001';
        const controller = new MeshSrpcLinkController<SrpcMeta, SrpcMeta>({
            meshKey: 'grant-cleanup-failure',
            requestTimeoutMs: 1_000,
            runtime: {
                onPeerClosed: () => () => {}
            } as any,
            service: {
                mesh: {
                    getNodes: async () => [{ processId: peer.processId, linkEndpointId: peer.endpointId }]
                }
            } as any,
            getLocalConnection: () => owner,
            invokeLocal: async () => Buffer.alloc(0),
            reserveLocalSenderIds: () => [],
            writeLocalStream: async () => {},
            finishLocalStream: async () => {},
            destroyLocalStream: async () => {
                throw new Error('grant cleanup failed');
            },
            attachLocalReceiver: () => {
                throw new Error('not needed');
            },
            disconnectLocal: async () => {},
            updateLocalMetadata: async () => {}
        });
        (controller as any).handleCapabilities.set(capability, {
            clientId: owner.clientId,
            connectionId: owner.id,
            capability,
            peerIdentity: peer.endpointId
        });
        for (let index = 0; index < 128; index++) {
            (controller as any).issuedSenderGrants.set(`${owner.id}:${index * 2 + 1}`, {
                clientId: owner.clientId,
                capability,
                peerIdentity: peer.endpointId,
                expiresAt: Date.now() + 60_000
            });
        }

        await assert.rejects(
            (controller as any).grantIssuedSenderIds(peer, { capability }, owner.clientId, owner.id, {
                body: Buffer.alloc(0),
                issuedSenderIds: [999]
            }),
            SrpcBackpressureError
        );
        await controller.close();
    });

    it('destroys announced senders on every failed remote invocation path and rejects late announcements', async () => {
        for (const failure of ['handler', 'encode', 'send', 'timeout'] as const) {
            const clientDisconnectHandlers = new Set<() => void>();
            const clientParent: IByteStreamable = {
                byteStream: {
                    parentStreamId: `failed-client-${failure}`,
                    write: () => {},
                    finish: () => {},
                    destroy: () => {},
                    attachDisconnectHandler: handler => clientDisconnectHandlers.add(handler),
                    detachDisconnectHandler: handler => clientDisconnectHandlers.delete(handler),
                    getBufferedAmount: () => 0
                }
            };
            SrpcByteStream.init(clientParent, { startId: 1, step: 2 });
            const sender = SrpcByteStream.createSender(clientParent);
            sender.on('error', () => {});
            assert.equal(sender.id, 1);
            assert.equal(clientDisconnectHandlers.size, 1);

            const ownerParent = createByteParent(`failed-owner-${failure}`);
            const stream = {
                id: `connection-${failure}`,
                clientId: `client-${failure}`,
                connected: true,
                lastPingAt: Date.now(),
                capabilities: new Set(['sender-announcements']),
                byteStream: ownerParent.byteStream,
                $queue: new Map()
            } as any;
            const original = new Error(`${failure} failure`);
            const destroyed: number[] = [];
            let requestId = '';
            const server = Object.create(MeshSrpcServer.prototype) as any;
            server.meshKey = `failed-invocation-${failure}`;
            server.meshLinkRequestTimeoutMs = 100;
            server.streamsByClientId = new Map([[stream.clientId, stream]]);
            server.pendingStreamsByClientId = new Map();
            server.announcedSenderIds = new Map();
            server.pendingMeshInvocationRequestIds = new Set();
            server.failedMeshInvocationTombstones = new Map();
            server.backpressuredByteStreams = new WeakMap();
            server.backpressuredByteStreamBytes = new WeakMap();
            server.meshClientService = {
                instanceId: 1,
                clientRegistry: {
                    getClient: async () => ({
                        clientId: stream.clientId,
                        connectionId: stream.id,
                        nodeId: 1,
                        connectedAt: Date.now(),
                        metadata: {}
                    })
                }
            };
            server.decodeMeshInvokeRequest = () => ({});
            server.encodeMeshInvokeResponse = () => {
                if (failure === 'encode') throw original;
                return Buffer.from('ok');
            };
            server.writeByteStreamOperation = async (_stream: unknown, operation: any) => {
                if (!operation.destroy) return;
                destroyed.push(operation.streamId);
                SrpcByteStream.destroySubstream(clientParent, operation.streamId, operation.destroy.error);
                if (failure === 'send') throw new Error('terminal destroy write failed after delivery');
            };
            server.invokeMeshClientWithRequestId = async (_stream: unknown, _prefix: string, _data: unknown, _timeoutMs: number, id: string) => {
                requestId = id;
                if (failure !== 'timeout') {
                    server.handleByteSubstreamOperation(stream, { streamId: sender.id, write: { chunk: Buffer.alloc(0) } }, requestId);
                }
                if (failure === 'encode') return { ok: true };
                throw original;
            };
            const controller = server.createMeshLinkController({ onPeerClosed: () => () => {} });
            try {
                await assert.rejects(
                    (controller as any).options.invokeLocal(stream.clientId, stream.id, 'dProduce', Buffer.alloc(0), 20),
                    error => error === original
                );
                assert.notEqual(requestId, '');
                if (failure === 'timeout') {
                    server.handleByteSubstreamOperation(stream, { streamId: sender.id, write: { chunk: Buffer.alloc(0) } }, requestId);
                }
                await new Promise(resolve => setImmediate(resolve));
                assert.deepEqual(destroyed, [sender.id]);
                assert.equal(sender.destroyed, true);
                assert.equal(clientDisconnectHandlers.size, 0);
                assert.equal(server.pendingMeshInvocationRequestIds.size, 0);
                assert.equal(server.announcedSenderIds.size, 0);
                assert.equal(server.failedMeshInvocationTombstones.size, 1);
                server.pruneFailedMeshInvocationTombstones(Number.POSITIVE_INFINITY);
                assert.equal(server.failedMeshInvocationTombstones.size, 0);
                server.pruneFailedMeshInvocationTombstones(Number.POSITIVE_INFINITY);
                assert.equal(server.failedMeshInvocationTombstones.size, 0);
            } finally {
                await controller.close();
            }
        }
    });

    it('immediately destroys sender announcements beyond the per-invocation tracking cap', () => {
        const ownerParent = createByteParent('announcement-overflow-owner');
        const stream = {
            id: 'announcement-overflow-connection',
            clientId: 'announcement-overflow-client',
            connected: true,
            lastPingAt: Date.now(),
            capabilities: new Set(['sender-announcements']),
            byteStream: ownerParent.byteStream,
            $queue: new Map()
        } as any;
        const requestId = 'announcement-overflow-request';
        const invocationKey = `${stream.id}:${requestId}`;
        const destroyed: number[] = [];
        const server = Object.create(MeshSrpcServer.prototype) as any;
        server.announcedSenderIds = new Map();
        server.pendingMeshInvocationRequestIds = new Set([invocationKey]);
        server.failedMeshInvocationTombstones = new Map();
        server.backpressuredByteStreams = new WeakMap();
        server.backpressuredByteStreamBytes = new WeakMap();
        server.meshLinkController = undefined;
        server.destroyFailedMeshInvocationSender = (_stream: unknown, streamId: number) => {
            destroyed.push(streamId);
        };

        for (let index = 0; index < 129; index++) {
            server.handleByteSubstreamOperation(stream, { streamId: index * 2 + 1, write: { chunk: Buffer.alloc(0) } }, requestId);
        }

        assert.equal(server.announcedSenderIds.get(invocationKey)?.size, 128);
        assert.deepEqual(destroyed, [257]);
    });

    it('does not evict a live failed-invocation fence when tombstones saturate', () => {
        const ownerParent = createByteParent('failed-tombstone-owner');
        const stream = {
            id: 'failed-tombstone-connection',
            clientId: 'failed-tombstone-client',
            connected: true,
            lastPingAt: Date.now(),
            capabilities: new Set(['sender-announcements']),
            byteStream: ownerParent.byteStream,
            $queue: new Map()
        } as any;
        const destroyed: number[] = [];
        const server = Object.create(MeshSrpcServer.prototype) as any;
        server.announcedSenderIds = new Map();
        server.pendingMeshInvocationRequestIds = new Set();
        server.failedMeshInvocationTombstones = new Map();
        server.backpressuredByteStreams = new WeakMap();
        server.backpressuredByteStreamBytes = new WeakMap();
        server.meshLinkController = undefined;
        server.destroyFailedMeshInvocationSender = (_stream: unknown, streamId: number) => {
            destroyed.push(streamId);
        };
        const originalNow = Date.now;
        Date.now = () => 1_000;
        try {
            for (let index = 0; index < 4_097; index++) {
                server.rememberFailedMeshInvocation(`${stream.id}:request-${index}`);
            }
            server.handleByteSubstreamOperation(stream, { streamId: 1, write: { chunk: Buffer.alloc(0) } }, 'request-0');
        } finally {
            Date.now = originalNow;
        }

        assert.deepEqual(destroyed, [1]);
    });

    it('retains and retries failed capability cleanup until the owner acknowledges it', async () => {
        let attempts = 0;
        const controller = new MeshSrpcLinkController<SrpcMeta, SrpcMeta>({
            meshKey: 'cleanup-retry',
            requestTimeoutMs: 1_000,
            runtime: {
                onPeerClosed: () => () => {},
                request: async () => {
                    attempts++;
                    if (attempts === 1) throw new Error('temporary close failure');
                    return { header: { type: 'result' }, body: Buffer.alloc(0) };
                }
            } as any,
            service: {
                mesh: {
                    getNode: async () => ({
                        instanceId: 2,
                        processId: 'owner-process',
                        linkEndpointId: 'owner-endpoint',
                        linkEndpointPublicKey: 'owner-public-key',
                        linkUrl: 'ws://owner.test/mesh'
                    })
                }
            } as any,
            getLocalConnection: () => undefined,
            invokeLocal: async () => Buffer.alloc(0),
            reserveLocalSenderIds: () => [],
            writeLocalStream: async () => {},
            finishLocalStream: async () => {},
            destroyLocalStream: async () => {},
            attachLocalReceiver: () => {
                throw new Error('not needed');
            },
            disconnectLocal: async () => {},
            updateLocalMetadata: async () => {}
        });
        const connection = new MeshRemoteSrpcConnection<SrpcMeta>({
            id: 'connection-1',
            clientId: 'client-1',
            meta: {},
            connectedAt: Date.now(),
            ownerNodeId: 2,
            ownerProcessId: 'owner-process',
            ownerEndpointId: 'owner-endpoint',
            capability: 'cleanup-capability-000000000000001',
            senderIds: [2, 4],
            supportsSenderIdRelease: true,
            transport: controller
        });

        (controller as any).releaseAndMarkStale(connection);
        await waitFor(() => {
            const marker = [...(controller as any).cleanupMarkers.values()][0];
            return attempts === 1 && (controller as any).cleanupMarkers.size === 1 && !marker?.retrying;
        });
        await (controller as any).retryCleanupMarkers(true);

        assert.equal(attempts, 2);
        assert.equal((controller as any).cleanupMarkers.size, 0);
        controller.close();
    });

    it('accepts exact owner revocation against an invalidated connection cleanup marker', async () => {
        const ownerPeer = {
            processId: 'owner-process',
            endpointId: 'owner-endpoint',
            publicKey: 'owner-public-key',
            protocolVersion: 2,
            connected: true
        } as any;
        const wrongEndpointPeer = {
            ...ownerPeer,
            endpointId: 'other-owner-endpoint',
            publicKey: 'other-owner-public-key'
        } as any;
        const nodes = [
            {
                instanceId: 2,
                processId: ownerPeer.processId,
                linkEndpointId: ownerPeer.endpointId,
                linkEndpointPublicKey: ownerPeer.publicKey
            },
            {
                instanceId: 3,
                processId: wrongEndpointPeer.processId,
                linkEndpointId: wrongEndpointPeer.endpointId,
                linkEndpointPublicKey: wrongEndpointPeer.publicKey
            }
        ];
        let peerCloses = 0;
        let pinUnregisters = 0;
        let cleanupAttempts = 0;
        let cleanupLookupStarted!: () => void;
        const cleanupLookupStartedPromise = new Promise<void>(resolve => {
            cleanupLookupStarted = resolve;
        });
        let releaseCleanupLookup!: (node: undefined) => void;
        const cleanupLookup = new Promise<undefined>(resolve => {
            releaseCleanupLookup = resolve;
        });
        const controller = new MeshSrpcLinkController<SrpcMeta, SrpcMeta>({
            meshKey: 'cleanup-revocation-race',
            requestTimeoutMs: 1_000,
            runtime: {
                onPeerClosed: () => () => {},
                closePeer: () => {
                    peerCloses++;
                },
                request: async () => {
                    cleanupAttempts++;
                    throw new Error('cleanup acknowledgement delayed');
                }
            } as any,
            service: {
                mesh: {
                    getNodes: async () => nodes,
                    getNode: async () => {
                        cleanupLookupStarted();
                        return cleanupLookup;
                    }
                }
            } as any,
            getLocalConnection: () => undefined,
            invokeLocal: async () => Buffer.alloc(0),
            reserveLocalSenderIds: () => [],
            writeLocalStream: async () => {},
            finishLocalStream: async () => {},
            destroyLocalStream: async () => {},
            attachLocalReceiver: () => {
                throw new Error('not needed');
            },
            disconnectLocal: async () => {},
            updateLocalMetadata: async () => {}
        });
        const capability = 'cleanup-revocation-capability-000001';
        const connection = new MeshRemoteSrpcConnection<SrpcMeta>({
            id: 'connection-1',
            clientId: 'client-1',
            meta: {},
            connectedAt: Date.now(),
            ownerNodeId: 2,
            ownerProcessId: ownerPeer.processId,
            ownerEndpointId: ownerPeer.endpointId,
            ownerEndpointPublicKey: ownerPeer.publicKey,
            capability,
            senderIds: [2, 4],
            supportsSenderIdRelease: true,
            transport: controller
        });
        (controller as any).remoteConnections.set('client-1:connection-1', connection);
        (controller as any).endpointPinUnregisters.set(ownerPeer.endpointId, () => {
            pinUnregisters++;
        });

        (controller as any).invalidate(connection);
        await cleanupLookupStartedPromise;
        const inFlightCleanup = (controller as any).cleanupMarkers.get(capability)?.retrying as Promise<void>;
        assert.ok(inFlightCleanup);
        assert.equal(connection.connected, false);
        assert.equal((controller as any).remoteConnections.size, 0);
        assert.equal((controller as any).cleanupMarkers.size, 1);
        assert.equal((controller as any).endpointPinUnregisters.size, 1);

        const revoke = (peer: any, overrides: Record<string, unknown> = {}) =>
            controller.route(peer, {
                header: {
                    type: 'revokeCapability',
                    version: 2,
                    clientId: connection.clientId,
                    connectionId: connection.id,
                    capability,
                    ...overrides
                },
                body: Buffer.alloc(0)
            });
        for (const attempt of [
            () => revoke(ownerPeer, { clientId: 'different-client' }),
            () => revoke(ownerPeer, { connectionId: 'different-connection' }),
            () => revoke(ownerPeer, { capability: 'different-cleanup-capability-00001' }),
            () => revoke(wrongEndpointPeer)
        ]) {
            await assert.rejects(attempt(), SrpcMeshAuthenticationError);
            assert.equal((controller as any).cleanupMarkers.get(capability) !== undefined, true);
        }

        await revoke(ownerPeer);
        assert.equal((controller as any).cleanupMarkers.size, 0);
        assert.equal((controller as any).revokedRemoteCapabilities.has(capability), true);
        assert.equal((controller as any).endpointPinUnregisters.size, 0);
        assert.equal(pinUnregisters, 1);
        assert.equal(peerCloses, 0);

        // The bounded tombstone makes the owner's retry idempotent without
        // reconstructing a live remote connection.
        await revoke(ownerPeer);
        assert.equal((controller as any).revokedRemoteCapabilities.size, 1);
        assert.equal(peerCloses, 0);
        releaseCleanupLookup(undefined);
        await inFlightCleanup;
        assert.equal(cleanupAttempts, 0);
        assert.equal(peerCloses, 0);
        await controller.close();
    });

    it('retains capability cleanup when initial confirmation fails before handle installation', async () => {
        const record: RegisteredClient<SrpcMeta> = {
            clientId: 'client-1',
            nodeId: 2,
            connectionId: 'connection-1',
            connectedAt: Date.now(),
            metadata: {}
        };
        let cleanupAttempts = 0;
        const controller = new MeshSrpcLinkController<SrpcMeta, SrpcMeta>({
            meshKey: 'preinstall-cleanup-retry',
            requestTimeoutMs: 1_000,
            runtime: {
                onPeerClosed: () => () => {},
                closePeer: () => {},
                request: async (_url: string, header: { type: string }) => {
                    if (header.type === 'reserveStreamIds') {
                        return {
                            header: {
                                type: 'result',
                                ids: [2, 4, 6, 8],
                                capability: 'preinstall-capability-000000000001'
                            },
                            body: Buffer.alloc(0)
                        };
                    }
                    if (header.type === 'confirmStreamIds') throw new Error('temporary confirmation failure');
                    cleanupAttempts++;
                    if (cleanupAttempts === 1) throw new Error('temporary cleanup failure');
                    return { header: { type: 'result' }, body: Buffer.alloc(0) };
                }
            } as any,
            service: {
                clientRegistry: { getClient: async () => record },
                mesh: {
                    getNode: async () => ({
                        instanceId: 2,
                        processId: 'owner-process',
                        linkEndpointId: 'owner-endpoint',
                        linkEndpointPublicKey: 'owner-public-key',
                        linkUrl: 'ws://owner.test/mesh'
                    })
                }
            } as any,
            getLocalConnection: () => undefined,
            invokeLocal: async () => Buffer.alloc(0),
            reserveLocalSenderIds: () => [],
            writeLocalStream: async () => {},
            finishLocalStream: async () => {},
            destroyLocalStream: async () => {},
            attachLocalReceiver: () => {
                throw new Error('not needed');
            },
            disconnectLocal: async () => {},
            updateLocalMetadata: async () => {}
        });

        await assert.rejects(controller.resolveClient(record.clientId), /temporary confirmation failure/);
        await waitFor(() => {
            const marker = [...(controller as any).cleanupMarkers.values()][0];
            return cleanupAttempts === 1 && (controller as any).cleanupMarkers.size === 1 && !marker?.retrying;
        });
        await (controller as any).retryCleanupMarkers(true);

        assert.equal(cleanupAttempts, 2);
        assert.equal((controller as any).cleanupMarkers.size, 0);
        await controller.close();
    });

    it('drains remote handle capabilities while closing a controller on a shared runtime', async () => {
        const closedCapabilities: string[] = [];
        const controller = new MeshSrpcLinkController<SrpcMeta, SrpcMeta>({
            meshKey: 'controller-close-cleanup',
            requestTimeoutMs: 1_000,
            runtime: {
                onPeerClosed: () => () => {},
                closePeer: () => {},
                request: async (_url: string, header: { closeCapability?: boolean; capability?: string }) => {
                    if (header.closeCapability) closedCapabilities.push(header.capability!);
                    return { header: { type: 'result' }, body: Buffer.alloc(0) };
                }
            } as any,
            service: {
                mesh: {
                    getNode: async () => ({
                        instanceId: 2,
                        processId: 'owner-process',
                        linkEndpointId: 'owner-endpoint',
                        linkEndpointPublicKey: 'owner-public-key',
                        linkUrl: 'ws://owner.test/mesh'
                    })
                }
            } as any,
            getLocalConnection: () => undefined,
            invokeLocal: async () => Buffer.alloc(0),
            reserveLocalSenderIds: () => [],
            writeLocalStream: async () => {},
            finishLocalStream: async () => {},
            destroyLocalStream: async () => {},
            attachLocalReceiver: () => {
                throw new Error('not needed');
            },
            disconnectLocal: async () => {},
            updateLocalMetadata: async () => {}
        });
        const capability = 'shutdown-capability-000000000000001';
        const connection = new MeshRemoteSrpcConnection<SrpcMeta>({
            id: 'connection-1',
            clientId: 'client-1',
            meta: {},
            connectedAt: Date.now(),
            ownerNodeId: 2,
            ownerProcessId: 'owner-process',
            ownerEndpointId: 'owner-endpoint',
            capability,
            senderIds: [2],
            transport: controller
        });
        (controller as any).remoteConnections.set('client-1:connection-1', connection);

        await controller.close();

        assert.deepEqual(closedCapabilities, [capability]);
        assert.equal((controller as any).cleanupMarkers.size, 0);
    });

    it('closes the exact pinned peer when shutdown cleanup remains unacknowledged', async () => {
        let peerCloses = 0;
        const controller = new MeshSrpcLinkController<SrpcMeta, SrpcMeta>({
            meshKey: 'controller-close-no-peer-fallback',
            requestTimeoutMs: 1,
            runtime: {
                isClosed: false,
                onPeerClosed: () => () => {},
                closePeer: () => {
                    peerCloses++;
                },
                request: async () => {
                    throw new Error('owner unavailable');
                }
            } as any,
            service: {
                mesh: {
                    getNode: async () => ({
                        instanceId: 2,
                        processId: 'owner-process',
                        linkEndpointId: 'owner-endpoint',
                        linkUrl: 'ws://owner.test/mesh'
                    })
                }
            } as any,
            getLocalConnection: () => undefined,
            invokeLocal: async () => Buffer.alloc(0),
            reserveLocalSenderIds: () => [],
            writeLocalStream: async () => {},
            finishLocalStream: async () => {},
            destroyLocalStream: async () => {},
            attachLocalReceiver: () => {
                throw new Error('not needed');
            },
            disconnectLocal: async () => {},
            updateLocalMetadata: async () => {}
        });
        (controller as any).rememberCleanup({
            clientId: 'client-1',
            connectionId: 'connection-1',
            ownerNodeId: 2,
            ownerProcessId: 'owner-process',
            ownerEndpointId: 'owner-endpoint',
            capability: 'controller-close-no-peer-fallback-01'
        });

        await controller.close();
        assert.equal(peerCloses, 1);
        assert.equal((controller as any).cleanupMarkers.size, 0);
        assert.equal((controller as any).cleanupRetryTimer, undefined);
    });

    it('expires abandoned owner capabilities after a bounded idle lease', async () => {
        const destroyed: number[] = [];
        const controller = new MeshSrpcLinkController<SrpcMeta, SrpcMeta>({
            meshKey: 'owner-capability-lease',
            requestTimeoutMs: 1_000,
            runtime: { onPeerClosed: () => () => {} } as any,
            service: { mesh: {} } as any,
            getLocalConnection: () => undefined,
            invokeLocal: async () => Buffer.alloc(0),
            reserveLocalSenderIds: () => [],
            writeLocalStream: async () => {},
            finishLocalStream: async () => {},
            destroyLocalStream: async (_clientId, _connectionId, streamId) => {
                destroyed.push(streamId);
            },
            attachLocalReceiver: () => {
                throw new Error('not needed');
            },
            disconnectLocal: async () => {},
            updateLocalMetadata: async () => {}
        });
        const capability = 'expired-owner-capability-000000001';
        (controller as any).handleCapabilities.set(capability, {
            clientId: 'client-1',
            connectionId: 'connection-1',
            capability,
            peerIdentity: 'remote-endpoint',
            peerProcessId: 'remote-process',
            peerEndpointId: 'remote-endpoint',
            expiresAt: 0
        });
        (controller as any).issuedSenderGrants.set('connection-1:9', {
            clientId: 'client-1',
            capability,
            peerIdentity: 'remote-endpoint',
            peerProcessId: 'remote-process',
            peerEndpointId: 'remote-endpoint'
        });

        (controller as any).pruneReservations();
        await waitFor(() => destroyed.includes(9));

        assert.equal((controller as any).handleCapabilities.size, 0);
        assert.equal((controller as any).issuedSenderGrants.size, 0);
        await controller.close();
    });

    it('bounds expired capability churn and its reliable revocation backlog', async () => {
        let peerCloses = 0;
        const controller = new MeshSrpcLinkController<SrpcMeta, SrpcMeta>({
            meshKey: 'expired-capability-churn',
            requestTimeoutMs: 1_000,
            runtime: {
                onPeerClosed: () => () => {},
                requestPeer: async () => {
                    throw new Error('peer unavailable');
                },
                closePeer: () => {
                    peerCloses++;
                }
            } as any,
            service: { mesh: {} } as any,
            getLocalConnection: () => undefined,
            invokeLocal: async () => Buffer.alloc(0),
            reserveLocalSenderIds: () => [],
            writeLocalStream: async () => {},
            finishLocalStream: async () => {},
            destroyLocalStream: async () => {},
            attachLocalReceiver: () => {
                throw new Error('not needed');
            },
            disconnectLocal: async () => {},
            updateLocalMetadata: async () => {}
        });
        for (let index = 0; index < 8_193; index++) {
            const capability = `expired-capability-${String(index).padStart(12, '0')}`;
            (controller as any).handleCapabilities.set(capability, {
                clientId: 'client',
                connectionId: `connection-${index}`,
                capability,
                peerIdentity: 'peer-endpoint',
                peerProcessId: 'peer-process',
                peerEndpointId: 'peer-endpoint',
                expiresAt: 0
            });
        }

        (controller as any).pruneReservations();
        await new Promise(resolve => setImmediate(resolve));

        assert.equal((controller as any).handleCapabilities.size, 0);
        assert.ok((controller as any).terminalForwards.size <= 4_096);
        assert.ok(peerCloses > 0);

        (controller as any).terminalForwards.clear();
        await controller.close();
    });

    it('rejects oversized reservations before allocating sender routes', async () => {
        const owner = { id: 'connection-1', clientId: 'client-1' } as any;
        const controller = new MeshSrpcLinkController<SrpcMeta, SrpcMeta>({
            meshKey: 'reservation-limit',
            requestTimeoutMs: 1_000,
            runtime: { onPeerClosed: () => () => {} } as any,
            service: { mesh: { getNodes: async () => [{ processId: 'remote-peer' }] } } as any,
            getLocalConnection: () => owner,
            invokeLocal: async () => Buffer.alloc(0),
            reserveLocalSenderIds: () => {
                throw new Error('must not reserve');
            },
            writeLocalStream: async () => {},
            finishLocalStream: async () => {},
            destroyLocalStream: async () => {},
            attachLocalReceiver: () => {
                throw new Error('not needed');
            },
            disconnectLocal: async () => {},
            updateLocalMetadata: async () => {}
        });
        await assert.rejects(
            controller.route({ processId: 'remote-peer', connected: true } as any, {
                header: { type: 'reserveStreamIds', clientId: owner.clientId, connectionId: owner.id, count: 257 },
                body: Buffer.alloc(0)
            }),
            /reservation size/
        );
        assert.equal((controller as any).senderRoutes.size, 0);
    });

    it('does not create route state after closing during peer membership verification', async () => {
        let releaseMembership: (() => void) | undefined;
        const membershipBlocked = new Promise<void>(resolve => {
            releaseMembership = resolve;
        });
        const controller = new MeshSrpcLinkController<SrpcMeta, SrpcMeta>({
            meshKey: 'close-race',
            requestTimeoutMs: 1_000,
            runtime: { onPeerClosed: () => () => {} } as any,
            service: {
                mesh: {
                    getNodes: async () => {
                        await membershipBlocked;
                        return [{ processId: 'remote-peer', linkEndpointId: 'remote-endpoint' }];
                    }
                }
            } as any,
            getLocalConnection: () => ({ id: 'connection-1', clientId: 'client-1' }) as any,
            invokeLocal: async () => Buffer.alloc(0),
            reserveLocalSenderIds: () => [2],
            writeLocalStream: async () => {},
            finishLocalStream: async () => {},
            destroyLocalStream: async () => {},
            attachLocalReceiver: () => {
                throw new Error('not needed');
            },
            disconnectLocal: async () => {},
            updateLocalMetadata: async () => {}
        });
        const route = controller.route({ processId: 'remote-peer', endpointId: 'remote-endpoint', connected: true } as any, {
            header: {
                type: 'reserveStreamIds',
                version: 2,
                clientId: 'client-1',
                connectionId: 'connection-1',
                count: 1,
                reservationId: 'close-race-reservation-0001'
            },
            body: Buffer.alloc(0)
        });

        controller.close();
        releaseMembership!();

        await assert.rejects(route, /controller is closed/);
        assert.equal((controller as any).senderRoutes.size, 0);
    });

    it('does not let a later mutating frame share an older in-flight membership observation', async () => {
        let checks = 0;
        let live = true;
        let invokes = 0;
        let releaseMembership: (() => void) | undefined;
        const membershipBlocked = new Promise<void>(resolve => {
            releaseMembership = resolve;
        });
        const controller = new MeshSrpcLinkController<SrpcMeta, SrpcMeta>({
            meshKey: 'membership-singleflight',
            requestTimeoutMs: 1_000,
            runtime: { onPeerClosed: () => () => {} } as any,
            service: {
                mesh: {
                    getNodes: async () => {
                        checks++;
                        const observed = live ? [{ processId: 'remote-peer', linkEndpointId: 'remote-endpoint' }] : [];
                        if (checks === 1) await membershipBlocked;
                        return observed;
                    }
                }
            } as any,
            getLocalConnection: () => ({ id: 'connection-1', clientId: 'client-1' }) as any,
            invokeLocal: async () => {
                invokes++;
                return Buffer.from('ok');
            },
            reserveLocalSenderIds: () => [],
            writeLocalStream: async () => {},
            finishLocalStream: async () => {},
            destroyLocalStream: async () => {},
            attachLocalReceiver: () => {
                throw new Error('not needed');
            },
            disconnectLocal: async () => {},
            updateLocalMetadata: async () => {}
        });
        const peer = { processId: 'remote-peer', endpointId: 'remote-endpoint', connected: true } as any;
        const frame = {
            header: {
                type: 'reserveStreamIds' as const,
                version: 2,
                clientId: 'client-1',
                connectionId: 'connection-1',
                count: 1,
                reservationId: 'membership-singleflight-reservation-0001'
            },
            body: Buffer.alloc(0)
        };
        const first = controller.route(peer, frame);
        await waitFor(() => checks === 1);
        live = false;
        await assert.rejects(controller.route(peer, frame), /not a live member/);
        releaseMembership!();
        await first;
        assert.equal(checks, 2);
        assert.equal(invokes, 0);
    });

    it('does not retain routed authority after a peer is removed from mesh membership', async () => {
        let live = true;
        let checks = 0;
        let reservations = 0;
        const controller = new MeshSrpcLinkController<SrpcMeta, SrpcMeta>({
            meshKey: 'membership-removal',
            requestTimeoutMs: 1_000,
            runtime: { onPeerClosed: () => () => {} } as any,
            service: {
                mesh: {
                    getNodes: async () => (
                        checks++,
                        live ? [{ processId: 'remote-peer', linkEndpointId: 'remote-endpoint', linkProtocolMax: MeshLinkProtocolVersion }] : []
                    )
                }
            } as any,
            getLocalConnection: () => ({ id: 'connection-1', clientId: 'client-1' }) as any,
            invokeLocal: async () => Buffer.from('ok'),
            reserveLocalSenderIds: () => {
                reservations++;
                return [reservations * 2];
            },
            writeLocalStream: async () => {},
            finishLocalStream: async () => {},
            destroyLocalStream: async () => {},
            attachLocalReceiver: () => {
                throw new Error('not needed');
            },
            disconnectLocal: async () => {},
            updateLocalMetadata: async () => {}
        });
        const peer = {
            processId: 'remote-peer',
            endpointId: 'remote-endpoint',
            protocolVersion: MeshLinkProtocolVersion,
            connected: true
        } as any;
        const frame = {
            header: {
                type: 'reserveStreamIds' as const,
                version: MeshLinkProtocolVersion,
                clientId: 'client-1',
                connectionId: 'connection-1',
                count: 1,
                reservationId: 'membership-removal-reservation-0001'
            },
            body: Buffer.alloc(0)
        };
        await controller.route(peer, frame);
        live = false;
        await assert.rejects(controller.route(peer, frame), /not a live member/);
        assert.equal(checks, 2);
        assert.equal(reservations, 1);
        await controller.close();
    });

    it('allows remote receivers to absorb mesh relay pressure until their bounded buffer is full', async () => {
        let destroys = 0;
        const connection = new MeshRemoteSrpcConnection({
            id: 'remote-pressure',
            clientId: 'client-1',
            meta: {},
            connectedAt: Date.now(),
            ownerNodeId: 2,
            senderIds: [],
            transport: {
                reserveSenderIds: async () => [],
                disconnect: async () => {},
                writeStream: async () => {},
                finishStream: async () => {},
                destroyStream: async () => {
                    destroys++;
                },
                attachReceiver: async () => {}
            }
        });
        const receiver = SrpcByteStream.createReceiver(connection, 1);
        receiver.on('error', () => {});
        const chunk = Buffer.alloc(64 * 1024);
        assert.equal(connection.receiveWrite(1, chunk), true);
        assert.equal(destroys, 0);
        receiver.read();
        assert.equal(connection.receiveWrite(1, chunk), true);
        const receiverFinished = finished(receiver, { writable: false });
        connection.receiveFinish(1);
        receiver.resume();
        await receiverFinished;
        assert.equal(destroys, 0);

        const abusive = SrpcByteStream.createReceiver(connection, 3);
        abusive.on('error', () => {});
        for (let index = 0; index < 128; index++) {
            assert.equal(connection.receiveWrite(3, chunk), true);
        }
        assert.equal(connection.receiveWrite(3, chunk), false);
        assert.equal(destroys, 1);

        const acceptedChunk = Buffer.alloc(8 * 1024);
        for (let index = 0; index <= 1024; index++) {
            const streamId = 5 + index * 2;
            const tracked = SrpcByteStream.createReceiver(connection, streamId);
            tracked.on('error', () => {});
            assert.equal(connection.receiveWrite(streamId, acceptedChunk), index < 1024);
        }
        assert.equal(destroys, 2);
        connection.markStale();
    });

    it('marks remote byte-stream handles stale when pending receiver capacity is exhausted', () => {
        let releaseAttempts = 0;
        const createConnection = () =>
            new MeshRemoteSrpcConnection({
                id: 'remote-pending-capacity',
                clientId: 'client-1',
                meta: {},
                connectedAt: Date.now(),
                ownerNodeId: 2,
                senderIds: [2, 4],
                transport: {
                    reserveSenderIds: async () => [],
                    releaseSenderIds: () => {
                        releaseAttempts++;
                        throw new Error('adversarial synchronous sender release');
                    },
                    disconnect: async () => {},
                    writeStream: async () => {},
                    finishStream: async () => {},
                    destroyStream: async () => {},
                    attachReceiver: async () => {}
                }
            });
        for (const operation of ['write', 'finish', 'destroy'] as const) {
            const connection = createConnection();
            const expectedReleaseAttempts = releaseAttempts + 1;
            let throwingDisconnects = 0;
            connection.byteStream.attachDisconnectHandler(() => {
                throwingDisconnects++;
                throw new Error('adversarial disconnect handler');
            });
            const receivers = [SrpcByteStream.createReceiver(connection, 4097), SrpcByteStream.createReceiver(connection, 4099)];
            for (const receiver of receivers) receiver.on('error', () => {});
            for (let index = 0; index < 1024; index++) {
                const streamId = 1 + index * 2;
                if (operation === 'write') assert.equal(connection.receiveWrite(streamId, Buffer.alloc(0)), true);
                else if (operation === 'finish') connection.receiveFinish(streamId);
                else connection.receiveDestroy(streamId);
            }
            assert.throws(() => {
                if (operation === 'write') connection.receiveWrite(2049, Buffer.alloc(0));
                else if (operation === 'finish') connection.receiveFinish(2049);
                else connection.receiveDestroy(2049);
            }, /Too many pending sRPC byte stream receivers/);
            assert.equal(connection.connected, false);
            assert.equal(throwingDisconnects, 1);
            assert.deepEqual(
                receivers.map(receiver => receiver.destroyed),
                [true, true]
            );
            assert.equal(releaseAttempts, expectedReleaseAttempts);
            assert.throws(() => SrpcByteStream.createReceiver(connection, 4101), SrpcStaleConnectionError);
            connection.markStale();
            assert.equal(throwingDisconnects, 1);
            assert.equal(releaseAttempts, expectedReleaseAttempts);
        }
    });

    it('preserves absent and empty mesh byte-stream destroy reasons', async () => {
        const reasons: Array<string | undefined> = [];
        const controller = Object.create(MeshSrpcLinkController.prototype) as any;
        controller.options = { requestTimeoutMs: 1_000 };
        controller.requestOwner = async (_connection: unknown, header: { reason?: string }) => {
            reasons.push(header.reason);
            return { header: { type: 'result' }, body: Buffer.alloc(0) };
        };
        const connection = new MeshRemoteSrpcConnection({
            id: 'remote-destroy-reason',
            clientId: 'client-1',
            meta: {},
            connectedAt: Date.now(),
            ownerNodeId: 2,
            senderIds: [],
            transport: {
                reserveSenderIds: async () => [],
                disconnect: async () => {},
                writeStream: async () => {},
                finishStream: async () => {},
                destroyStream: async () => {},
                attachReceiver: async () => {}
            }
        });
        await controller.destroyStream(connection, 1);
        await controller.destroyStream(connection, 3, '');
        await controller.destroyStream(connection, 5, new Error(''));
        assert.deepEqual(reasons, [undefined, '', '']);
    });

    it('requires the authenticated endpoint for mesh-link membership', async () => {
        const controller = new MeshSrpcLinkController<SrpcMeta, SrpcMeta>({
            meshKey: 'membership-endpoint',
            requestTimeoutMs: 1_000,
            runtime: { onPeerClosed: () => () => {} } as any,
            service: {
                mesh: { getNodes: async () => [{ processId: 'remote-peer', linkEndpointId: 'live-endpoint' }] }
            } as any,
            getLocalConnection: () => ({ id: 'connection-1', clientId: 'client-1' }) as any,
            invokeLocal: async () => Buffer.from('ok'),
            reserveLocalSenderIds: () => [],
            writeLocalStream: async () => {},
            finishLocalStream: async () => {},
            destroyLocalStream: async () => {},
            attachLocalReceiver: () => {
                throw new Error('not needed');
            },
            disconnectLocal: async () => {},
            updateLocalMetadata: async () => {}
        });
        const peer = { processId: 'remote-peer', endpointId: 'other-endpoint', connected: true } as any;
        const request = { type: 'invoke' as const, clientId: 'client-1', connectionId: 'connection-1', prefix: 'dTest' };

        await assert.rejects(controller.route(peer, { header: { ...request, version: 2 }, body: Buffer.alloc(0) }), /not a live member/);
        controller.close();
    });

    it('propagates unexpected list resolution failures instead of returning a partial list', async () => {
        const record: RegisteredClient<SrpcMeta> = {
            clientId: 'client-1',
            nodeId: 2,
            connectionId: 'connection-1',
            connectedAt: Date.now(),
            metadata: {}
        };
        const controller = new MeshSrpcLinkController<SrpcMeta, SrpcMeta>({
            meshKey: 'list-errors',
            requestTimeoutMs: 1_000,
            runtime: {
                onPeerClosed: () => () => {},
                request: async () => {
                    throw new Error('transport failed');
                }
            } as any,
            service: {
                clientRegistry: {
                    listClients: async () => [record],
                    getClient: async () => record
                },
                mesh: {
                    getNode: async () => ({
                        instanceId: 2,
                        processId: 'owner-process',
                        linkEndpointId: 'owner-endpoint',
                        linkEndpointPublicKey: 'example-public-key',
                        linkUrl: 'ws://example.test/mesh'
                    })
                }
            } as any,
            getLocalConnection: () => undefined,
            invokeLocal: async () => Buffer.alloc(0),
            reserveLocalSenderIds: () => [],
            writeLocalStream: async () => {},
            finishLocalStream: async () => {},
            destroyLocalStream: async () => {},
            attachLocalReceiver: () => {
                throw new Error('not needed');
            },
            disconnectLocal: async () => {},
            updateLocalMetadata: async () => {}
        });

        await assert.rejects(controller.listClients(), /transport failed/);
    });

    it('does not return a stale local handle for a newer registry generation', async () => {
        const local = { id: 'connection-1', clientId: 'client-1', meta: { role: 'local' } } as any;
        const record: RegisteredClient<SrpcMeta> = {
            clientId: 'client-1',
            nodeId: 2,
            connectionId: 'connection-2',
            connectedAt: Date.now(),
            metadata: { role: 'remote' }
        };
        const controller = new MeshSrpcLinkController<SrpcMeta, SrpcMeta>({
            meshKey: 'list-generation-fence',
            requestTimeoutMs: 1_000,
            runtime: {
                onPeerClosed: () => () => {},
                request: async () => ({
                    header: { type: 'result', ids: [2], capability: 'test-capability-000000000000000001' },
                    body: Buffer.alloc(0)
                })
            } as any,
            service: {
                clientRegistry: { listClients: async () => [record], getClient: async () => record },
                mesh: {
                    getNode: async () => ({
                        instanceId: 2,
                        processId: 'owner-process',
                        linkEndpointId: 'owner-endpoint',
                        linkUrl: 'ws://example.test/mesh',
                        linkEndpointPublicKey: 'example-public-key'
                    })
                }
            } as any,
            getLocalConnection: () => local,
            invokeLocal: async () => Buffer.alloc(0),
            reserveLocalSenderIds: () => [],
            writeLocalStream: async () => {},
            finishLocalStream: async () => {},
            destroyLocalStream: async () => {},
            attachLocalReceiver: () => {
                throw new Error('not needed');
            },
            disconnectLocal: async () => {},
            updateLocalMetadata: async () => {}
        });

        const [resolved] = await controller.listClients();
        assert.notStrictEqual(resolved, local);
        assert.equal(resolved.id, 'connection-2');
        controller.close();
    });

    it('does not resolve a stale local handle for a newer registry generation', async () => {
        const local = { id: 'connection-1', clientId: 'client-1', meta: { role: 'local' } } as any;
        const record: RegisteredClient<SrpcMeta> = {
            clientId: 'client-1',
            nodeId: 2,
            connectionId: 'connection-2',
            connectedAt: Date.now(),
            metadata: { role: 'remote' }
        };
        const controller = new MeshSrpcLinkController<SrpcMeta, SrpcMeta>({
            meshKey: 'resolve-generation-fence',
            requestTimeoutMs: 1_000,
            runtime: {
                onPeerClosed: () => () => {},
                request: async () => ({
                    header: {
                        type: 'result',
                        ids: [2],
                        capability: 'test-capability-000000000000000002',
                        reservationId: 'test-reservation-000000000000000002'
                    },
                    body: Buffer.alloc(0)
                })
            } as any,
            service: {
                clientRegistry: { listClients: async () => [record], getClient: async () => record },
                mesh: {
                    getNode: async () => ({
                        instanceId: 2,
                        processId: 'owner-process',
                        linkEndpointId: 'owner-endpoint',
                        linkUrl: 'ws://example.test/mesh',
                        linkEndpointPublicKey: 'example-public-key'
                    })
                }
            } as any,
            getLocalConnection: () => local,
            invokeLocal: async () => Buffer.alloc(0),
            reserveLocalSenderIds: () => [],
            writeLocalStream: async () => {},
            finishLocalStream: async () => {},
            destroyLocalStream: async () => {},
            attachLocalReceiver: () => {
                throw new Error('not needed');
            },
            disconnectLocal: async () => {},
            updateLocalMetadata: async () => {}
        });

        const resolved = await controller.resolveClient(record.clientId);
        assert.notStrictEqual(resolved, local);
        assert.equal(resolved?.id, record.connectionId);
        controller.close();
    });

    it('destroys a remote receiver tunnel when its buffered bytes exceed capacity', async () => {
        let destroyed = 0;
        const connection = new MeshRemoteSrpcConnection({
            id: 'connection-1',
            clientId: 'client-1',
            meta: { role: 'remote' },
            connectedAt: Date.now(),
            ownerNodeId: 2,
            senderIds: [],
            transport: {
                reserveSenderIds: async () => [],
                disconnect: async () => {},
                writeStream: async () => {},
                finishStream: async () => {},
                destroyStream: async () => {
                    destroyed++;
                },
                attachReceiver: async () => {}
            }
        });
        const receiver = SrpcByteStream.createReceiver(connection, 7);
        receiver.once('error', () => {});
        let accepted = true;
        const chunk = Buffer.alloc(64 * 1024);
        for (let index = 0; index < 129 && accepted; index++) {
            accepted = connection.receiveWrite(7, chunk);
        }
        await waitFor(() => destroyed === 1);
        assert.equal(accepted, false);
        assert.equal(receiver.destroyed, true);
    });

    it('fences and detaches a remote handle when sender activation fails', async () => {
        const connection = new MeshRemoteSrpcConnection({
            id: 'activation-connection',
            clientId: 'activation-client',
            meta: {},
            connectedAt: Date.now(),
            ownerNodeId: 2,
            senderIds: [2],
            transport: {
                reserveSenderIds: async () => [],
                disconnect: async () => {},
                writeStream: async () => {},
                finishStream: async () => {},
                destroyStream: async () => {},
                attachReceiver: async () => {},
                activateSender: async () => {
                    throw new Error('activation rejected');
                }
            }
        });
        const sender = SrpcByteStream.createSender(connection);
        await waitFor(() => !connection.connected && sender.destroyed);

        assert.equal((connection as any).disconnectHandlers.size, 0);
        assert.equal(SrpcByteStream.hasSender(connection, sender.id), false);
    });

    it('retries sender-ID refills after a transient refill failure', async () => {
        let refills = 0;
        const connection = new MeshRemoteSrpcConnection({
            id: 'connection-1',
            clientId: 'client-1',
            meta: {},
            connectedAt: Date.now(),
            ownerNodeId: 2,
            senderIds: [2],
            transport: {
                reserveSenderIds: async () => {
                    refills++;
                    if (refills === 1) throw new Error('temporary refill failure');
                    return [refills * 2];
                },
                disconnect: async () => {},
                writeStream: async () => {},
                finishStream: async () => {},
                destroyStream: async () => {},
                attachReceiver: async () => {}
            }
        });

        const first = SrpcByteStream.createSender(connection);
        first.end();
        await finished(first, { readable: false });
        await waitFor(() => refills === 1 && !(connection as any).refillPending);
        const existingDisconnectHandlers = (connection as any).disconnectHandlers.size;
        assert.throws(() => SrpcByteStream.createSender(connection), /No reserved/);
        assert.equal((connection as any).disconnectHandlers.size, existingDisconnectHandlers);
        await waitFor(() => refills === 2 && (connection as any).senderIds.length === 1);
        const retried = SrpcByteStream.createSender(connection);
        assert.equal(retried.id, 4);
        retried.end();
        await finished(retried, { readable: false });
    });

    it('releases active and unused sender IDs when a remote handle becomes stale', async () => {
        const released: number[][] = [];
        const connection = new MeshRemoteSrpcConnection({
            id: 'connection-1',
            clientId: 'client-1',
            meta: {},
            connectedAt: Date.now(),
            ownerNodeId: 2,
            senderIds: [2, 4],
            transport: {
                reserveSenderIds: async () => [],
                releaseSenderIds: async (_connection, ids) => {
                    released.push(ids);
                },
                disconnect: async () => {},
                writeStream: async () => {},
                finishStream: async () => {},
                destroyStream: async () => {},
                attachReceiver: async () => {}
            }
        });
        SrpcByteStream.createSender(connection);
        connection.markStale();
        await waitFor(() => released.length === 1);
        assert.deepEqual(new Set(released[0]), new Set([2, 4]));
    });

    it('retries failed cold resolutions and fences invalidated in-flight resolutions', async () => {
        const record: RegisteredClient<SrpcMeta> = {
            clientId: 'client-1',
            nodeId: 2,
            connectionId: 'connection-1',
            connectedAt: Date.now(),
            metadata: { role: 'remote' }
        };
        let calls = 0;
        let releaseFirst: ((value: any) => void) | undefined;
        const firstResponse = new Promise<any>(resolve => {
            releaseFirst = resolve;
        });
        const controller = new MeshSrpcLinkController<SrpcMeta, SrpcMeta>({
            meshKey: 'single-flight',
            requestTimeoutMs: 1_000,
            runtime: {
                onPeerClosed: () => () => {},
                request: async () => {
                    calls++;
                    if (calls === 1) return firstResponse;
                    if (calls === 4) throw new Error('temporary link failure');
                    return { header: { type: 'result', ids: [2], capability: 'test-capability-000000000000000001' }, body: Buffer.alloc(0) };
                }
            } as any,
            service: {
                clientRegistry: { getClient: async () => record },
                mesh: {
                    getNode: async () => ({
                        instanceId: 2,
                        processId: 'owner-process',
                        linkEndpointId: 'owner-endpoint',
                        linkEndpointPublicKey: 'example-public-key',
                        linkUrl: 'ws://example.test/mesh'
                    })
                }
            } as any,
            getLocalConnection: () => undefined,
            invokeLocal: async () => Buffer.alloc(0),
            reserveLocalSenderIds: () => [],
            writeLocalStream: async () => {},
            finishLocalStream: async () => {},
            destroyLocalStream: async () => {},
            attachLocalReceiver: () => {
                throw new Error('not needed');
            },
            disconnectLocal: async () => {},
            updateLocalMetadata: async () => {}
        });

        const pending = controller.resolveClient(record.clientId);
        await waitFor(() => calls === 1);
        controller.invalidateConnection(record.clientId, record.connectionId!);
        releaseFirst!({ header: { type: 'result', ids: [2], capability: 'test-capability-000000000000000001' }, body: Buffer.alloc(0) });
        await assert.rejects(pending, SrpcStaleConnectionError);
        await assert.rejects(controller.resolveClient(record.clientId), /temporary link failure/);
        const resolved = await controller.resolveClient(record.clientId);
        assert.ok(resolved);
        assert.strictEqual(await controller.resolveClient(record.clientId), resolved);
    });

    it('evicts superseded generations and idle remote handles from the cache', async () => {
        const records = new Map<string, RegisteredClient<SrpcMeta>>();
        const firstRecord: RegisteredClient<SrpcMeta> = {
            clientId: 'client-1',
            nodeId: 2,
            connectionId: 'connection-1',
            connectedAt: 1,
            metadata: { generation: 1 }
        };
        records.set(firstRecord.clientId, firstRecord);
        let nextId = 2;
        const controller = new MeshSrpcLinkController<SrpcMeta, SrpcMeta>({
            meshKey: 'cache-pruning',
            requestTimeoutMs: 1_000,
            runtime: {
                onPeerClosed: () => () => {},
                request: async () => {
                    const id = nextId;
                    nextId += 2;
                    return { header: { type: 'result', ids: [id], capability: 'test-capability-000000000000000001' }, body: Buffer.alloc(0) };
                }
            } as any,
            service: {
                clientRegistry: {
                    getClient: async (clientId: string) => records.get(clientId),
                    listClients: async () => [...records.values()]
                },
                mesh: {
                    getNode: async () => ({
                        instanceId: 2,
                        processId: 'owner-process',
                        linkEndpointId: 'owner-endpoint',
                        linkEndpointPublicKey: 'example-public-key',
                        linkUrl: 'ws://example.test/mesh'
                    })
                }
            } as any,
            getLocalConnection: () => undefined,
            invokeLocal: async () => Buffer.alloc(0),
            reserveLocalSenderIds: () => [],
            writeLocalStream: async () => {},
            finishLocalStream: async () => {},
            destroyLocalStream: async () => {},
            attachLocalReceiver: () => {
                throw new Error('not needed');
            },
            disconnectLocal: async () => {},
            updateLocalMetadata: async () => {}
        });

        const first = (await controller.resolveClient('client-1')) as MeshRemoteSrpcConnection<SrpcMeta>;
        records.set('client-1', {
            ...firstRecord,
            connectionId: 'connection-2',
            connectedAt: 2,
            metadata: { generation: 2 }
        });
        const replacement = (await controller.resolveClient('client-1')) as MeshRemoteSrpcConnection<SrpcMeta>;
        assert.equal(first.connected, false);
        assert.equal(replacement.id, 'connection-2');
        assert.equal((controller as any).remoteConnections.size, 1);

        (replacement as any).lastUsedAt = 0;
        records.set('client-2', {
            clientId: 'client-2',
            nodeId: 2,
            connectionId: 'connection-3',
            connectedAt: 3,
            metadata: {}
        });
        await controller.resolveClient('client-2');
        assert.equal(replacement.connected, false);
        assert.equal((controller as any).remoteConnections.size, 1);
    });
});

function fakeService(instanceId: number, records: Map<string, RegisteredClient<SrpcMeta>>, nodes: Map<number, any>): any {
    return {
        clientRegistry: {
            getClient: async (clientId: string) => records.get(clientId),
            listClients: async () => [...records.values()]
        },
        mesh: {
            instanceId,
            getNode: async (nodeId: number) => nodes.get(nodeId),
            getNodes: async () => [...nodes.values()]
        }
    };
}

function createByteParent(id: string): IByteStreamable {
    const disconnectHandlers = new Set<() => void>();
    const parent: IByteStreamable = {
        byteStream: {
            parentStreamId: id,
            write: () => {},
            finish: () => {},
            destroy: () => {},
            attachDisconnectHandler: handler => disconnectHandlers.add(handler),
            detachDisconnectHandler: handler => disconnectHandlers.delete(handler),
            getBufferedAmount: () => 0
        }
    };
    SrpcByteStream.init(parent, { startId: 2, step: 2 });
    return parent;
}

async function listen(): Promise<Server> {
    const server = createServer();
    installUpgradeClaimHandling(server);
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    servers.push(server);
    return server;
}

function runtime(httpServer: Server): ReturnType<typeof acquireMeshLinkRuntime> {
    const value = acquireMeshLinkRuntime({
        path,
        secret,
        httpServer,
        connectTimeoutMs: 1_000,
        idleTimeoutMs: 10_000,
        maxFrameBytes: 1024 * 1024,
        maxBufferedBytes: 1024 * 1024
    });
    runtimes.push(value);
    return value;
}

function url(server: Server): string {
    return `ws://127.0.0.1:${(server.address() as AddressInfo).port}${path}`;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error('Timed out waiting for condition');
        await new Promise(resolve => setTimeout(resolve, 5));
    }
}
