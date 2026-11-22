import type { SrpcProtocolVersion } from './types';

const SystemQueryParameterNames = new Set(['pv', '_v', 'appv', 'ts', 'nonce', 'aud', 'id', 'cid', 'signature', 'cap', 'supersede', '_supersede']);
const CompactQueryParameterNames = new Set(['~p', '~a', '~v', '~t', '~i', '~o', '~n', '~d', '~s', '~c', '~x']);

export interface SrpcHandshake {
    protocolVersion: SrpcProtocolVersion;
    query: Record<string, string>;
    appId?: string;
    appVersion?: string;
    timestamp?: string;
    connectionId?: string;
    nonce?: string;
    clientId?: string;
    audience?: string;
    signature?: string;
    capabilities: string;
    supersede: boolean;
    metadata: Record<string, string>;
}

export function parseSrpcHandshake(params: URLSearchParams, defaultVersion?: 1 | 2 | 3): SrpcHandshake | undefined {
    const query = Object.fromEntries(params);
    if (query['~p'] !== undefined) {
        if (
            query['~p'] !== '5' ||
            params.size !== Object.keys(query).length ||
            Object.keys(query).some(key => SystemQueryParameterNames.has(key) || (key.startsWith('~') && !CompactQueryParameterNames.has(key)))
        ) {
            return;
        }
        return {
            protocolVersion: 5,
            query,
            appId: query['~a'],
            appVersion: query['~v'],
            timestamp: query['~t'],
            connectionId: query['~i'],
            nonce: query['~o'] ?? query['~i'],
            clientId: query['~n'],
            audience: query['~d'],
            signature: query['~s'],
            capabilities: normalizeSrpcCapabilities(query['~c']),
            supersede: query['~x'] === '1',
            metadata: srpcQueryMetadata(query, true)
        };
    }

    const version = query.pv ?? query._v;
    const protocolVersion = version === undefined ? defaultVersion : Number(version);
    if (protocolVersion !== 1 && protocolVersion !== 2 && protocolVersion !== 3 && protocolVersion !== 4) return;
    return {
        protocolVersion,
        query,
        appVersion: query.appv,
        timestamp: query.ts,
        connectionId: query.id,
        nonce: protocolVersion < 3 ? query.id : query.nonce,
        clientId: query.cid,
        audience: query.aud,
        signature: query.signature,
        capabilities: protocolVersion < 3 ? '' : normalizeSrpcCapabilities(query.cap),
        supersede: (query.supersede ?? query._supersede) === '1',
        metadata: srpcQueryMetadata(query)
    };
}

/** Returns custom handshake metadata, excluding sRPC transport parameters. */
export function srpcQueryMetadata(query: Record<string, string>, compact = false): Record<string, string> {
    const legacyMetadata: Record<string, string> = Object.create(null);
    const metadata: Record<string, string> = Object.create(null);
    for (const [key, value] of Object.entries(query)) {
        if (SystemQueryParameterNames.has(key) || (compact && key.startsWith('~'))) continue;
        if (!compact && key.startsWith('m--')) legacyMetadata[key.slice(3)] = value;
        else metadata[key] = value;
    }
    return { ...legacyMetadata, ...metadata };
}

export function normalizeSrpcCapabilities(capabilities: string | undefined): string {
    return [...new Set((capabilities ?? '').split(',').filter(Boolean))].sort().join(',');
}

export function canonicalSrpcAuth(
    path: string,
    protocolVersion: SrpcProtocolVersion,
    fields: {
        appId?: string;
        appVersion: string;
        timestamp: string;
        connectionId: string;
        clientId: string;
        nonce: string;
        audience?: string;
        capabilities: string;
        supersede: boolean;
        metadata: Record<string, string>;
    }
): string {
    const { appId, appVersion, timestamp, connectionId, clientId, nonce, audience, capabilities, supersede, metadata } = fields;
    if (protocolVersion < 3) return `1\n${appVersion}\n${timestamp}\n${connectionId}\n${clientId}\n`;
    const signed = {
        path,
        audience,
        appv: appVersion,
        ts: timestamp,
        nonce,
        id: connectionId,
        cid: clientId,
        protocol: String(protocolVersion),
        supersede: supersede ? '1' : '0',
        capabilities,
        metadata: Object.fromEntries(Object.entries(metadata).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    };
    if (protocolVersion === 5) return JSON.stringify({ version: 5, ...signed, appId: appId ?? '' });
    return JSON.stringify({ version: 2, ...signed });
}
