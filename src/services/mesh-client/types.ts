export interface RegisteredClient<TMeta> {
    clientId: string;
    nodeId: number;
    connectedAt: number;
    metadata: TMeta;
}

export type MeshClientRegistrationState = 'active' | 'pending';

/** Result of a register call. */
export type RegisterResult =
    | { status: 'ok'; supersededNodeId: number | null }
    // ownerNodeId can be null if the owning client disappears during
    // the Redis conflict/readback race.
    | { status: 'conflict'; ownerNodeId: number | null };

export interface MeshClientRegistryBackend<TMeta> {
    register(clientId: string, nodeId: number, metadata: TMeta, allowSupersede?: boolean): Promise<RegisterResult>;
    reserve(clientId: string, nodeId: number, metadata: TMeta, allowSupersede?: boolean): Promise<RegisterResult>;
    activate(clientId: string, nodeId: number, metadata: TMeta): Promise<boolean>;
    unregister(clientId: string, nodeId: number): Promise<boolean>;
    updateMetadata(clientId: string, nodeId: number, metadata: TMeta): Promise<boolean>;
    getClient(clientId: string): Promise<RegisteredClient<TMeta> | undefined>;
    listClients(): Promise<RegisteredClient<TMeta>[]>;
    listClientsForNode(nodeId: number): Promise<RegisteredClient<TMeta>[]>;
    cleanupNode(nodeId: number): Promise<RegisteredClient<TMeta>[]>;
}

export class ClientNotFoundError extends Error {
    constructor(clientId: string) {
        super(`Client not found: ${clientId}`);
        this.name = 'ClientNotFoundError';
    }
}

export class ClientDisconnectedError extends Error {
    constructor(clientId: string) {
        super(`Client disconnected: ${clientId}`);
        this.name = 'ClientDisconnectedError';
    }
}

export class ClientInvocationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ClientInvocationError';
    }
}
