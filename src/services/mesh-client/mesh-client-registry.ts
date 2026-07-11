import type { MeshClientRegistryBackend, RegisteredClient, RegisterResult } from './types';

export class MeshClientRegistry<TMeta> {
    constructor(
        private nodeId: number,
        private backend: MeshClientRegistryBackend<TMeta>
    ) {}

    async register(clientId: string, metadata: TMeta, allowSupersede?: boolean): Promise<RegisterResult> {
        return this.backend.register(clientId, this.nodeId, metadata, allowSupersede);
    }

    async reserve(clientId: string, metadata: TMeta, allowSupersede?: boolean): Promise<RegisterResult> {
        return this.backend.reserve(clientId, this.nodeId, metadata, allowSupersede);
    }

    async activate(clientId: string, metadata: TMeta): Promise<boolean> {
        return this.backend.activate(clientId, this.nodeId, metadata);
    }

    async unregister(clientId: string): Promise<boolean> {
        return this.backend.unregister(clientId, this.nodeId);
    }

    async updateMetadata(clientId: string, metadata: TMeta): Promise<boolean> {
        return this.backend.updateMetadata(clientId, this.nodeId, metadata);
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
}
