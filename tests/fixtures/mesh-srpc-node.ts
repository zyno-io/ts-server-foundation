import type { AddressInfo } from 'node:net';

import { type BaseMessage, createApp, createLogger, getMeshLinkProcessId, MeshSrpcServer, type SrpcMessageFns } from '../../src';

interface FixtureMessage extends BaseMessage {
    dEchoRequest?: { value: string };
    dEchoResponse?: { value: string; node: string };
}

interface ClientMetadata {
    role: string;
    secret?: string;
}

const JsonMessage: SrpcMessageFns<FixtureMessage> = {
    encode(message) {
        return Buffer.from(JSON.stringify(message));
    },
    decode(input) {
        return JSON.parse(Buffer.from(input).toString('utf8')) as FixtureMessage;
    }
};

const meshKey = requiredEnvironment('TSF_MESH_KEY');
const meshSecret = requiredEnvironment('TSF_MESH_SECRET');
const clientPath = requiredEnvironment('TSF_MESH_CLIENT_PATH');
const meshPath = requiredEnvironment('TSF_MESH_LINK_PATH');

void start().catch(error => {
    send({ type: 'error', error: serializeError(error) });
    process.exitCode = 1;
    setImmediate(() => process.exit());
});

async function start(): Promise<void> {
    const app = createApp({ enableHealthcheck: false });
    const server = new MeshSrpcServer<ClientMetadata, FixtureMessage, FixtureMessage, { role: string }>({
        logger: createLogger('MeshSrpcProcessFixture'),
        clientMessage: JsonMessage,
        serverMessage: JsonMessage,
        wsPath: clientPath,
        meshKey,
        meshOptions: {
            heartbeatIntervalMs: 500,
            nodeTtlMs: 8_000,
            leaderOptions: { ttlMs: 1_000, renewalIntervalMs: 250, retryDelayMs: 150 }
        },
        meshLink: { secret: meshSecret, path: meshPath },
        extractRegistryMetadata: stream => ({ role: stream.meta.role }),
        autoLifecycle: false
    });
    server.setClientAuthorizer(() => true);
    const httpServer = await app.http.listen(0, '127.0.0.1');
    await server.meshStart();
    const address = httpServer.address() as AddressInfo;
    send({
        type: 'ready',
        port: address.port,
        nodeId: server.meshInstanceId,
        meshProcessId: getMeshLinkProcessId(),
        osPid: process.pid
    });

    let stopping = false;
    process.on('message', message => {
        if (!isRecord(message) || message.type !== 'stop' || stopping) return;
        stopping = true;
        void (async () => {
            try {
                await server.meshStop();
                server.close();
                await app.http.close();
                await app.stop();
                send({ type: 'stopped' });
                setImmediate(() => process.exit(0));
            } catch (error) {
                send({ type: 'error', error: serializeError(error) });
                setImmediate(() => process.exit(1));
            }
        })();
    });
}

function requiredEnvironment(name: string): string {
    const value = process.env[name];
    if (!value) throw new Error(`Missing ${name}`);
    return value;
}

function send(message: Record<string, unknown>): void {
    process.send?.(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function serializeError(error: unknown): string {
    return error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ''}` : String(error);
}
