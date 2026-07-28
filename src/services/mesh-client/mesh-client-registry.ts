import type { MeshClientRegistryBackend, RegisteredClient, RegisterResult } from './types';

export class MeshClientRegistry<TMeta> {
    constructor(
        private nodeId: number,
        private backend: MeshClientRegistryBackend<TMeta>,
        private processId?: string
    ) {}

    async register(clientId: string, metadata: TMeta, allowSupersede?: boolean, connectionId?: string): Promise<RegisterResult> {
        return this.backend.register(clientId, this.nodeId, metadata, allowSupersede, connectionId, this.processId);
    }

    async reserve(clientId: string, metadata: TMeta, allowSupersede?: boolean, connectionId?: string): Promise<RegisterResult> {
        return this.backend.reserve(clientId, this.nodeId, metadata, allowSupersede, connectionId, this.processId);
    }

    async activate(clientId: string, metadata: TMeta, connectionId?: string): Promise<boolean> {
        return this.backend.activate(clientId, this.nodeId, metadata, connectionId);
    }

    async unregister(clientId: string, connectionId?: string): Promise<boolean> {
        return this.backend.unregister(clientId, this.nodeId, connectionId);
    }

    async updateMetadata(clientId: string, metadata: TMeta, connectionId?: string): Promise<boolean> {
        return this.backend.updateMetadata(clientId, this.nodeId, metadata, connectionId);
    }

    async getClient(clientId: string): Promise<RegisteredClient<TMeta> | undefined> {
        return this.backend.getClient(clientId);
    }

    async listClients(): Promise<RegisteredClient<TMeta>[]> {
        return this.backend.listClients();
    }

    async listClientsForNode(nodeId?: number): Promise<RegisteredClient<TMeta>[]> {
        return this.backend.listClientsForNode(nodeId ?? this.nodeId);
    }

    async cleanupNode(nodeId?: number): Promise<RegisteredClient<TMeta>[]> {
        return this.backend.cleanupNode(nodeId ?? this.nodeId);
    }

    async refreshNode(): Promise<void> {
        await this.backend.refreshNode?.(this.nodeId);
    }
}
