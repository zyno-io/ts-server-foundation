import type {
    MeshClientClaim,
    MeshClientClaimCommitResult,
    MeshClientListPage,
    MeshClientRecord,
    MeshClientRegistrationState,
    MeshClientRegistryBackend,
    RegisteredClient,
    RegisterResult
} from './types';

export class MeshClientRegistry<TMeta> {
    constructor(
        private nodeId: number,
        private backend: MeshClientRegistryBackend<TMeta>,
        private processId?: string
    ) {}

    /** @internal Keeps the public registry facade stable across service start. */
    setNodeId(nodeId: number): void {
        this.nodeId = nodeId;
    }

    async register(clientId: string, metadata: TMeta, allowSupersede: boolean, connectionId: string): Promise<RegisterResult> {
        return this.backend.register(clientId, this.nodeId, metadata, allowSupersede, connectionId, this.processId);
    }

    async reserve(clientId: string, metadata: TMeta, allowSupersede: boolean, connectionId: string): Promise<RegisterResult> {
        return this.backend.reserve(clientId, this.nodeId, metadata, allowSupersede, connectionId, this.processId);
    }

    async activate(clientId: string, metadata: TMeta, connectionId: string): Promise<boolean> {
        return this.backend.activate(clientId, this.nodeId, metadata, connectionId);
    }

    async unregister(clientId: string, connectionId: string): Promise<boolean> {
        return this.backend.unregister(clientId, this.nodeId, connectionId);
    }

    async updateMetadata(clientId: string, metadata: TMeta, connectionId: string): Promise<boolean> {
        return this.backend.updateMetadata(clientId, this.nodeId, metadata, connectionId);
    }

    async getClient(clientId: string): Promise<RegisteredClient<TMeta> | undefined> {
        return this.backend.getClient(clientId);
    }

    /** @internal Exact/raw lookup for claim commit response-loss reconciliation. */
    async getClientIncludingPending(clientId: string): Promise<MeshClientRecord<TMeta> | undefined> {
        return this.backend.getClientIncludingPending?.(clientId);
    }

    async listClients(): Promise<RegisteredClient<TMeta>[]> {
        return this.backend.listClients();
    }

    async listClientsForNode(nodeId?: number): Promise<RegisteredClient<TMeta>[]> {
        return this.backend.listClientsForNode(nodeId ?? this.nodeId);
    }

    async listClientsPage(cursor = '0'): Promise<MeshClientListPage<TMeta>> {
        if (this.backend.listClientsPage) return this.backend.listClientsPage(cursor);
        return cursor === '0' ? { clients: await this.backend.listClients() } : { clients: [] };
    }

    async listClientsForNodePage(nodeId = this.nodeId, cursor = '0'): Promise<MeshClientListPage<TMeta>> {
        if (this.backend.listClientsForNodePage) return this.backend.listClientsForNodePage(nodeId, cursor);
        return cursor === '0' ? { clients: await this.backend.listClientsForNode(nodeId) } : { clients: [] };
    }

    async cleanupNode(nodeId?: number): Promise<RegisteredClient<TMeta>[]> {
        return this.backend.cleanupNode(nodeId ?? this.nodeId);
    }

    async refreshNode(): Promise<void> {
        await this.backend.refreshNode?.(this.nodeId);
    }

    async claim(
        clientId: string,
        metadata: TMeta,
        state: MeshClientRegistrationState,
        allowSupersede: boolean,
        connectionId: string,
        operationId?: string
    ): Promise<MeshClientClaim<TMeta> | undefined> {
        if (
            !this.backend.claim ||
            !this.backend.commitClaim ||
            !this.backend.abortClaim ||
            !this.backend.getClientIncludingPending ||
            !this.backend.removeClaimResult ||
            !this.backend.removeClaimPrevious
        ) {
            return undefined;
        }
        return this.backend.claim(clientId, this.nodeId, metadata, state, allowSupersede, connectionId, this.processId, operationId);
    }

    async commitClaim(clientId: string, claimId: string): Promise<MeshClientClaimCommitResult | undefined> {
        return this.backend.commitClaim?.(clientId, this.nodeId, claimId);
    }

    async removeClaimPrevious(clientId: string, claimId: string): Promise<boolean | undefined> {
        return this.backend.removeClaimPrevious?.(clientId, this.nodeId, claimId);
    }

    async abortClaim(clientId: string, claimId: string): Promise<boolean | undefined> {
        return this.backend.abortClaim?.(clientId, this.nodeId, claimId);
    }

    async removeClaimResult(clientId: string, claimId: string): Promise<boolean | undefined> {
        return this.backend.removeClaimResult?.(clientId, this.nodeId, claimId);
    }
}
