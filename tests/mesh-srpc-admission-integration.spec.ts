import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';

import { type BaseMessage, createApp, createLogger, MeshSrpcServer, SrpcClient, type SrpcMessageFns, type SrpcMeta } from '../src';

const redisSkip = process.env.REDIS_HOST ? false : 'set REDIS_HOST to run Redis-backed mesh admission integration tests';
const meshSecret = 'mesh-admission-integration-secret';

const JsonMessage: SrpcMessageFns<BaseMessage> = {
    encode(message) {
        return Buffer.from(JSON.stringify(message));
    },
    decode(input) {
        return JSON.parse(Buffer.from(input).toString('utf8')) as BaseMessage;
    }
};

describe('MeshSrpcServer admission readiness', { skip: redisSkip }, () => {
    it('does not create or publish a stream until mesh startup completes', async () => {
        const originalPodIp = process.env.POD_IP;
        process.env.POD_IP = '127.0.0.1';
        const app = createApp({ enableHealthcheck: false });
        const server = new GatedMeshSrpcServer({
            logger: createLogger('GatedMeshSrpcAdmission'),
            clientMessage: JsonMessage,
            serverMessage: JsonMessage,
            wsPath: '/mesh-admission',
            meshKey: `mesh-admission-${randomUUID()}`,
            meshLink: { secret: meshSecret, path: '/_tsf/mesh-admission' },
            autoLifecycle: false
        });
        server.setClientAuthorizer(() => true);
        let connected = 0;
        let disconnected = 0;
        server.onClientConnected(() => {
            connected++;
        });
        server.onClientDisconnected(() => {
            disconnected++;
        });
        const httpServer = await app.http.listen(0, '127.0.0.1');
        const port = (httpServer.address() as AddressInfo).port;
        const client = new SrpcClient<BaseMessage, BaseMessage>(
            createLogger('GatedMeshSrpcAdmissionClient'),
            `ws://127.0.0.1:${port}/mesh-admission`,
            JsonMessage,
            JsonMessage,
            'gated-client',
            { role: 'gated' },
            'unused',
            { enableReconnect: false, connectTimeoutMs: 5_000 }
        );

        try {
            let settled = false;
            const connecting = client.connect().finally(() => {
                settled = true;
            });
            await server.startReached.promise;
            await new Promise<void>(resolve => setImmediate(resolve));

            assert.equal(settled, false);
            assert.equal((await server.getLocalStreams()).length, 0);
            assert.equal(server.pendingStreamCount, 0);
            assert.equal(await server.getRegisteredClient('gated-client'), undefined);
            assert.equal(connected, 0);
            assert.equal(disconnected, 0);

            server.releaseStart();
            await connecting;
            await waitFor(async () => (await server.getRegisteredClient('gated-client')) !== undefined);
            assert.equal((await server.getLocalStreams()).length, 1);
            assert.equal(server.pendingStreamCount, 0);
            assert.equal(connected, 1);
            assert.equal(disconnected, 0);
        } finally {
            client.disconnect();
            await server.meshStop().catch(() => {});
            server.close();
            await app.http.close();
            await app.stop();
            if (originalPodIp === undefined) delete process.env.POD_IP;
            else process.env.POD_IP = originalPodIp;
        }
    });

    it('rejects an authenticated WebSocket when mesh startup fails without publishing any client state', async () => {
        const app = createApp({ enableHealthcheck: false });
        const wsPath = '/mesh-startup-failure';
        const server = new MeshSrpcServer({
            logger: createLogger('FailedMeshSrpcAdmission'),
            clientMessage: JsonMessage,
            serverMessage: JsonMessage,
            wsPath,
            meshKey: `mesh-startup-failure-${randomUUID()}`,
            meshLink: { secret: meshSecret, path: wsPath },
            autoLifecycle: false
        });
        server.setClientAuthorizer(() => true);
        let connected = 0;
        let disconnected = 0;
        server.onClientConnected(() => {
            connected++;
        });
        server.onClientDisconnected(() => {
            disconnected++;
        });
        const httpServer = await app.http.listen(0, '127.0.0.1');
        const port = (httpServer.address() as AddressInfo).port;
        const client = new SrpcClient<BaseMessage, BaseMessage>(
            createLogger('FailedMeshSrpcAdmissionClient'),
            `ws://127.0.0.1:${port}${wsPath}`,
            JsonMessage,
            JsonMessage,
            'failed-client',
            {},
            'unused',
            { enableReconnect: false, connectTimeoutMs: 2_000 }
        );

        try {
            await assert.rejects(client.connect());
            assert.equal((await server.getLocalStreams()).length, 0);
            assert.equal(await server.getRegisteredClient('failed-client'), undefined);
            assert.equal(connected, 0);
            assert.equal(disconnected, 0);
            assert.equal(server.startupState, 'stopped');
        } finally {
            client.disconnect();
            await server.meshStop().catch(() => {});
            server.close();
            await app.http.close();
            await app.stop();
        }
    });
});

class GatedMeshSrpcServer extends MeshSrpcServer<SrpcMeta, BaseMessage, BaseMessage, { role: string }> {
    readonly startReached = createDeferred<void>();
    private readonly startGate = createDeferred<void>();

    get pendingStreamCount(): number {
        return this.pendingStreamsByClientId.size;
    }

    releaseStart(): void {
        this.startGate.resolve();
    }

    override async meshStart(): Promise<void> {
        this.startReached.resolve();
        await this.startGate.promise;
        return super.meshStart();
    }
}

function createDeferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 3_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await predicate())) {
        if (Date.now() >= deadline) throw new Error('Timed out waiting for condition');
        await new Promise<void>(resolve => setTimeout(resolve, 10));
    }
}
