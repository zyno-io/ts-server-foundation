export interface RegisteredClient<TMeta> {
    clientId: string;
    nodeId: number;
    connectionId: string;
    processId?: string;
    connectedAt: number;
    metadata: TMeta;
}

export interface OrphanedClientDelivery<TMeta> {
    id: string;
    nodeId: number;
    clients: RegisteredClient<TMeta>[];
    claimToken: string;
}

export interface MeshClientListPage<TMeta> {
    clients: RegisteredClient<TMeta>[];
    /** Opaque continuation cursor. Absent when the scan is complete. */
    cursor?: string;
}

export type MeshClientRegistrationState = 'active' | 'pending';

/** Internal/raw registry view used only to reconcile an indeterminate claim commit. */
export interface MeshClientRecord<TMeta> extends RegisteredClient<TMeta> {
    state: MeshClientRegistrationState;
    /** Exact two-phase claim that installed this record, when applicable. */
    claimId?: string;
}

/** Result of a register call. */
export type RegisterResult =
    | {
          status: 'ok';
          supersededNodeId: number | null;
          /** Exact superseded generation, absent for old unfenced records. */
          supersededConnectionId?: string;
      }
    // ownerNodeId can be null if the owning client disappears during
    // the Redis conflict/readback race.
    | { status: 'conflict'; ownerNodeId: number | null };

/**
 * A private ownership claim.  Claims deliberately do not replace the active
 * record: callers must fence `previous` and then commit the exact claim.
 */
export type MeshClientClaim<TMeta> =
    | { status: 'conflict'; ownerNodeId: number | null }
    | { status: 'ok'; claimId: string; previous?: MeshClientRecord<TMeta> };

/** A changed exact prior generation must be reconciled before commit retries. */
export type MeshClientClaimCommitResult = boolean | 'previous-changed';

export interface MeshClientRegistryBackend<TMeta> {
    register(
        clientId: string,
        nodeId: number,
        metadata: TMeta,
        allowSupersede: boolean,
        connectionId: string,
        processId?: string
    ): Promise<RegisterResult>;
    reserve(
        clientId: string,
        nodeId: number,
        metadata: TMeta,
        allowSupersede: boolean,
        connectionId: string,
        processId?: string
    ): Promise<RegisterResult>;
    activate(clientId: string, nodeId: number, metadata: TMeta, connectionId: string): Promise<boolean>;
    unregister(clientId: string, nodeId: number, connectionId: string): Promise<boolean>;
    updateMetadata(clientId: string, nodeId: number, metadata: TMeta, connectionId: string): Promise<boolean>;
    getClient(clientId: string): Promise<RegisteredClient<TMeta> | undefined>;
    /** Includes a private pending registration; never use for client delivery. */
    getClientIncludingPending?(clientId: string): Promise<MeshClientRecord<TMeta> | undefined>;
    listClients(): Promise<RegisteredClient<TMeta>[]>;
    listClientsForNode(nodeId: number): Promise<RegisteredClient<TMeta>[]>;
    listClientsPage?(cursor?: string): Promise<MeshClientListPage<TMeta>>;
    listClientsForNodePage?(nodeId: number, cursor?: string): Promise<MeshClientListPage<TMeta>>;
    cleanupNode(nodeId: number): Promise<RegisteredClient<TMeta>[]>;
    /**
     * Atomically computes the exact active-only cleanup snapshot, rejects
     * before mutation when a non-empty snapshot cannot consume one item or
     * exceeds the supplied byte limit, and otherwise removes all node records
     * and returns that exact active-only snapshot. An empty snapshot consumes
     * no item or bytes. Required for safe local fallback orphan delivery.
     */
    cleanupNodeForFallback?(nodeId: number, maxItems: number, maxBytes: number): Promise<RegisteredClient<TMeta>[]>;
    refreshNode?(nodeId: number): Promise<void>;

    /** Two-phase takeover primitives. Optional for custom backends. */
    claim?(
        clientId: string,
        nodeId: number,
        metadata: TMeta,
        state: MeshClientRegistrationState,
        allowSupersede: boolean,
        connectionId: string,
        processId?: string,
        /** Caller-stable identity for retries of this exact claim operation. */
        operationId?: string
    ): Promise<MeshClientClaim<TMeta>>;
    /**
     * Commits an exact claim. Retrying the same committed `claimId` after a
     * lost response must return true while that exact record remains current.
     */
    commitClaim?(clientId: string, nodeId: number, claimId: string): Promise<MeshClientClaimCommitResult>;
    /**
     * Removes only the previous generation captured by an extant claim. A
     * stable claim token may authorize state/metadata changes by that same
     * generation, but never a different reconnect.
     */
    removeClaimPrevious?(clientId: string, nodeId: number, claimId: string): Promise<boolean>;
    abortClaim?(clientId: string, nodeId: number, claimId: string): Promise<boolean>;
    /** Removes only the pending/committed result installed by this exact claim. */
    removeClaimResult?(clientId: string, nodeId: number, claimId: string): Promise<boolean>;
    /** Atomically removes a dead node and persists its active-only orphan snapshot. */
    cleanupNodeAndEnqueueOrphaned?(nodeId: number): Promise<RegisteredClient<TMeta>[]>;
    enqueueOrphaned?(nodeId: number, clients: RegisteredClient<TMeta>[]): Promise<void>;
    claimOrphaned?(claimerId: string): Promise<OrphanedClientDelivery<TMeta> | undefined>;
    ackOrphaned?(id: string, claimToken: string): Promise<boolean>;
    nackOrphaned?(id: string, claimToken: string): Promise<boolean>;
    /** Optional cross-instance authentication replay consumer. */
    consumeAuthNonce?(principal: string, nonce: string, expiresAt: number): Promise<boolean>;
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
