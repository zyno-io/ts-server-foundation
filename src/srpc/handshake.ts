const SystemQueryParameterNames = new Set(['pv', '_v', 'appv', 'ts', 'nonce', 'aud', 'id', 'cid', 'signature', 'cap', 'supersede', '_supersede']);

/** Returns custom handshake metadata, excluding sRPC transport parameters. */
export function srpcQueryMetadata(query: Record<string, string>): Record<string, string> {
    const legacyMetadata: Record<string, string> = {};
    const metadata: Record<string, string> = {};
    for (const [key, value] of Object.entries(query)) {
        if (SystemQueryParameterNames.has(key)) continue;
        if (key.startsWith('m--')) legacyMetadata[key.slice(3)] = value;
        else metadata[key] = value;
    }
    return { ...legacyMetadata, ...metadata };
}
