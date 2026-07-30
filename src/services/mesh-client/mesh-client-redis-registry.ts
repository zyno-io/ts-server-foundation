import type { MeshClientRecord, MeshClientRegistryBackend, MeshClientRegistrationState, RegisteredClient, RegisterResult } from './types';

import { createHash, randomUUID } from 'node:crypto';
import { registerRedisStateReset } from '../../helpers/redis/lifecycle';
import { createRedis } from '../../helpers/redis/redis';

// --- Lua Scripts ---

// Safety-net TTL for all client registry keys. Primary cleanup is via
// unregister/cleanupNode; this only matters if ALL nodes crash without
// graceful shutdown and no leader ever runs cleanup.
const KEY_TTL_SECONDS = 86400; // 24 hours
const CLAIM_TTL_MS = 30_000;
const ORPHAN_TTL_SECONDS = 3600;
const ORPHAN_CLAIM_MS = 30_000;
const MAX_ORPHAN_CLAIM_SCAN = 100;
const MAX_CLAIMS_PER_NODE = 8_192;
const DEFAULT_MAX_CLIENT_ID_BYTES = 1_024;
const DEFAULT_MAX_METADATA_BYTES = 64 * 1024;
const DEFAULT_MAX_CLIENTS_PER_NODE = 10_000;
const DEFAULT_SCAN_BATCH_SIZE = 256;
const DEFAULT_CLEANUP_BATCH_SIZE = 256;
const DEFAULT_MAX_AUTH_REPLAY_PRINCIPALS = 4_096;
const DEFAULT_MAX_AUTH_NONCES_PER_PRINCIPAL = 256;
const DEFAULT_MAX_ORPHAN_ITEMS = 4_096;
const DEFAULT_MAX_ORPHAN_BYTES = 64 * 1024 * 1024;

export interface MeshClientRedisRegistryOptions {
    maxClientIdBytes?: number;
    maxMetadataBytes?: number;
    maxClientsPerNode?: number;
    scanBatchSize?: number;
    cleanupBatchSize?: number;
    maxAuthReplayPrincipals?: number;
    maxAuthNoncesPerPrincipal?: number;
    /** Global durable orphan queue caps (not merely per snapshot). */
    maxOrphanItems?: number;
    maxOrphanBytes?: number;
}

// REGISTER atomically registers a client, optionally moving it between nodes.
// KEYS[1] = clients hash, KEYS[2] = new node's set
// ARGV[1] = clientId, ARGV[2] = nodeId, ARGV[3] = metadataJson,
// ARGV[4] = hasMetadata ("1" or "0"), ARGV[5] = setKeyPrefix,
// ARGV[6] = connectedAt, ARGV[7] = allowSupersede ("1" or "0"),
// ARGV[8] = state ("active" or "pending"), ARGV[11] = stable generation ID
//
// Returns `{ supersededNodeId, supersededConnectionId }`. The connection ID
// is read from the old record in this same script, before ownership changes.
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
local connectionId = ARGV[9]
local processId = ARGV[10]
local generationId = ARGV[11]
local maxClientsPerNode = tonumber(ARGV[12])
local ttl = ${KEY_TTL_SECONDS}

if connectionId == "" then
    return { -2, "" }
end

-- Check if client already exists on a different node
local supersededNodeId = -1
local supersededConnectionId = ""
local stableGenerationId = generationId
local existing = redis.call("hget", clientsKey, clientId)
if existing then
    local parsed = cjson.decode(existing)
    local oldNodeId = tostring(parsed.nodeId)
    if oldNodeId ~= nodeId or tostring(parsed.connectionId or "") ~= connectionId then
        -- Direct register has no revocation acknowledgement. A caller that wants
        -- takeover must use claim/fence/commit through MeshClientService;
        -- publishing here would recreate the unsafe old handoff.
        return { -2, "" }
    end
    stableGenerationId = parsed.claimId or generationId
end

if redis.call("sismember", newSetKey, clientId) == 0 and redis.call("scard", newSetKey) >= maxClientsPerNode then
    return { -3, "" }
end

-- Set in hash and add to new node's set
local value = cjson.encode({
    nodeId = tonumber(nodeId),
    connectedAt = connectedAt,
    state = state,
    claimId = stableGenerationId,
    connectionId = connectionId,
    processId = processId,
    hasMetadata = hasMetadata,
    metadata = cjson.decode(metadataJson)
})
redis.call("hset", clientsKey, clientId, value)
redis.call("sadd", newSetKey, clientId)

-- Refresh safety-net TTL on every write
redis.call("expire", clientsKey, ttl)
redis.call("expire", newSetKey, ttl)

return { supersededNodeId, supersededConnectionId }
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
local connectionId = ARGV[5]
local ttl = ${KEY_TTL_SECONDS}

if connectionId == "" then
    return 0
end

local existing = redis.call("hget", clientsKey, clientId)
if not existing then
    return 0
end

local parsed = cjson.decode(existing)
if tostring(parsed.nodeId) ~= nodeId then
    return 0
end
if tostring(parsed.connectionId or "") ~= connectionId then
    return 0
end

local value = cjson.encode({
    nodeId = parsed.nodeId,
    connectedAt = parsed.connectedAt,
    state = "active",
    claimId = parsed.claimId,
    connectionId = parsed.connectionId,
    processId = parsed.processId,
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
local claimsKey = KEYS[3]
local claimsIndexKey = KEYS[4]
local nodeClaimsKey = KEYS[5]
local clientId = ARGV[1]
local nodeId = ARGV[2]
local connectionId = ARGV[3]

if connectionId == "" then
    return 0
end

local existing = redis.call("hget", clientsKey, clientId)
if not existing then
    return 0
end

local parsed = cjson.decode(existing)
if tostring(parsed.nodeId) ~= nodeId then
    return 0
end
if tostring(parsed.connectionId or "") ~= connectionId then
    return 0
end

redis.call("hdel", clientsKey, clientId)
redis.call("srem", setKey, clientId)
local claimRaw = redis.call("hget", claimsKey, clientId)
if claimRaw then
    local claim = cjson.decode(claimRaw)
    if tostring(claim.nodeId) == nodeId and tostring(claim.connectionId or "") == connectionId then
        redis.call("hdel", claimsKey, clientId)
        redis.call("zrem", claimsIndexKey, clientId)
        redis.call("srem", nodeClaimsKey, clientId)
    end
end
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
local connectionId = ARGV[5]
local ttl = ${KEY_TTL_SECONDS}

if connectionId == "" then
    return 0
end

local existing = redis.call("hget", clientsKey, clientId)
if not existing then
    return 0
end

local parsed = cjson.decode(existing)
if tostring(parsed.nodeId) ~= nodeId then
    return 0
end
if tostring(parsed.connectionId or "") ~= connectionId then
    return 0
end

local value = cjson.encode({
    nodeId = parsed.nodeId,
    connectedAt = parsed.connectedAt,
    state = parsed.state or "active",
    claimId = parsed.claimId,
    connectionId = parsed.connectionId,
    processId = parsed.processId,
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
local nodeClaimsKey = KEYS[3]
local claimsKey = KEYS[4]
local claimsIndexKey = KEYS[5]
local nodeId = ARGV[1]
local batchSize = tonumber(ARGV[2])

local members = redis.call("spop", setKey, batchSize)
local removed = {}

for _, clientId in ipairs(members) do
    local existing = redis.call("hget", clientsKey, clientId)
    if existing then
        local decoded, parsed = pcall(cjson.decode, existing)
        if not decoded or type(parsed) ~= "table" then
            redis.call("hdel", clientsKey, clientId)
        elseif tostring(parsed.nodeId) == nodeId then
            redis.call("hdel", clientsKey, clientId)
            -- Pending reservations never reached user-visible lifecycle
            -- callbacks, so removing them must not manufacture an orphan.
            if (parsed.state or "active") == "active" then
                table.insert(removed, existing)
                table.insert(removed, clientId)
            end
        end
    end
end

for _, clientId in ipairs(redis.call("spop", nodeClaimsKey, batchSize)) do
    redis.call("hdel", claimsKey, clientId)
    redis.call("zrem", claimsIndexKey, clientId)
end
local done = redis.call("scard", setKey) == 0 and redis.call("scard", nodeClaimsKey) == 0
if done then
    redis.call("del", setKey)
    redis.call("del", nodeClaimsKey)
end
table.insert(removed, 1, done and "1" or "0")
return removed
`;

const CLEANUP_NODE_AND_ORPHAN_SCRIPT = `
local clientsKey = KEYS[1]
local setKey = KEYS[2]
local nodeClaimsKey = KEYS[3]
local claimsKey = KEYS[4]
local claimsIndexKey = KEYS[5]
local orphanKey = KEYS[6]
local orphanIndexKey = KEYS[7]
local orphanAccountingKey = KEYS[8]
local nodeId = ARGV[1]
local deliveryId = ARGV[2]
local batchSize = tonumber(ARGV[3])
local members = redis.call("srandmember", setKey, batchSize)
local removed = {}

for _, clientId in ipairs(members) do
    local existing = redis.call("hget", clientsKey, clientId)
    if existing then
        local decoded, parsed = pcall(cjson.decode, existing)
        if decoded and type(parsed) == "table" and tostring(parsed.nodeId) == nodeId and (parsed.state or "active") == "active" then
            table.insert(removed, existing)
            table.insert(removed, clientId)
        end
    end
end

if #removed > 0 then
    local time = redis.call("time")
    local nowMs = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
    if redis.call("exists", orphanAccountingKey) == 0 and redis.call("hlen", orphanKey) > 0 then
        return { "FULL" }
    end
    local cursor = redis.call("hget", orphanAccountingKey, "sweepCursor") or "0"
    local scan = redis.call("hscan", orphanKey, cursor, "COUNT", 100)
    redis.call("hset", orphanAccountingKey, "sweepCursor", scan[1])
    for scanIndex = 1, #scan[2], 2 do
        local scanId = scan[2][scanIndex]
        local scanRaw = scan[2][scanIndex + 1]
        local decoded, scanItem = pcall(cjson.decode, scanRaw)
        local valid = decoded and type(scanItem) == "table"
        if not valid or tonumber(scanItem.expiresAt or 0) <= nowMs then
            redis.call("hdel", orphanKey, scanId)
            redis.call("zrem", orphanIndexKey, scanId)
            redis.call("hincrby", orphanAccountingKey, "items", -1)
            redis.call("hincrby", orphanAccountingKey, "bytes", -(valid and tonumber(scanItem.accountedBytes) or string.len(scanRaw)))
        end
    end
    local orphanItem = {
        nodeId = tonumber(nodeId),
        records = removed,
        expiresAt = nowMs + ${ORPHAN_TTL_SECONDS * 1000},
        claimedUntil = 0,
        claimToken = ""
    }
    orphanItem.accountedBytes = string.len(cjson.encode(orphanItem)) + 128
    local orphan = cjson.encode(orphanItem)
    local items = tonumber(redis.call("hget", orphanAccountingKey, "items")) or 0
    local bytes = tonumber(redis.call("hget", orphanAccountingKey, "bytes")) or 0
    if items + 1 > tonumber(ARGV[4]) or bytes + orphanItem.accountedBytes > tonumber(ARGV[5]) then
        return { "FULL" }
    end
    redis.call("hset", orphanKey, deliveryId, orphan)
    redis.call("zadd", orphanIndexKey, 0, deliveryId)
    redis.call("hset", orphanAccountingKey, "items", items + 1, "bytes", bytes + orphanItem.accountedBytes)
end

for _, clientId in ipairs(members) do
    redis.call("srem", setKey, clientId)
    local existing = redis.call("hget", clientsKey, clientId)
    if existing then
        local decoded, parsed = pcall(cjson.decode, existing)
        if not decoded or type(parsed) ~= "table" or tostring(parsed.nodeId) == nodeId then
            redis.call("hdel", clientsKey, clientId)
        end
    end
end

for _, clientId in ipairs(redis.call("spop", nodeClaimsKey, batchSize)) do
    redis.call("hdel", claimsKey, clientId)
    redis.call("zrem", claimsIndexKey, clientId)
end
local done = redis.call("scard", setKey) == 0 and redis.call("scard", nodeClaimsKey) == 0
if done then
    redis.call("del", setKey)
    redis.call("del", nodeClaimsKey)
end
table.insert(removed, 1, done and "1" or "0")
return removed
`;

const REFRESH_NODE_SCRIPT = `
local clientsKey = KEYS[1]
local setKey = KEYS[2]
local ttl = tonumber(ARGV[1])
if redis.call("exists", setKey) == 1 then
    redis.call("expire", setKey, ttl)
    redis.call("expire", clientsKey, ttl)
end
return 1
`;

// CLAIM leaves the current active owner untouched and records a private,
// bounded reservation.  This is the first half of a takeover: it prevents
// two contenders from both fencing the old generation while it remains the
// authoritative record for lookup and delivery.
const CLAIM_SCRIPT = `
local clientsKey = KEYS[1]
local claimsKey = KEYS[2]
local claimsIndexKey = KEYS[3]
local nodeClaimsKey = KEYS[4]
local clientId = ARGV[1]
local nodeId = ARGV[2]
local metadataJson = ARGV[3]
local hasMetadata = ARGV[4] == "1"
local state = ARGV[5]
local allowSupersede = ARGV[6] == "1"
local connectionId = ARGV[7]
local processId = ARGV[8]
local claimId = ARGV[9]
local connectedAt = tonumber(ARGV[10])
local claimSetKeyPrefix = ARGV[11]
local maxClientsPerNode = tonumber(ARGV[12])
local operationId = ARGV[13]
local requestFingerprint = ARGV[14]
local ttl = ${KEY_TTL_SECONDS}

if connectionId == "" then
    return { "conflict", "" }
end

local time = redis.call("time")
local nowMs = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local expiredClaims = redis.call("zrangebyscore", claimsIndexKey, "-inf", nowMs, "LIMIT", 0, 100)
for _, expiredClientId in ipairs(expiredClaims) do
    local rawExpired = redis.call("hget", claimsKey, expiredClientId)
    if rawExpired then
        local expiredClaim = cjson.decode(rawExpired)
        redis.call("srem", claimSetKeyPrefix .. tostring(expiredClaim.nodeId) .. ":claims", expiredClientId)
    end
    redis.call("hdel", claimsKey, expiredClientId)
    redis.call("zrem", claimsIndexKey, expiredClientId)
end

local existingClaim = redis.call("hget", claimsKey, clientId)
if existingClaim then
    local claim = cjson.decode(existingClaim)
    if tonumber(claim.expiresAt or 0) <= nowMs then
        redis.call("hdel", claimsKey, clientId)
        redis.call("zrem", claimsIndexKey, clientId)
        redis.call("srem", claimSetKeyPrefix .. tostring(claim.nodeId) .. ":claims", clientId)
    else
        if claim.operationId == operationId and claim.requestFingerprint == requestFingerprint then
            return { "ok", claim.claimId, claim.previous or "" }
        end
        local active = redis.call("hget", clientsKey, clientId)
        if active then return { "conflict", active } end
        return { "conflict", "" }
    end
end

local previous = redis.call("hget", clientsKey, clientId)
local preimage = previous or ""
local expectCurrent = previous and true or false
if previous then
    local parsed = cjson.decode(previous)
    if parsed.connectionId == nil or tostring(parsed.connectionId) == "" then
        return { "conflict", previous }
    end
    if tostring(parsed.nodeId) ~= nodeId and not allowSupersede then
        return { "conflict", previous }
    end
    -- An exact retry by the current generation is an update, not a takeover.
    if tostring(parsed.nodeId) == nodeId and tostring(parsed.connectionId or "") == connectionId then
        previous = ""
    end
end

if redis.call("sismember", nodeClaimsKey, clientId) == 0 and redis.call("scard", nodeClaimsKey) >= ${MAX_CLAIMS_PER_NODE} then
    return { "capacity", "", "" }
end
local newSetKey = claimSetKeyPrefix .. nodeId .. ":clients"
if redis.call("sismember", newSetKey, clientId) == 0
    and redis.call("scard", newSetKey) + redis.call("scard", nodeClaimsKey) >= maxClientsPerNode then
    return { "node-capacity", "", "" }
end
redis.call("hset", claimsKey, clientId, cjson.encode({
    claimId = claimId, nodeId = tonumber(nodeId), metadata = cjson.decode(metadataJson),
    hasMetadata = hasMetadata, state = state, connectionId = connectionId,
    processId = processId, connectedAt = connectedAt, expiresAt = nowMs + ${CLAIM_TTL_MS},
    previous = previous, preimage = preimage, expectCurrent = expectCurrent,
    operationId = operationId, requestFingerprint = requestFingerprint
}))
redis.call("zadd", claimsIndexKey, nowMs + ${CLAIM_TTL_MS}, clientId)
redis.call("sadd", nodeClaimsKey, clientId)
redis.call("expire", claimsKey, ttl)
redis.call("expire", claimsIndexKey, ttl)
redis.call("expire", nodeClaimsKey, ttl)
return { "ok", claimId, previous or "" }
`;

// COMMIT rejects any changed old generation, but accepts its exact absence after
// the acknowledged fence: unregister may have removed it before commit and must
// not leave a phantom claim. A stable-token mutation is reported for exact
// reconciliation; an unrelated reconnect is rejected without mutation.
const COMMIT_CLAIM_SCRIPT = `
local clientsKey = KEYS[1]
local claimsKey = KEYS[2]
local newSetKey = KEYS[3]
local claimsIndexKey = KEYS[4]
local nodeClaimsKey = KEYS[5]
local clientId = ARGV[1]
local nodeId = ARGV[2]
local claimId = ARGV[3]
local setKeyPrefix = ARGV[4]
local maxClientsPerNode = tonumber(ARGV[5])
local ttl = ${KEY_TTL_SECONDS}
local rawClaim = redis.call("hget", claimsKey, clientId)
if not rawClaim then
    -- The atomic commit may have succeeded while its response was lost.
    -- Only the exact persisted claim marker makes a retry successful.
    local committed = redis.call("hget", clientsKey, clientId)
    if not committed then return 0 end
    local committedRecord = cjson.decode(committed)
    if tostring(committedRecord.nodeId) == nodeId and committedRecord.claimId == claimId then return 1 end
    return 0
end
local claim = cjson.decode(rawClaim)
if tostring(claim.nodeId) ~= nodeId or claim.claimId ~= claimId then return 0 end
local now = redis.call("time")
local nowMs = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000)
if tonumber(claim.expiresAt or 0) <= nowMs then
    redis.call("hdel", claimsKey, clientId)
    redis.call("zrem", claimsIndexKey, clientId)
    redis.call("srem", nodeClaimsKey, clientId)
    return 0
end
local current = redis.call("hget", clientsKey, clientId)
local previous = claim.previous or ""
if previous == "" then
    -- Same-generation retries still compare the exact captured record. A
    -- metadata/state transition after CLAIM is not authorization to overwrite
    -- that changed record.
    local preimage = claim.preimage or ""
    if preimage ~= "" then
        if not current or current ~= preimage then return 0 end
    elseif current then
        return 0
    end
else
    local before = cjson.decode(previous)
    if current and current ~= previous then
        local currentParsed = cjson.decode(current)
        -- Signal a mutation by the exact same stable generation. The caller
        -- has already fenced that physical connection and may remove it with
        -- REMOVE_CLAIM_PREVIOUS before retrying this exact claim. A reconnect
        -- with any other token is never removed or overwritten.
        if before.claimId and currentParsed.claimId == before.claimId
            and tostring(before.nodeId) == tostring(currentParsed.nodeId)
            and tostring(before.connectionId or "") == tostring(currentParsed.connectionId or "") then
            return 2
        end
        return 0
    end
    -- The exact old generation may have synchronously unregistered while
    -- acknowledging its fence. Absence is therefore safe; only a different
    -- generation prevents this claim from committing.
    redis.call("srem", setKeyPrefix .. tostring(before.nodeId) .. ":clients", clientId)
end
if redis.call("sismember", newSetKey, clientId) == 0 and redis.call("scard", newSetKey) >= maxClientsPerNode then
    return 0
end
local value = cjson.encode({ nodeId = claim.nodeId, connectedAt = claim.connectedAt, state = claim.state, claimId = claim.claimId,
    connectionId = claim.connectionId, processId = claim.processId, hasMetadata = claim.hasMetadata, metadata = claim.metadata })
redis.call("hset", clientsKey, clientId, value)
redis.call("sadd", newSetKey, clientId)
redis.call("hdel", claimsKey, clientId)
redis.call("zrem", claimsIndexKey, clientId)
redis.call("srem", nodeClaimsKey, clientId)
redis.call("expire", clientsKey, ttl)
redis.call("expire", newSetKey, ttl)
return 1
`;

const REMOVE_CLAIM_PREVIOUS_SCRIPT = `
local clientsKey = KEYS[1]
local claimsKey = KEYS[2]
local clientId = ARGV[1]
local nodeId = ARGV[2]
local claimId = ARGV[3]
local setKeyPrefix = ARGV[4]
local rawClaim = redis.call("hget", claimsKey, clientId)
if not rawClaim then return 0 end
local claim = cjson.decode(rawClaim)
if tostring(claim.nodeId) ~= nodeId or claim.claimId ~= claimId then return 0 end
local previous = claim.previous or ""
if previous == "" then return 0 end
local before = cjson.decode(previous)
local current = redis.call("hget", clientsKey, clientId)
if not current then return 1 end
if current ~= previous then
    local currentParsed = cjson.decode(current)
    if not before.claimId or currentParsed.claimId ~= before.claimId
        or tostring(currentParsed.nodeId) ~= tostring(before.nodeId)
        or tostring(currentParsed.connectionId or "") ~= tostring(before.connectionId or "") then
        return 0
    end
end
redis.call("hdel", clientsKey, clientId)
redis.call("srem", setKeyPrefix .. tostring(before.nodeId) .. ":clients", clientId)
return 1
`;

const REMOVE_CLAIM_RESULT_SCRIPT = `
local clientId = ARGV[1]
local nodeId = ARGV[2]
local claimId = ARGV[3]
local removed = 0
local committed = redis.call("hget", KEYS[1], clientId)
if committed then
    local record = cjson.decode(committed)
    if tostring(record.nodeId) == nodeId and record.claimId == claimId then
        redis.call("hdel", KEYS[1], clientId)
        redis.call("srem", KEYS[2], clientId)
        removed = 1
    end
end
local rawClaim = redis.call("hget", KEYS[3], clientId)
if rawClaim then
    local claim = cjson.decode(rawClaim)
    if tostring(claim.nodeId) == nodeId and claim.claimId == claimId then
        redis.call("hdel", KEYS[3], clientId)
        redis.call("zrem", KEYS[4], clientId)
        redis.call("srem", KEYS[5], clientId)
        removed = 1
    end
end
return removed
`;

const ABORT_CLAIM_SCRIPT = `
local rawClaim = redis.call("hget", KEYS[1], ARGV[1])
if not rawClaim then return 0 end
local claim = cjson.decode(rawClaim)
if tostring(claim.nodeId) ~= ARGV[2] or claim.claimId ~= ARGV[3] then return 0 end
redis.call("hdel", KEYS[1], ARGV[1])
redis.call("zrem", KEYS[2], ARGV[1])
redis.call("srem", KEYS[3], ARGV[1])
return 1
`;

const CLAIM_ORPHAN_SCRIPT = `
local key = KEYS[1]
local indexKey = KEYS[2]
local accountingKey = KEYS[3]
local token = ARGV[1]
local time = redis.call("time")
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
if redis.call("exists", accountingKey) == 0 then return { "", "" } end
-- Sweep a bounded HSCAN slice on every drain attempt.  This gives each
-- snapshot its own expiry rather than extending the whole queue's TTL when a
-- newer item is admitted.
local cursor = redis.call("hget", accountingKey, "sweepCursor") or "0"
local scan = redis.call("hscan", key, cursor, "COUNT", 100)
redis.call("hset", accountingKey, "sweepCursor", scan[1])
for index = 1, #scan[2], 2 do
    local scanId = scan[2][index]
    local scanRaw = scan[2][index + 1]
    local decoded, scanItem = pcall(cjson.decode, scanRaw)
    local valid = decoded and type(scanItem) == "table"
    if not valid or tonumber(scanItem.expiresAt or 0) <= now then
        redis.call("hdel", key, scanId)
        redis.call("zrem", indexKey, scanId)
        redis.call("hincrby", accountingKey, "items", -1)
        redis.call("hincrby", accountingKey, "bytes", -(valid and tonumber(scanItem.accountedBytes) or string.len(scanRaw)))
    end
end
if redis.call("hlen", key) == 0 then
    redis.call("del", accountingKey)
    return { "", "" }
end
local candidates = redis.call("zrangebyscore", indexKey, "-inf", now, "LIMIT", 0, ${MAX_ORPHAN_CLAIM_SCAN})
for _, id in ipairs(candidates) do
    local raw = redis.call("hget", key, id)
    if raw then
        local decoded, item = pcall(cjson.decode, raw)
        if not decoded or type(item) ~= "table" then
            redis.call("hdel", key, id)
            redis.call("zrem", indexKey, id)
            redis.call("hincrby", accountingKey, "items", -1)
            redis.call("hincrby", accountingKey, "bytes", -string.len(raw))
        elseif tonumber(item.expiresAt or 0) <= now then
            redis.call("hdel", key, id)
            redis.call("zrem", indexKey, id)
            redis.call("hincrby", accountingKey, "items", -1)
            redis.call("hincrby", accountingKey, "bytes", -(tonumber(item.accountedBytes) or string.len(raw)))
        elseif tonumber(item.claimedUntil or 0) <= now then
            item.claimToken = token
            item.claimedUntil = now + ${ORPHAN_CLAIM_MS}
            local updated = cjson.encode(item)
            redis.call("hset", key, id, updated)
            redis.call("zadd", indexKey, item.claimedUntil, id)
            return { id, updated }
        end
    else
        redis.call("zrem", indexKey, id)
    end
end
if redis.call("hlen", key) == 0 then redis.call("del", accountingKey) end
return { "", "" }
`;

const ACK_ORPHAN_SCRIPT = `
local raw = redis.call("hget", KEYS[1], ARGV[1])
if not raw then return 0 end
local item = cjson.decode(raw)
if item.claimToken ~= ARGV[2] then return 0 end
redis.call("hdel", KEYS[1], ARGV[1])
redis.call("zrem", KEYS[2], ARGV[1])
redis.call("hincrby", KEYS[3], "items", -1)
redis.call("hincrby", KEYS[3], "bytes", -(tonumber(item.accountedBytes) or string.len(raw)))
if redis.call("hlen", KEYS[1]) == 0 then redis.call("del", KEYS[3]) end
return 1
`;

const NACK_ORPHAN_SCRIPT = `
local raw = redis.call("hget", KEYS[1], ARGV[1])
if not raw then return 0 end
local item = cjson.decode(raw)
if item.claimToken ~= ARGV[2] then return 0 end
item.claimToken = ""
item.claimedUntil = 0
local updated = cjson.encode(item)
redis.call("hset", KEYS[1], ARGV[1], updated)
redis.call("zadd", KEYS[2], 0, ARGV[1])
return 1
`;

const ENQUEUE_ORPHAN_SCRIPT = `
local time = redis.call("time")
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
if redis.call("exists", KEYS[3]) == 0 and redis.call("hlen", KEYS[1]) > 0 then return 0 end
local cursor = redis.call("hget", KEYS[3], "sweepCursor") or "0"
local scan = redis.call("hscan", KEYS[1], cursor, "COUNT", 100)
redis.call("hset", KEYS[3], "sweepCursor", scan[1])
for index = 1, #scan[2], 2 do
    local scanId = scan[2][index]
    local scanRaw = scan[2][index + 1]
    local decoded, scanItem = pcall(cjson.decode, scanRaw)
    local valid = decoded and type(scanItem) == "table"
    if not valid or tonumber(scanItem.expiresAt or 0) <= now then
        redis.call("hdel", KEYS[1], scanId)
        redis.call("zrem", KEYS[2], scanId)
        redis.call("hincrby", KEYS[3], "items", -1)
        redis.call("hincrby", KEYS[3], "bytes", -(valid and tonumber(scanItem.accountedBytes) or string.len(scanRaw)))
    end
end
local itemTable = {
    nodeId = tonumber(ARGV[2]),
    clients = cjson.decode(ARGV[3]),
    expiresAt = now + ${ORPHAN_TTL_SECONDS * 1000},
    claimedUntil = 0,
    claimToken = ""
}
itemTable.accountedBytes = string.len(cjson.encode(itemTable)) + 128
local item = cjson.encode(itemTable)
local old = redis.call("hget", KEYS[1], ARGV[1])
local items = tonumber(redis.call("hget", KEYS[3], "items")) or 0
local bytes = tonumber(redis.call("hget", KEYS[3], "bytes")) or 0
local oldItem = old and cjson.decode(old) or nil
local oldBytes = oldItem and (tonumber(oldItem.accountedBytes) or string.len(old)) or 0
local nextItems = items + (old and 0 or 1)
local nextBytes = bytes - oldBytes + itemTable.accountedBytes
if nextItems > tonumber(ARGV[4]) or nextBytes > tonumber(ARGV[5]) then return 0 end
redis.call("hset", KEYS[1], ARGV[1], item)
redis.call("zadd", KEYS[2], 0, ARGV[1])
redis.call("hset", KEYS[3], "items", nextItems, "bytes", nextBytes)
return 1
`;

const CONSUME_AUTH_NONCE_SCRIPT = `
local time = redis.call("time")
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local expiresAt = tonumber(ARGV[2])
local principal = ARGV[3]
local maxPrincipals = tonumber(ARGV[4])
local maxNonces = tonumber(ARGV[5])
if not expiresAt or expiresAt <= now then return 0 end
redis.call("zremrangebyscore", KEYS[2], "-inf", now)
if redis.call("zscore", KEYS[2], principal) == false and redis.call("zcard", KEYS[2]) >= maxPrincipals then return 0 end
redis.call("zremrangebyscore", KEYS[1], "-inf", now)
if redis.call("zcard", KEYS[1]) >= maxNonces then return 0 end
if redis.call("zadd", KEYS[1], "NX", expiresAt, ARGV[1]) == 0 then return 0 end
local latest = redis.call("zrevrange", KEYS[1], 0, 0, "WITHSCORES")
local latestExpiry = tonumber(latest[2]) or expiresAt
redis.call("pexpire", KEYS[1], math.max(1, latestExpiry - now))
-- Do not let a short-lived nonce from one principal reduce the global index
-- TTL, nor let a new nonce shorten that principal's previously-live score.
local priorPrincipalExpiry = tonumber(redis.call("zscore", KEYS[2], principal)) or 0
local principalExpiry = math.max(priorPrincipalExpiry, latestExpiry)
redis.call("zadd", KEYS[2], principalExpiry, principal)
local globalLatest = redis.call("zrevrange", KEYS[2], 0, 0, "WITHSCORES")
local globalExpiry = tonumber(globalLatest[2]) or principalExpiry
redis.call("pexpire", KEYS[2], math.max(1, globalExpiry - now))
return 1
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
        state: string,
        connectionId: string,
        processId: string,
        generationId: string,
        maxClientsPerNode: string
    ) => Promise<[number | string, string?]>;
    MC_ACTIVATE: (
        clientsKey: string,
        setKey: string,
        clientId: string,
        nodeId: string,
        metadataJson: string,
        hasMetadata: string,
        connectionId: string
    ) => Promise<number>;
    MC_UNREGISTER: (
        clientsKey: string,
        setKey: string,
        claimsKey: string,
        claimsIndexKey: string,
        nodeClaimsKey: string,
        clientId: string,
        nodeId: string,
        connectionId: string
    ) => Promise<number>;
    MC_UPDATE_METADATA: (
        clientsKey: string,
        clientId: string,
        nodeId: string,
        metadataJson: string,
        hasMetadata: string,
        connectionId: string
    ) => Promise<number>;
    MC_CLEANUP_NODE: (...args: string[]) => Promise<string[]>;
    MC_CLEANUP_NODE_AND_ORPHAN: (...args: string[]) => Promise<string[]>;
    MC_REFRESH_NODE: (clientsKey: string, setKey: string, ttl: string) => Promise<number>;
    MC_CLAIM: (...args: string[]) => Promise<[string, string, string?]>;
    MC_COMMIT_CLAIM: (...args: string[]) => Promise<number>;
    MC_REMOVE_CLAIM_PREVIOUS: (...args: string[]) => Promise<number>;
    MC_ABORT_CLAIM: (...args: string[]) => Promise<number>;
    MC_REMOVE_CLAIM_RESULT: (...args: string[]) => Promise<number>;
    MC_CLAIM_ORPHAN: (...args: string[]) => Promise<[string, string]>;
    MC_ACK_ORPHAN: (...args: string[]) => Promise<number>;
    MC_NACK_ORPHAN: (...args: string[]) => Promise<number>;
    MC_ENQUEUE_ORPHAN: (...args: string[]) => Promise<number>;
    MC_CONSUME_AUTH_NONCE: (...args: string[]) => Promise<number>;
};

let clientRedis: { client: ClientRedisClient; prefix: string } | null = null;

function getClientRedis(): { client: ClientRedisClient; prefix: string } {
    if (!clientRedis) {
        const { client, prefix } = createRedis('MESH');
        client.defineCommand('MC_REGISTER', { lua: REGISTER_SCRIPT, numberOfKeys: 2 });
        client.defineCommand('MC_ACTIVATE', { lua: ACTIVATE_SCRIPT, numberOfKeys: 2 });
        client.defineCommand('MC_UNREGISTER', { lua: UNREGISTER_SCRIPT, numberOfKeys: 5 });
        client.defineCommand('MC_UPDATE_METADATA', { lua: UPDATE_METADATA_SCRIPT, numberOfKeys: 1 });
        client.defineCommand('MC_CLEANUP_NODE', { lua: CLEANUP_NODE_SCRIPT, numberOfKeys: 5 });
        client.defineCommand('MC_CLEANUP_NODE_AND_ORPHAN', { lua: CLEANUP_NODE_AND_ORPHAN_SCRIPT, numberOfKeys: 8 });
        client.defineCommand('MC_REFRESH_NODE', { lua: REFRESH_NODE_SCRIPT, numberOfKeys: 2 });
        client.defineCommand('MC_CLAIM', { lua: CLAIM_SCRIPT, numberOfKeys: 4 });
        client.defineCommand('MC_COMMIT_CLAIM', { lua: COMMIT_CLAIM_SCRIPT, numberOfKeys: 5 });
        client.defineCommand('MC_REMOVE_CLAIM_PREVIOUS', { lua: REMOVE_CLAIM_PREVIOUS_SCRIPT, numberOfKeys: 2 });
        client.defineCommand('MC_ABORT_CLAIM', { lua: ABORT_CLAIM_SCRIPT, numberOfKeys: 3 });
        client.defineCommand('MC_REMOVE_CLAIM_RESULT', { lua: REMOVE_CLAIM_RESULT_SCRIPT, numberOfKeys: 5 });
        client.defineCommand('MC_CLAIM_ORPHAN', { lua: CLAIM_ORPHAN_SCRIPT, numberOfKeys: 3 });
        client.defineCommand('MC_ACK_ORPHAN', { lua: ACK_ORPHAN_SCRIPT, numberOfKeys: 3 });
        client.defineCommand('MC_NACK_ORPHAN', { lua: NACK_ORPHAN_SCRIPT, numberOfKeys: 3 });
        client.defineCommand('MC_ENQUEUE_ORPHAN', { lua: ENQUEUE_ORPHAN_SCRIPT, numberOfKeys: 3 });
        client.defineCommand('MC_CONSUME_AUTH_NONCE', { lua: CONSUME_AUTH_NONCE_SCRIPT, numberOfKeys: 2 });
        const nextClient = client as ClientRedisClient;
        registerRedisStateReset(nextClient, () => {
            if (clientRedis?.client === nextClient) clientRedis = null;
        });
        clientRedis = { client: nextClient, prefix };
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
    private readonly maxClientIdBytes: number;
    private readonly maxMetadataBytes: number;
    private readonly maxClientsPerNode: number;
    private readonly scanBatchSize: number;
    private readonly cleanupBatchSize: number;
    private readonly maxAuthReplayPrincipals: number;
    private readonly maxAuthNoncesPerPrincipal: number;
    private readonly maxOrphanItems: number;
    private readonly maxOrphanBytes: number;

    constructor(key: string, options: MeshClientRedisRegistryOptions = {}) {
        this.key = key;
        this.maxClientIdBytes = configuredLimit(options.maxClientIdBytes, DEFAULT_MAX_CLIENT_ID_BYTES, 'maxClientIdBytes');
        this.maxMetadataBytes = configuredLimit(options.maxMetadataBytes, DEFAULT_MAX_METADATA_BYTES, 'maxMetadataBytes');
        this.maxClientsPerNode = configuredLimit(options.maxClientsPerNode, DEFAULT_MAX_CLIENTS_PER_NODE, 'maxClientsPerNode');
        this.scanBatchSize = configuredLimit(options.scanBatchSize, DEFAULT_SCAN_BATCH_SIZE, 'scanBatchSize');
        this.cleanupBatchSize = configuredLimit(options.cleanupBatchSize, DEFAULT_CLEANUP_BATCH_SIZE, 'cleanupBatchSize');
        this.maxAuthReplayPrincipals = configuredLimit(
            options.maxAuthReplayPrincipals,
            DEFAULT_MAX_AUTH_REPLAY_PRINCIPALS,
            'maxAuthReplayPrincipals'
        );
        this.maxAuthNoncesPerPrincipal = configuredLimit(
            options.maxAuthNoncesPerPrincipal,
            DEFAULT_MAX_AUTH_NONCES_PER_PRINCIPAL,
            'maxAuthNoncesPerPrincipal'
        );
        this.maxOrphanItems = configuredLimit(options.maxOrphanItems, DEFAULT_MAX_ORPHAN_ITEMS, 'maxOrphanItems');
        this.maxOrphanBytes = configuredLimit(options.maxOrphanBytes, DEFAULT_MAX_ORPHAN_BYTES, 'maxOrphanBytes');
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

    private nodeClaimsKey(nodeId: number): string {
        return `${this.nodeSetKeyPrefix()}${nodeId}:claims`;
    }

    private claimsKey(): string {
        const { prefix } = getClientRedis();
        return `${prefix}:mesh:${this.key}:claims`;
    }

    private claimsIndexKey(): string {
        const { prefix } = getClientRedis();
        return `${prefix}:mesh:${this.key}:claims:index`;
    }

    private orphanedKey(): string {
        const { prefix } = getClientRedis();
        return `${prefix}:mesh:${this.key}:orphaned`;
    }

    private orphanedIndexKey(): string {
        const { prefix } = getClientRedis();
        return `${prefix}:mesh:${this.key}:orphaned:index`;
    }

    private orphanedAccountingKey(): string {
        const { prefix } = getClientRedis();
        return `${prefix}:mesh:${this.key}:orphaned:accounting`;
    }

    private authNonceKey(principal: string): string {
        const { prefix } = getClientRedis();
        const principalHash = createHash('sha256').update(principal).digest('hex');
        return `${prefix}:mesh:${this.key}:auth-nonces:${principalHash}`;
    }

    private authNoncePrincipalsKey(): string {
        const { prefix } = getClientRedis();
        return `${prefix}:mesh:${this.key}:auth-nonce-principals`;
    }

    private encodeMetadata(metadata: TMeta): { metadataJson: string; hasMetadata: '0' | '1' } {
        if (metadata === undefined) {
            return { metadataJson: 'null', hasMetadata: '0' };
        }

        const metadataJson = JSON.stringify(metadata);
        if (metadataJson === undefined) {
            throw new Error('Mesh client metadata must be JSON-serializable');
        }
        if (Buffer.byteLength(metadataJson) > this.maxMetadataBytes) {
            throw new Error(`Mesh client metadata exceeds the configured ${this.maxMetadataBytes}-byte limit`);
        }

        return { metadataJson, hasMetadata: '1' };
    }

    private async registerWithState(
        clientId: string,
        nodeId: number,
        metadata: TMeta,
        allowSupersede: boolean,
        state: MeshClientRegistrationState,
        connectionId: string,
        processId?: string
    ): Promise<RegisterResult> {
        this.assertClientId(clientId);
        const { client } = getClientRedis();
        const encoded = this.encodeMetadata(metadata);
        const [rawStatus, rawSupersededConnectionId] = await client.MC_REGISTER(
            this.clientsKey(),
            this.nodeSetKey(nodeId),
            clientId,
            String(nodeId),
            encoded.metadataJson,
            encoded.hasMetadata,
            this.nodeSetKeyPrefix(),
            String(Date.now()),
            allowSupersede ? '1' : '0',
            state,
            connectionId,
            processId ?? '',
            randomUUID(),
            String(this.maxClientsPerNode)
        );
        const result = Number(rawStatus);
        if (result === -3) throw new Error('Mesh client per-node registration limit reached');
        if (result === -2) {
            // Conflict: the owner may have disappeared between the script
            // result and this follow-up read, so ownerNodeId can be null.
            const existing = await client.hget(this.clientsKey(), clientId);
            const parsed = existing ? this.tryParse(existing) : undefined;
            return { status: 'conflict', ownerNodeId: parsed?.nodeId ?? null };
        }
        const supersededConnectionId =
            typeof rawSupersededConnectionId === 'string' && rawSupersededConnectionId.length > 0 ? rawSupersededConnectionId : undefined;
        return {
            status: 'ok',
            supersededNodeId: result >= 0 ? result : null,
            ...(supersededConnectionId ? { supersededConnectionId } : {})
        };
    }

    async register(
        clientId: string,
        nodeId: number,
        metadata: TMeta,
        allowSupersede: boolean,
        connectionId: string,
        processId?: string
    ): Promise<RegisterResult> {
        return this.registerWithState(clientId, nodeId, metadata, allowSupersede, 'active', connectionId, processId);
    }

    async reserve(
        clientId: string,
        nodeId: number,
        metadata: TMeta,
        allowSupersede: boolean,
        connectionId: string,
        processId?: string
    ): Promise<RegisterResult> {
        return this.registerWithState(clientId, nodeId, metadata, allowSupersede, 'pending', connectionId, processId);
    }

    async activate(clientId: string, nodeId: number, metadata: TMeta, connectionId: string): Promise<boolean> {
        this.assertClientId(clientId);
        const { client } = getClientRedis();
        const encoded = this.encodeMetadata(metadata);
        const result = await client.MC_ACTIVATE(
            this.clientsKey(),
            this.nodeSetKey(nodeId),
            clientId,
            String(nodeId),
            encoded.metadataJson,
            encoded.hasMetadata,
            connectionId
        );
        return result === 1;
    }

    async unregister(clientId: string, nodeId: number, connectionId: string): Promise<boolean> {
        this.assertClientId(clientId);
        const { client } = getClientRedis();
        const result = await client.MC_UNREGISTER(
            this.clientsKey(),
            this.nodeSetKey(nodeId),
            this.claimsKey(),
            this.claimsIndexKey(),
            this.nodeClaimsKey(nodeId),
            clientId,
            String(nodeId),
            connectionId
        );
        return result === 1;
    }

    async updateMetadata(clientId: string, nodeId: number, metadata: TMeta, connectionId: string): Promise<boolean> {
        this.assertClientId(clientId);
        const { client } = getClientRedis();
        const encoded = this.encodeMetadata(metadata);
        const result = await client.MC_UPDATE_METADATA(
            this.clientsKey(),
            clientId,
            String(nodeId),
            encoded.metadataJson,
            encoded.hasMetadata,
            connectionId
        );
        return result === 1;
    }

    private tryParse(raw: string):
        | {
              nodeId: number;
              connectionId: string;
              processId?: string;
              connectedAt: number;
              metadata: TMeta;
              state: MeshClientRegistrationState;
              claimId?: string;
          }
        | undefined {
        try {
            const parsed = JSON.parse(raw) as {
                nodeId: number;
                connectedAt: number;
                hasMetadata?: boolean;
                metadata: TMeta;
                state?: MeshClientRegistrationState;
                connectionId?: string;
                processId?: string;
                claimId?: string;
            };
            if (typeof parsed.connectionId !== 'string' || parsed.connectionId.length === 0) return undefined;
            return {
                nodeId: parsed.nodeId,
                connectionId: parsed.connectionId,
                processId: parsed.processId,
                connectedAt: parsed.connectedAt,
                metadata: parsed.hasMetadata === false ? (undefined as TMeta) : parsed.metadata,
                state: parsed.state ?? 'active',
                claimId: parsed.claimId
            };
        } catch {
            return undefined;
        }
    }

    private toRegisteredClient(
        clientId: string,
        parsed: {
            nodeId: number;
            connectionId: string;
            processId?: string;
            connectedAt: number;
            metadata: TMeta;
            state: MeshClientRegistrationState;
            claimId?: string;
        }
    ): RegisteredClient<TMeta> | undefined {
        if (parsed.state !== 'active') {
            return undefined;
        }
        return {
            clientId,
            nodeId: parsed.nodeId,
            connectionId: parsed.connectionId,
            processId: parsed.processId,
            connectedAt: parsed.connectedAt,
            metadata: parsed.metadata
        };
    }

    private toClientRecord(
        clientId: string,
        parsed: {
            nodeId: number;
            connectionId: string;
            processId?: string;
            connectedAt: number;
            metadata: TMeta;
            state: MeshClientRegistrationState;
            claimId?: string;
        }
    ): MeshClientRecord<TMeta> {
        return {
            clientId,
            nodeId: parsed.nodeId,
            connectionId: parsed.connectionId,
            processId: parsed.processId,
            connectedAt: parsed.connectedAt,
            metadata: parsed.metadata,
            state: parsed.state,
            claimId: parsed.claimId
        };
    }

    async getClient(clientId: string): Promise<RegisteredClient<TMeta> | undefined> {
        this.assertClientId(clientId);
        const { client } = getClientRedis();
        const raw = await client.hget(this.clientsKey(), clientId);
        if (!raw) return undefined;

        const parsed = this.tryParse(raw);
        if (!parsed) return undefined;

        return this.toRegisteredClient(clientId, parsed);
    }

    async getClientIncludingPending(clientId: string): Promise<MeshClientRecord<TMeta> | undefined> {
        this.assertClientId(clientId);
        const { client } = getClientRedis();
        const raw = await client.hget(this.clientsKey(), clientId);
        if (!raw) return undefined;
        const parsed = this.tryParse(raw);
        return parsed ? this.toClientRecord(clientId, parsed) : undefined;
    }

    async listClients(): Promise<RegisteredClient<TMeta>[]> {
        const results: RegisteredClient<TMeta>[] = [];
        const seen = new Set<string>();
        let cursor: string | undefined = '0';
        do {
            const page = await this.listClientsPage(cursor);
            cursor = page.cursor;
            for (const registered of page.clients) {
                if (seen.has(registered.clientId)) continue;
                seen.add(registered.clientId);
                results.push(registered);
            }
        } while (cursor !== undefined);
        return results;
    }

    async listClientsForNode(nodeId: number): Promise<RegisteredClient<TMeta>[]> {
        const results: RegisteredClient<TMeta>[] = [];
        const seen = new Set<string>();
        let cursor: string | undefined = '0';
        do {
            const page = await this.listClientsForNodePage(nodeId, cursor);
            cursor = page.cursor;
            for (const registered of page.clients) {
                if (seen.has(registered.clientId)) continue;
                seen.add(registered.clientId);
                results.push(registered);
            }
        } while (cursor !== undefined);
        return results;
    }

    async listClientsPage(cursor = '0'): Promise<import('./types').MeshClientListPage<TMeta>> {
        assertRedisCursor(cursor);
        const { client } = getClientRedis();
        const [nextCursor, entries] = await client.hscan(this.clientsKey(), cursor, 'COUNT', this.scanBatchSize);
        const clients: RegisteredClient<TMeta>[] = [];
        for (let i = 0; i < entries.length; i += 2) {
            const parsed = this.tryParse(entries[i + 1]);
            if (!parsed) continue;
            const registered = this.toRegisteredClient(entries[i], parsed);
            if (registered) clients.push(registered);
        }
        return { clients, ...(nextCursor === '0' ? {} : { cursor: nextCursor }) };
    }

    async listClientsForNodePage(nodeId: number, cursor = '0'): Promise<import('./types').MeshClientListPage<TMeta>> {
        assertRedisCursor(cursor);
        const { client } = getClientRedis();
        const [nextCursor, clientIds] = await client.sscan(this.nodeSetKey(nodeId), cursor, 'COUNT', this.scanBatchSize);
        if (!clientIds.length) {
            return { clients: [], ...(nextCursor === '0' ? {} : { cursor: nextCursor }) };
        }
        const values = await client.hmget(this.clientsKey(), ...clientIds);
        const clients: RegisteredClient<TMeta>[] = [];
        for (let i = 0; i < clientIds.length; i++) {
            const raw = values[i];
            if (!raw) continue;
            const parsed = this.tryParse(raw);
            if (!parsed || parsed.nodeId !== nodeId) continue;
            const registered = this.toRegisteredClient(clientIds[i], parsed);
            if (registered) clients.push(registered);
        }
        return { clients, ...(nextCursor === '0' ? {} : { cursor: nextCursor }) };
    }

    async cleanupNode(nodeId: number): Promise<RegisteredClient<TMeta>[]> {
        const { client } = getClientRedis();
        const removed: RegisteredClient<TMeta>[] = [];
        let done = false;
        while (!done) {
            const result = await client.MC_CLEANUP_NODE(
                this.clientsKey(),
                this.nodeSetKey(nodeId),
                this.nodeClaimsKey(nodeId),
                this.claimsKey(),
                this.claimsIndexKey(),
                String(nodeId),
                String(this.cleanupBatchSize)
            );
            done = result.shift() === '1';
            removed.push(...this.decodeRemovedRecords(result));
        }
        return removed;
    }

    async cleanupNodeAndEnqueueOrphaned(nodeId: number): Promise<RegisteredClient<TMeta>[]> {
        const { client } = getClientRedis();
        const removed: RegisteredClient<TMeta>[] = [];
        let done = false;
        while (!done) {
            const result = await client.MC_CLEANUP_NODE_AND_ORPHAN(
                this.clientsKey(),
                this.nodeSetKey(nodeId),
                this.nodeClaimsKey(nodeId),
                this.claimsKey(),
                this.claimsIndexKey(),
                this.orphanedKey(),
                this.orphanedIndexKey(),
                this.orphanedAccountingKey(),
                String(nodeId),
                randomUUID(),
                String(this.cleanupBatchSize),
                String(this.maxOrphanItems),
                String(this.maxOrphanBytes)
            );
            if (result[0] === 'FULL') throw new Error('Mesh durable orphan queue is full');
            done = result.shift() === '1';
            removed.push(...this.decodeRemovedRecords(result));
        }
        return removed;
    }

    private decodeRemovedRecords(result: string[]): RegisteredClient<TMeta>[] {
        // Result is alternating [json, clientId, json, clientId, ...]
        const removed: RegisteredClient<TMeta>[] = [];
        for (let i = 0; i < result.length; i += 2) {
            const parsed = this.tryParse(result[i]);
            if (parsed) {
                removed.push({
                    clientId: result[i + 1],
                    nodeId: parsed.nodeId,
                    connectionId: parsed.connectionId,
                    processId: parsed.processId,
                    connectedAt: parsed.connectedAt,
                    metadata: parsed.metadata
                });
            }
        }
        return removed;
    }

    async refreshNode(nodeId: number): Promise<void> {
        const { client } = getClientRedis();
        await client.MC_REFRESH_NODE(this.clientsKey(), this.nodeSetKey(nodeId), String(KEY_TTL_SECONDS));
    }

    async claim(
        clientId: string,
        nodeId: number,
        metadata: TMeta,
        state: MeshClientRegistrationState,
        allowSupersede: boolean,
        connectionId: string,
        processId?: string,
        operationId = randomUUID()
    ): Promise<import('./types').MeshClientClaim<TMeta>> {
        this.assertClientId(clientId);
        if (Buffer.byteLength(operationId) < 16 || Buffer.byteLength(operationId) > 256) {
            throw new Error('Mesh client claim operation ID is outside the configured range');
        }
        const { client } = getClientRedis();
        const encoded = this.encodeMetadata(metadata);
        const requestFingerprint = createHash('sha256')
            .update(JSON.stringify([nodeId, encoded.metadataJson, encoded.hasMetadata, state, allowSupersede, connectionId, processId ?? '']))
            .digest('hex');
        const [status, value, rawPrevious] = await client.MC_CLAIM(
            this.clientsKey(),
            this.claimsKey(),
            this.claimsIndexKey(),
            this.nodeClaimsKey(nodeId),
            clientId,
            String(nodeId),
            encoded.metadataJson,
            encoded.hasMetadata,
            state,
            allowSupersede ? '1' : '0',
            connectionId,
            processId ?? '',
            randomUUID(),
            String(Date.now()),
            this.nodeSetKeyPrefix(),
            String(this.maxClientsPerNode),
            operationId,
            requestFingerprint
        );
        if (status === 'capacity') throw new Error('Too many pending mesh client claims for one node');
        if (status === 'node-capacity') throw new Error('Mesh client per-node registration limit reached');
        if (status !== 'ok') {
            const parsed = value ? this.tryParse(value) : undefined;
            return { status: 'conflict', ownerNodeId: parsed?.nodeId ?? null };
        }
        const parsed = rawPrevious ? this.tryParse(rawPrevious) : undefined;
        const previous = parsed ? this.toClientRecord(clientId, parsed) : undefined;
        return { status: 'ok', claimId: value, ...(previous ? { previous } : {}) };
    }

    async commitClaim(clientId: string, nodeId: number, claimId: string): Promise<import('./types').MeshClientClaimCommitResult> {
        const { client } = getClientRedis();
        const result = await client.MC_COMMIT_CLAIM(
            this.clientsKey(),
            this.claimsKey(),
            this.nodeSetKey(nodeId),
            this.claimsIndexKey(),
            this.nodeClaimsKey(nodeId),
            clientId,
            String(nodeId),
            claimId,
            this.nodeSetKeyPrefix(),
            String(this.maxClientsPerNode)
        );
        return result === 1 ? true : result === 2 ? 'previous-changed' : false;
    }

    async removeClaimPrevious(clientId: string, nodeId: number, claimId: string): Promise<boolean> {
        const { client } = getClientRedis();
        return (
            (await client.MC_REMOVE_CLAIM_PREVIOUS(
                this.clientsKey(),
                this.claimsKey(),
                clientId,
                String(nodeId),
                claimId,
                this.nodeSetKeyPrefix()
            )) === 1
        );
    }

    async abortClaim(clientId: string, nodeId: number, claimId: string): Promise<boolean> {
        const { client } = getClientRedis();
        return (
            (await client.MC_ABORT_CLAIM(this.claimsKey(), this.claimsIndexKey(), this.nodeClaimsKey(nodeId), clientId, String(nodeId), claimId)) ===
            1
        );
    }

    async removeClaimResult(clientId: string, nodeId: number, claimId: string): Promise<boolean> {
        const { client } = getClientRedis();
        return (
            (await client.MC_REMOVE_CLAIM_RESULT(
                this.clientsKey(),
                this.nodeSetKey(nodeId),
                this.claimsKey(),
                this.claimsIndexKey(),
                this.nodeClaimsKey(nodeId),
                clientId,
                String(nodeId),
                claimId
            )) === 1
        );
    }

    async enqueueOrphaned(nodeId: number, clients: RegisteredClient<TMeta>[]): Promise<void> {
        if (!clients.length) return;
        const { client } = getClientRedis();
        for (let offset = 0; offset < clients.length; offset += this.cleanupBatchSize) {
            const admitted = await client.MC_ENQUEUE_ORPHAN(
                this.orphanedKey(),
                this.orphanedIndexKey(),
                this.orphanedAccountingKey(),
                randomUUID(),
                String(nodeId),
                JSON.stringify(clients.slice(offset, offset + this.cleanupBatchSize)),
                String(this.maxOrphanItems),
                String(this.maxOrphanBytes)
            );
            if (admitted !== 1) throw new Error('Mesh durable orphan queue is full');
        }
    }

    async claimOrphaned(_claimerId: string): Promise<import('./types').OrphanedClientDelivery<TMeta> | undefined> {
        const { client } = getClientRedis();
        const token = randomUUID();
        const [id, raw] = await client.MC_CLAIM_ORPHAN(this.orphanedKey(), this.orphanedIndexKey(), this.orphanedAccountingKey(), token);
        if (!id || !raw) return undefined;
        const item = JSON.parse(raw) as {
            nodeId: number;
            clients?: RegisteredClient<TMeta>[];
            records?: string[];
        };
        const clients = item.clients ?? this.decodeRemovedRecords(item.records ?? []);
        return { id, nodeId: item.nodeId, clients, claimToken: token };
    }

    async ackOrphaned(id: string, claimToken: string): Promise<boolean> {
        const { client } = getClientRedis();
        return (await client.MC_ACK_ORPHAN(this.orphanedKey(), this.orphanedIndexKey(), this.orphanedAccountingKey(), id, claimToken)) === 1;
    }

    async nackOrphaned(id: string, claimToken: string): Promise<boolean> {
        const { client } = getClientRedis();
        return (await client.MC_NACK_ORPHAN(this.orphanedKey(), this.orphanedIndexKey(), this.orphanedAccountingKey(), id, claimToken)) === 1;
    }

    async consumeAuthNonce(principal: string, nonce: string, expiresAt: number): Promise<boolean> {
        if (!principal || !nonce || !Number.isSafeInteger(expiresAt)) return false;
        const { client } = getClientRedis();
        const principalHash = createHash('sha256').update(principal).digest('hex');
        return (
            (await client.MC_CONSUME_AUTH_NONCE(
                this.authNonceKey(principal),
                this.authNoncePrincipalsKey(),
                nonce,
                String(expiresAt),
                principalHash,
                String(this.maxAuthReplayPrincipals),
                String(this.maxAuthNoncesPerPrincipal)
            )) === 1
        );
    }

    private assertClientId(clientId: string): void {
        if (!clientId || Buffer.byteLength(clientId) > this.maxClientIdBytes) {
            throw new Error(`Mesh client ID must contain between 1 and ${this.maxClientIdBytes} UTF-8 bytes`);
        }
    }
}

function configuredLimit(value: number | undefined, fallback: number, name: string): number {
    const resolved = value ?? fallback;
    if (!Number.isSafeInteger(resolved) || resolved < 1) {
        throw new Error(`Mesh client registry ${name} must be a positive integer`);
    }
    return resolved;
}

function assertRedisCursor(cursor: string): void {
    if (!/^\d+$/.test(cursor)) throw new Error('Mesh client registry cursor is invalid');
}
