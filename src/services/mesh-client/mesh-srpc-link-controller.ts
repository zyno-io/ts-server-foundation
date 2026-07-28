import type { SrpcByteStream } from '../../srpc/SrpcByteStream';
import {
    SrpcClientNotFoundError,
    SrpcError,
    SrpcStaleConnectionError,
    SrpcMeshAuthenticationError,
    type SrpcConnection,
    type SrpcMeta,
    type SrpcStream
} from '../../srpc/types';
import type { MeshLinkFrame, MeshLinkFrameHeader } from '../mesh-link';
import { MeshLinkPeer, MeshLinkRuntime } from '../mesh-link';
import type { MeshClientService } from './mesh-client-service';
import { MeshRemoteSrpcConnection, type MeshRemoteConnectionTransport } from './mesh-srpc-remote-connection';
import type { RegisteredClient } from './types';

const SenderIdReservationSize = 256;

export interface MeshSrpcLinkControllerOptions<TMeta extends SrpcMeta, TRegistryMeta> {
    meshKey: string;
    requestTimeoutMs: number;
    runtime: MeshLinkRuntime;
    service: MeshClientService<TRegistryMeta, Record<string, unknown>>;
    getLocalConnection(clientId: string): SrpcStream<TMeta> | undefined;
    invokeLocal(clientId: string, connectionId: string, prefix: string, data: Uint8Array, timeoutMs: number): Promise<Uint8Array>;
    reserveLocalSenderIds(clientId: string, connectionId: string, count: number): number[];
    writeLocalStream(clientId: string, connectionId: string, streamId: number, data: Uint8Array): Promise<void>;
    finishLocalStream(clientId: string, connectionId: string, streamId: number): Promise<void>;
    destroyLocalStream(clientId: string, connectionId: string, streamId: number, error?: string): Promise<void>;
    attachLocalReceiver(clientId: string, connectionId: string, streamId: number): SrpcByteStream;
    disconnectLocal(clientId: string, connectionId: string, reason?: string): Promise<void>;
    updateLocalMetadata(clientId: string, connectionId: string, metadata: TRegistryMeta): Promise<void>;
}

export class MeshSrpcLinkController<TMeta extends SrpcMeta, TRegistryMeta> implements MeshRemoteConnectionTransport<TMeta> {
    private readonly remoteConnections = new Map<string, MeshRemoteSrpcConnection<TMeta>>();
    private readonly senderRoutes = new Map<string, { peer: MeshLinkPeer; clientId: string }>();
    private readonly attachedReceivers = new Map<string, SrpcByteStream>();
    private readonly verifiedPeers = new WeakSet<MeshLinkPeer>();
    private readonly unregisterPeerCloseHandler: () => void;

    constructor(private readonly options: MeshSrpcLinkControllerOptions<TMeta, TRegistryMeta>) {
        this.unregisterPeerCloseHandler = options.runtime.onPeerClosed(processId => {
            for (const connection of this.remoteConnections.values()) {
                if (connection.ownerProcessId === processId) this.invalidate(connection);
            }
            for (const [key, route] of this.senderRoutes) {
                if (route.peer.processId === processId) this.senderRoutes.delete(key);
            }
        });
    }

    close(): void {
        this.unregisterPeerCloseHandler();
        for (const connection of this.remoteConnections.values()) connection.markStale();
        this.remoteConnections.clear();
        for (const receiver of this.attachedReceivers.values()) receiver.destroy(new Error('sRPC mesh link stopped'));
        this.attachedReceivers.clear();
        this.senderRoutes.clear();
    }

    async resolveClient(clientId: string): Promise<SrpcConnection<TMeta> | undefined> {
        const local = this.options.getLocalConnection(clientId);
        if (local) return local;

        const record = await this.options.service.clientRegistry.getClient(clientId);
        if (!record) return undefined;
        return this.resolveRegisteredClient(record);
    }

    async listClients(): Promise<SrpcConnection<TMeta>[]> {
        const records = await this.options.service.clientRegistry.listClients();
        const clients = await Promise.all(
            records.map(async record => {
                const local = this.options.getLocalConnection(record.clientId);
                if (local && (!record.connectionId || record.connectionId === local.id)) return local;
                try {
                    return await this.resolveRegisteredClient(record);
                } catch {
                    return undefined;
                }
            })
        );
        return clients.flatMap(client => (client ? [client as SrpcConnection<TMeta>] : []));
    }

    async invoke(connection: SrpcConnection<TMeta>, prefix: string, data: Uint8Array, timeoutMs: number): Promise<Uint8Array> {
        const local = this.options.getLocalConnection(connection.clientId);
        if (local === connection) return this.options.invokeLocal(connection.clientId, connection.id, prefix, data, timeoutMs);
        if (!(connection instanceof MeshRemoteSrpcConnection)) throw new SrpcStaleConnectionError(connection.clientId);
        await this.assertCurrent(connection);
        const frame = await this.requestOwner(connection, { type: 'invoke', prefix, timeoutMs }, data, timeoutMs);
        if (frame.header.errorName === 'SrpcError')
            throw new SrpcError(frame.header.error ?? 'Remote sRPC invocation failed', frame.header.userError);
        return frame.body;
    }

    async disconnect(connection: MeshRemoteSrpcConnection<TMeta>, reason?: string): Promise<void> {
        await this.assertCurrent(connection);
        await this.requestOwner(connection, { type: 'disconnect', reason }, new Uint8Array(), this.options.requestTimeoutMs);
        this.invalidate(connection);
    }

    async reserveSenderIds(connection: MeshRemoteSrpcConnection<TMeta>): Promise<number[]> {
        await this.assertCurrent(connection);
        const response = await this.requestOwner(
            connection,
            { type: 'reserveStreamIds', count: SenderIdReservationSize },
            new Uint8Array(),
            this.options.requestTimeoutMs
        );
        return response.header.ids ?? [];
    }

    async updateMetadata(connection: MeshRemoteSrpcConnection<TMeta>, metadata: TRegistryMeta): Promise<void> {
        await this.assertCurrent(connection);
        await this.requestOwner(connection, { type: 'updateMetadata' }, Buffer.from(JSON.stringify(metadata)), this.options.requestTimeoutMs);
    }

    async writeStream(connection: MeshRemoteSrpcConnection<TMeta>, streamId: number, data: Uint8Array): Promise<void> {
        await this.assertCurrent(connection);
        await this.requestOwner(connection, { type: 'streamWrite', streamId }, data, this.options.requestTimeoutMs);
    }

    async finishStream(connection: MeshRemoteSrpcConnection<TMeta>, streamId: number): Promise<void> {
        await this.assertCurrent(connection);
        await this.requestOwner(connection, { type: 'streamFinish', streamId }, new Uint8Array(), this.options.requestTimeoutMs);
    }

    async destroyStream(connection: MeshRemoteSrpcConnection<TMeta>, streamId: number, error?: unknown): Promise<void> {
        if (!connection.connected) return;
        await this.requestOwner(
            connection,
            { type: 'streamDestroy', streamId, reason: error ? String(error) : undefined },
            new Uint8Array(),
            this.options.requestTimeoutMs
        );
    }

    async attachReceiver(connection: MeshRemoteSrpcConnection<TMeta>, streamId: number): Promise<void> {
        await this.assertCurrent(connection);
        await this.requestOwner(connection, { type: 'streamAttach', streamId }, new Uint8Array(), this.options.requestTimeoutMs);
    }

    async route(peer: MeshLinkPeer, frame: MeshLinkFrame): Promise<MeshLinkFrame> {
        if (!this.verifiedPeers.has(peer)) {
            const nodes = await this.options.service.mesh.getNodes();
            if (!nodes.some(node => node.processId === peer.processId)) {
                throw new SrpcMeshAuthenticationError('sRPC mesh peer is not a live member of this mesh');
            }
            this.verifiedPeers.add(peer);
        }
        const header = frame.header;
        const clientId = requiredString(header.clientId, 'clientId');
        const connectionId = requiredString(header.connectionId, 'connectionId');
        const streamId = header.streamId;
        const local = this.options.getLocalConnection(clientId);

        switch (header.type) {
            case 'invoke':
                return {
                    header: { type: 'result' },
                    body: Buffer.from(
                        await this.options.invokeLocal(
                            clientId,
                            connectionId,
                            requiredString(header.prefix, 'prefix'),
                            frame.body,
                            header.timeoutMs ?? 30_000
                        )
                    )
                };
            case 'reserveStreamIds': {
                const count = header.count ?? SenderIdReservationSize;
                const ids = this.options.reserveLocalSenderIds(clientId, connectionId, count);
                for (const id of ids) this.senderRoutes.set(routeKey(connectionId, id), { peer, clientId });
                return emptyResult({ ids });
            }
            case 'streamWrite':
                requireStreamId(streamId);
                if (local?.id === connectionId) {
                    await this.options.writeLocalStream(clientId, connectionId, streamId!, frame.body);
                } else {
                    this.getRemoteConnection(clientId, connectionId).receiveWrite(streamId!, frame.body);
                }
                return emptyResult();
            case 'streamFinish':
                requireStreamId(streamId);
                if (local?.id === connectionId) {
                    await this.options.finishLocalStream(clientId, connectionId, streamId!);
                } else {
                    this.getRemoteConnection(clientId, connectionId).receiveFinish(streamId!);
                }
                return emptyResult();
            case 'streamDestroy':
                requireStreamId(streamId);
                if (local?.id === connectionId) {
                    const key = routeKey(connectionId, streamId!);
                    this.senderRoutes.delete(key);
                    const attached = this.attachedReceivers.get(key);
                    if (attached) {
                        this.attachedReceivers.delete(key);
                        attached.destroy(header.reason ? new Error(header.reason) : undefined);
                    } else {
                        await this.options.destroyLocalStream(clientId, connectionId, streamId!, header.reason);
                    }
                } else {
                    this.getRemoteConnection(clientId, connectionId).receiveDestroy(streamId!, header.reason);
                }
                return emptyResult();
            case 'streamAttach':
                requireStreamId(streamId);
                this.attachLocalReceiver(peer, clientId, connectionId, streamId!);
                return emptyResult();
            case 'disconnect':
                await this.options.disconnectLocal(clientId, connectionId, header.reason);
                return emptyResult();
            case 'updateMetadata':
                await this.options.updateLocalMetadata(clientId, connectionId, JSON.parse(frame.body.toString('utf8')) as TRegistryMeta);
                return emptyResult();
            default:
                throw new Error(`Unsupported sRPC mesh operation: ${header.type}`);
        }
    }

    forwardClientDestroy(connectionId: string, streamId: number, error?: string): boolean {
        const key = routeKey(connectionId, streamId);
        const route = this.senderRoutes.get(key);
        if (!route) return false;
        this.senderRoutes.delete(key);
        void route.peer
            .request(
                {
                    type: 'streamDestroy',
                    meshKey: this.options.meshKey,
                    clientId: route.clientId,
                    connectionId,
                    streamId,
                    reason: error
                },
                new Uint8Array(),
                this.options.requestTimeoutMs
            )
            .catch(() => {});
        return true;
    }

    invalidateConnection(clientId: string, connectionId: string): void {
        const cached = this.remoteConnections.get(connectionKey(clientId, connectionId));
        if (cached) this.invalidate(cached);
        for (const key of this.senderRoutes.keys()) {
            if (key.startsWith(`${connectionId}:`)) this.senderRoutes.delete(key);
        }
    }

    private async resolveRegisteredClient(record: RegisteredClient<TRegistryMeta>): Promise<MeshRemoteSrpcConnection<TMeta>> {
        if (!record.connectionId) {
            throw new Error(`Remote sRPC client ${record.clientId} was registered by a mesh version without connection fencing`);
        }
        const key = connectionKey(record.clientId, record.connectionId);
        const cached = this.remoteConnections.get(key);
        if (cached?.connected) return cached;

        const node = await this.options.service.mesh.getNode(record.nodeId);
        if (!node?.linkUrl) throw new Error(`Remote sRPC owner ${record.nodeId} does not advertise a direct mesh link`);
        if ((node.linkProtocolMin ?? 1) > 1 || (node.linkProtocolMax ?? 1) < 1) {
            throw new Error(`Remote sRPC owner ${record.nodeId} does not support mesh-link protocol version 1`);
        }
        const response = await this.options.runtime.request(
            node.linkUrl,
            {
                type: 'reserveStreamIds',
                meshKey: this.options.meshKey,
                clientId: record.clientId,
                connectionId: record.connectionId,
                count: SenderIdReservationSize
            },
            new Uint8Array(),
            this.options.requestTimeoutMs,
            node.processId
        );
        const connection = new MeshRemoteSrpcConnection<TMeta>({
            id: record.connectionId,
            clientId: record.clientId,
            meta: record.metadata as unknown as TMeta,
            connectedAt: record.connectedAt,
            ownerNodeId: record.nodeId,
            ownerProcessId: node.processId,
            senderIds: response.header.ids ?? [],
            transport: this
        });
        this.remoteConnections.set(key, connection);
        return connection;
    }

    private async assertCurrent(connection: MeshRemoteSrpcConnection<TMeta>): Promise<RegisteredClient<TRegistryMeta>> {
        if (!connection.connected) throw new SrpcStaleConnectionError(connection.clientId);
        const current = await this.options.service.clientRegistry.getClient(connection.clientId);
        if (!current || current.connectionId !== connection.id || current.nodeId !== connection.ownerNodeId) {
            this.invalidate(connection);
            throw new SrpcStaleConnectionError(connection.clientId);
        }
        return current;
    }

    private async requestOwner(
        connection: MeshRemoteSrpcConnection<TMeta>,
        header: Omit<MeshLinkFrameHeader, 'version' | 'id' | 'meshKey' | 'clientId' | 'connectionId'>,
        body: Uint8Array,
        timeoutMs: number
    ): Promise<MeshLinkFrame> {
        const current = await this.options.service.clientRegistry.getClient(connection.clientId);
        if (!current || current.connectionId !== connection.id || current.nodeId !== connection.ownerNodeId) {
            this.invalidate(connection);
            throw new SrpcStaleConnectionError(connection.clientId);
        }
        const node = await this.options.service.mesh.getNode(current.nodeId);
        if (!node?.linkUrl) throw new SrpcClientNotFoundError(connection.clientId);
        return this.options.runtime.request(
            node.linkUrl,
            {
                ...header,
                meshKey: this.options.meshKey,
                clientId: connection.clientId,
                connectionId: connection.id
            },
            body,
            timeoutMs,
            node.processId
        );
    }

    private attachLocalReceiver(peer: MeshLinkPeer, clientId: string, connectionId: string, streamId: number): void {
        const key = routeKey(connectionId, streamId);
        if (this.attachedReceivers.has(key)) throw new Error(`sRPC byte stream ${streamId} is already attached`);
        const receiver = this.options.attachLocalReceiver(clientId, connectionId, streamId);
        this.attachedReceivers.set(key, receiver);
        let terminalForwarded = false;
        const unregisterPeerClose = peer.onClose(() => {
            receiver.destroy(new Error('sRPC mesh peer disconnected'));
        });
        receiver.on('data', (chunk: Buffer) => {
            receiver.pause();
            void peer
                .request(
                    { type: 'streamWrite', meshKey: this.options.meshKey, clientId, connectionId, streamId },
                    chunk,
                    this.options.requestTimeoutMs
                )
                .then(
                    () => receiver.resume(),
                    error => receiver.destroy(error)
                );
        });
        receiver.once('end', () => {
            terminalForwarded = true;
            unregisterPeerClose();
            this.attachedReceivers.delete(key);
            void peer
                .request(
                    { type: 'streamFinish', meshKey: this.options.meshKey, clientId, connectionId, streamId },
                    new Uint8Array(),
                    this.options.requestTimeoutMs
                )
                .catch(() => {});
        });
        receiver.once('error', error => {
            terminalForwarded = true;
            unregisterPeerClose();
            this.attachedReceivers.delete(key);
            void peer
                .request(
                    {
                        type: 'streamDestroy',
                        meshKey: this.options.meshKey,
                        clientId,
                        connectionId,
                        streamId,
                        reason: error.message
                    },
                    new Uint8Array(),
                    this.options.requestTimeoutMs
                )
                .catch(() => {});
        });
        receiver.once('close', () => {
            unregisterPeerClose();
            this.attachedReceivers.delete(key);
            if (terminalForwarded) return;
            terminalForwarded = true;
            void peer
                .request(
                    {
                        type: 'streamDestroy',
                        meshKey: this.options.meshKey,
                        clientId,
                        connectionId,
                        streamId
                    },
                    new Uint8Array(),
                    this.options.requestTimeoutMs
                )
                .catch(() => {});
        });
    }

    private getRemoteConnection(clientId: string, connectionId: string): MeshRemoteSrpcConnection<TMeta> {
        const connection = this.remoteConnections.get(connectionKey(clientId, connectionId));
        if (!connection?.connected) throw new SrpcStaleConnectionError(clientId);
        return connection;
    }

    private invalidate(connection: MeshRemoteSrpcConnection<TMeta>): void {
        connection.markStale();
        this.remoteConnections.delete(connectionKey(connection.clientId, connection.id));
    }
}

function emptyResult(header: Partial<MeshLinkFrameHeader> = {}): MeshLinkFrame {
    return {
        header: { type: 'result', ...header },
        body: Buffer.alloc(0)
    };
}

function requiredString(value: string | undefined, name: string): string {
    if (!value) throw new Error(`Missing sRPC mesh ${name}`);
    return value;
}

function requireStreamId(value: number | undefined): void {
    if (!Number.isSafeInteger(value) || value! <= 0) throw new Error('Invalid sRPC mesh stream ID');
}

function connectionKey(clientId: string, connectionId: string): string {
    return `${clientId}:${connectionId}`;
}

function routeKey(connectionId: string, streamId: number): string {
    return `${connectionId}:${streamId}`;
}
