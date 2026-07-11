import type { MeshClientRegistryBackend, MeshClientRegistrationState, RegisteredClient, RegisterResult } from './types';

import { createRedis } from '../../helpers/redis/redis';

// --- Lua Scripts ---

// Safety-net TTL for all client registry keys. Primary cleanup is via
// unregister/cleanupNode; this only matters if ALL nodes crash without
// graceful shutdown and no leader ever runs cleanup.
const KEY_TTL_SECONDS = 86400; // 24 hours

// REGISTER atomically registers a client, optionally moving it between nodes.
// KEYS[1] = clients hash, KEYS[2] = new node's set
// ARGV[1] = clientId, ARGV[2] = nodeId, ARGV[3] = metadataJson,
// ARGV[4] = hasMetadata ("1" or "0"), ARGV[5] = setKeyPrefix,
// ARGV[6] = connectedAt, ARGV[7] = allowSupersede ("1" or "0"),
// ARGV[8] = state ("active" or "pending")
//
// Returns:
//   -1  = registered, no supersession (new client or re-register on same node)
//   -2  = conflict: another node owns this client and supersession not allowed
//   >=0 = registered, superseded from this nodeId
const REGISTER_SCRIPT = `
local clientsKey = KEYS[1]
local newSetKey = KEYS[2]
local clientId = ARGV[1]
local nodeId = ARGV[2]
local metadataJson = ARGV[3]
local hasMetadata = ARGV[4] == "1"
local setKeyPrefix = ARGV[5]
local connectedAt = tonumber(ARGV[6])
local allowSupersede = ARGV[7] == "1"
local state = ARGV[8]
local ttl = ${KEY_TTL_SECONDS}

-- Check if client already exists on a different node
local supersededNodeId = -1
local existing = redis.call("hget", clientsKey, clientId)
if existing then
    local parsed = cjson.decode(existing)
    local oldNodeId = tostring(parsed.nodeId)
    if oldNodeId ~= nodeId then
        if not allowSupersede then
            return -2
        end
        -- Construct old node's set key and remove
        local oldSetKey = setKeyPrefix .. oldNodeId .. ":clients"
        redis.call("srem", oldSetKey, clientId)
        supersededNodeId = tonumber(oldNodeId)
    end
end

-- Set in hash and add to new node's set
local value = cjson.encode({
    nodeId = tonumber(nodeId),
    connectedAt = connectedAt,
    state = state,
    hasMetadata = hasMetadata,
    metadata = cjson.decode(metadataJson)
})
redis.call("hset", clientsKey, clientId, value)
redis.call("sadd", newSetKey, clientId)

-- Refresh safety-net TTL on every write
redis.call("expire", clientsKey, ttl)
redis.call("expire", newSetKey, ttl)

-- Return old nodeId if client was superseded from a different node, else -1
return supersededNodeId
`;

// ACTIVATE promotes a same-node reservation from pending to active without
// re-taking ownership if the client moved elsewhere in the meantime.
// KEYS[1] = clients hash, KEYS[2] = node's set
// ARGV[1] = clientId, ARGV[2] = nodeId, ARGV[3] = metadataJson, ARGV[4] = hasMetadata ("1" or "0")
const ACTIVATE_SCRIPT = `
local clientsKey = KEYS[1]
local setKey = KEYS[2]
local clientId = ARGV[1]
local nodeId = ARGV[2]
local metadataJson = ARGV[3]
local hasMetadata = ARGV[4] == "1"
local ttl = ${KEY_TTL_SECONDS}

local existing = redis.call("hget", clientsKey, clientId)
if not existing then
    return 0
end

local parsed = cjson.decode(existing)
if tostring(parsed.nodeId) ~= nodeId then
    return 0
end

local value = cjson.encode({
    nodeId = parsed.nodeId,
    connectedAt = parsed.connectedAt,
    state = "active",
    hasMetadata = hasMetadata,
    metadata = cjson.decode(metadataJson)
})
redis.call("hset", clientsKey, clientId, value)
redis.call("sadd", setKey, clientId)
redis.call("expire", clientsKey, ttl)
redis.call("expire", setKey, ttl)
return 1
`;

const UNREGISTER_SCRIPT = `
local clientsKey = KEYS[1]
local setKey = KEYS[2]
local clientId = ARGV[1]
local nodeId = ARGV[2]

local existing = redis.call("hget", clientsKey, clientId)
if not existing then
    return 0
end

local parsed = cjson.decode(existing)
if tostring(parsed.nodeId) ~= nodeId then
    return 0
end

redis.call("hdel", clientsKey, clientId)
redis.call("srem", setKey, clientId)
return 1
`;

// UPDATE_METADATA atomically updates metadata only if the client is owned by the given node.
// KEYS[1] = clients hash
// ARGV[1] = clientId, ARGV[2] = nodeId, ARGV[3] = metadataJson, ARGV[4] = hasMetadata ("1" or "0")
const UPDATE_METADATA_SCRIPT = `
local clientsKey = KEYS[1]
local clientId = ARGV[1]
local nodeId = ARGV[2]
local metadataJson = ARGV[3]
local hasMetadata = ARGV[4] == "1"
local ttl = ${KEY_TTL_SECONDS}

local existing = redis.call("hget", clientsKey, clientId)
if not existing then
    return 0
end

local parsed = cjson.decode(existing)
if tostring(parsed.nodeId) ~= nodeId then
    return 0
end

local value = cjson.encode({
    nodeId = parsed.nodeId,
    connectedAt = parsed.connectedAt,
    state = parsed.state or "active",
    hasMetadata = hasMetadata,
    metadata = cjson.decode(metadataJson)
})
redis.call("hset", clientsKey, clientId, value)
redis.call("expire", clientsKey, ttl)
return 1
`;

const CLEANUP_NODE_SCRIPT = `
local clientsKey = KEYS[1]
local setKey = KEYS[2]
local nodeId = ARGV[1]

local members = redis.call("smembers", setKey)
local removed = {}

for _, clientId in ipairs(members) do
    local existing = redis.call("hget", clientsKey, clientId)
    if existing then
        local parsed = cjson.decode(existing)
        if tostring(parsed.nodeId) == nodeId then
            redis.call("hdel", clientsKey, clientId)
            table.insert(removed, existing)
            table.insert(removed, clientId)
        end
    end
end

redis.call("del", setKey)
return removed
`;

// --- Redis Client Type ---

type ClientRedisClient = ReturnType<typeof createRedis>['client'] & {
    MC_REGISTER: (
        clientsKey: string,
        newSetKey: string,
        clientId: string,
        nodeId: string,
        metadataJson: string,
        hasMetadata: string,
        setKeyPrefix: string,
        connectedAt: string,
        allowSupersede: string,
        state: string
    ) => Promise<number>;
    MC_ACTIVATE: (clientsKey: string, setKey: string, clientId: string, nodeId: string, metadataJson: string, hasMetadata: string) => Promise<number>;
    MC_UNREGISTER: (clientsKey: string, setKey: string, clientId: string, nodeId: string) => Promise<number>;
    MC_UPDATE_METADATA: (clientsKey: string, clientId: string, nodeId: string, metadataJson: string, hasMetadata: string) => Promise<number>;
    MC_CLEANUP_NODE: (clientsKey: string, setKey: string, nodeId: string) => Promise<string[]>;
};

let clientRedis: { client: ClientRedisClient; prefix: string } | null = null;

function getClientRedis(): { client: ClientRedisClient; prefix: string } {
    if (!clientRedis) {
        const { client, prefix } = createRedis('MESH');
        client.defineCommand('MC_REGISTER', { lua: REGISTER_SCRIPT, numberOfKeys: 2 });
        client.defineCommand('MC_ACTIVATE', { lua: ACTIVATE_SCRIPT, numberOfKeys: 2 });
        client.defineCommand('MC_UNREGISTER', { lua: UNREGISTER_SCRIPT, numberOfKeys: 2 });
        client.defineCommand('MC_UPDATE_METADATA', { lua: UPDATE_METADATA_SCRIPT, numberOfKeys: 1 });
        client.defineCommand('MC_CLEANUP_NODE', { lua: CLEANUP_NODE_SCRIPT, numberOfKeys: 2 });
        clientRedis = { client: client as ClientRedisClient, prefix };
    }
    return clientRedis;
}

export function destroyClientRedis(): void {
    if (clientRedis) {
        clientRedis.client.disconnect();
        clientRedis = null;
    }
}

// --- MeshClientRedisRegistry ---

export class MeshClientRedisRegistry<TMeta> implements MeshClientRegistryBackend<TMeta> {
    private key: string;

    constructor(key: string) {
        this.key = key;
    }

    private clientsKey(): string {
        const { prefix } = getClientRedis();
        return `${prefix}:mesh:${this.key}:clients`;
    }

    private nodeSetKey(nodeId: number): string {
        const { prefix } = getClientRedis();
        return `${prefix}:mesh:${this.key}:node:${nodeId}:clients`;
    }

    private nodeSetKeyPrefix(): string {
        const { prefix } = getClientRedis();
        return `${prefix}:mesh:${this.key}:node:`;
    }

    private encodeMetadata(metadata: TMeta): { metadataJson: string; hasMetadata: '0' | '1' } {
        if (metadata === undefined) {
            return { metadataJson: 'null', hasMetadata: '0' };
        }

        const metadataJson = JSON.stringify(metadata);
        if (metadataJson === undefined) {
            throw new Error('Mesh client metadata must be JSON-serializable');
        }

        return { metadataJson, hasMetadata: '1' };
    }

    private async registerWithState(
        clientId: string,
        nodeId: number,
        metadata: TMeta,
        allowSupersede: boolean,
        state: MeshClientRegistrationState
    ): Promise<RegisterResult> {
        const { client } = getClientRedis();
        const encoded = this.encodeMetadata(metadata);
        const result = await client.MC_REGISTER(
            this.clientsKey(),
            this.nodeSetKey(nodeId),
            clientId,
            String(nodeId),
            encoded.metadataJson,
            encoded.hasMetadata,
            this.nodeSetKeyPrefix(),
            String(Date.now()),
            allowSupersede ? '1' : '0',
            state
        );
        if (result === -2) {
            // Conflict: the owner may have disappeared between the script
            // result and this follow-up read, so ownerNodeId can be null.
            const existing = await client.hget(this.clientsKey(), clientId);
            const parsed = existing ? this.tryParse(existing) : undefined;
            return { status: 'conflict', ownerNodeId: parsed?.nodeId ?? null };
        }
        return { status: 'ok', supersededNodeId: result >= 0 ? result : null };
    }

    async register(clientId: string, nodeId: number, metadata: TMeta, allowSupersede = true): Promise<RegisterResult> {
        return this.registerWithState(clientId, nodeId, metadata, allowSupersede, 'active');
    }

    async reserve(clientId: string, nodeId: number, metadata: TMeta, allowSupersede = true): Promise<RegisterResult> {
        return this.registerWithState(clientId, nodeId, metadata, allowSupersede, 'pending');
    }

    async activate(clientId: string, nodeId: number, metadata: TMeta): Promise<boolean> {
        const { client } = getClientRedis();
        const encoded = this.encodeMetadata(metadata);
        const result = await client.MC_ACTIVATE(
            this.clientsKey(),
            this.nodeSetKey(nodeId),
            clientId,
            String(nodeId),
            encoded.metadataJson,
            encoded.hasMetadata
        );
        return result === 1;
    }

    async unregister(clientId: string, nodeId: number): Promise<boolean> {
        const { client } = getClientRedis();
        const result = await client.MC_UNREGISTER(this.clientsKey(), this.nodeSetKey(nodeId), clientId, String(nodeId));
        return result === 1;
    }

    async updateMetadata(clientId: string, nodeId: number, metadata: TMeta): Promise<boolean> {
        const { client } = getClientRedis();
        const encoded = this.encodeMetadata(metadata);
        const result = await client.MC_UPDATE_METADATA(this.clientsKey(), clientId, String(nodeId), encoded.metadataJson, encoded.hasMetadata);
        return result === 1;
    }

    private tryParse(raw: string): { nodeId: number; connectedAt: number; metadata: TMeta; state: MeshClientRegistrationState } | undefined {
        try {
            const parsed = JSON.parse(raw) as {
                nodeId: number;
                connectedAt: number;
                hasMetadata?: boolean;
                metadata: TMeta;
                state?: MeshClientRegistrationState;
            };
            return {
                nodeId: parsed.nodeId,
                connectedAt: parsed.connectedAt,
                metadata: parsed.hasMetadata === false ? (undefined as TMeta) : parsed.metadata,
                state: parsed.state ?? 'active'
            };
        } catch {
            return undefined;
        }
    }

    private toRegisteredClient(
        clientId: string,
        parsed: {
            nodeId: number;
            connectedAt: number;
            metadata: TMeta;
            state: MeshClientRegistrationState;
        }
    ): RegisteredClient<TMeta> | undefined {
        if (parsed.state !== 'active') {
            return undefined;
        }
        return {
            clientId,
            nodeId: parsed.nodeId,
            connectedAt: parsed.connectedAt,
            metadata: parsed.metadata
        };
    }

    async getClient(clientId: string): Promise<RegisteredClient<TMeta> | undefined> {
        const { client } = getClientRedis();
        const raw = await client.hget(this.clientsKey(), clientId);
        if (!raw) return undefined;

        const parsed = this.tryParse(raw);
        if (!parsed) return undefined;

        return this.toRegisteredClient(clientId, parsed);
    }

    async listClients(): Promise<RegisteredClient<TMeta>[]> {
        const { client } = getClientRedis();
        const all = await client.hgetall(this.clientsKey());
        const results: RegisteredClient<TMeta>[] = [];
        for (const [clientId, raw] of Object.entries(all)) {
            const parsed = this.tryParse(raw);
            if (parsed) {
                const registered = this.toRegisteredClient(clientId, parsed);
                if (registered) {
                    results.push(registered);
                }
            }
        }
        return results;
    }

    async listClientsForNode(nodeId: number): Promise<RegisteredClient<TMeta>[]> {
        const { client } = getClientRedis();
        const clientIds = await client.smembers(this.nodeSetKey(nodeId));
        if (clientIds.length === 0) return [];

        const values = await client.hmget(this.clientsKey(), ...clientIds);
        const results: RegisteredClient<TMeta>[] = [];
        for (let i = 0; i < clientIds.length; i++) {
            const raw = values[i];
            if (raw) {
                const parsed = this.tryParse(raw);
                if (parsed && parsed.nodeId === nodeId) {
                    const registered = this.toRegisteredClient(clientIds[i], parsed);
                    if (registered) {
                        results.push(registered);
                    }
                }
            }
        }
        return results;
    }

    async cleanupNode(nodeId: number): Promise<RegisteredClient<TMeta>[]> {
        const { client } = getClientRedis();
        const result = await client.MC_CLEANUP_NODE(this.clientsKey(), this.nodeSetKey(nodeId), String(nodeId));

        // Result is alternating [json, clientId, json, clientId, ...]
        const removed: RegisteredClient<TMeta>[] = [];
        for (let i = 0; i < result.length; i += 2) {
            const parsed = this.tryParse(result[i]);
            if (parsed) {
                removed.push({
                    clientId: result[i + 1],
                    nodeId: parsed.nodeId,
                    connectedAt: parsed.connectedAt,
                    metadata: parsed.metadata
                });
            }
        }
        return removed;
    }
}
