import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { SrpcMeshAuthenticationError } from '../../srpc/types';

const DefaultClockSkewMs = 30_000;
const NonceTtlMs = 60_000;
const MaxRememberedNonces = 10_000;

export interface MeshLinkAuthIdentity {
    processId: string;
    timestamp: number;
    nonce: string;
    signature: string;
}

export class MeshLinkAuthenticator {
    private readonly seenNonces = new Map<string, number>();

    constructor(
        private readonly secret: string,
        private readonly clockSkewMs = DefaultClockSkewMs
    ) {
        if (Buffer.byteLength(secret) < 16) throw new Error('MESH_LINK_SECRET must contain at least 16 bytes');
    }

    createIdentity(processId: string, path: string): MeshLinkAuthIdentity {
        const timestamp = Date.now();
        const nonce = randomBytes(16).toString('hex');
        return {
            processId,
            timestamp,
            nonce,
            signature: this.sign(processId, timestamp, nonce, path)
        };
    }

    verify(identity: MeshLinkAuthIdentity, path: string): void {
        const now = Date.now();
        this.pruneNonces(now);
        if (!identity.processId || !identity.nonce || !Number.isFinite(identity.timestamp)) {
            throw new SrpcMeshAuthenticationError();
        }
        if (Math.abs(now - identity.timestamp) > this.clockSkewMs) {
            throw new SrpcMeshAuthenticationError('sRPC mesh authentication timestamp is outside the allowed window');
        }
        const nonceKey = `${identity.processId}:${identity.nonce}`;
        if (this.seenNonces.has(nonceKey)) throw new SrpcMeshAuthenticationError('sRPC mesh authentication nonce was replayed');

        const expected = Buffer.from(this.sign(identity.processId, identity.timestamp, identity.nonce, path), 'hex');
        const actual = Buffer.from(identity.signature, 'hex');
        if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new SrpcMeshAuthenticationError();

        this.seenNonces.set(nonceKey, now + NonceTtlMs);
        while (this.seenNonces.size > MaxRememberedNonces) {
            const oldest = this.seenNonces.keys().next().value;
            if (oldest === undefined) break;
            this.seenNonces.delete(oldest);
        }
    }

    private sign(processId: string, timestamp: number, nonce: string, path: string): string {
        return createHmac('sha256', this.secret)
            .update(lengthPrefixed(processId))
            .update(lengthPrefixed(String(timestamp)))
            .update(lengthPrefixed(nonce))
            .update(lengthPrefixed(path))
            .update(lengthPrefixed('1'))
            .digest('hex');
    }

    private pruneNonces(now: number): void {
        for (const [nonce, expiresAt] of this.seenNonces) {
            if (expiresAt <= now) this.seenNonces.delete(nonce);
        }
    }
}

function lengthPrefixed(value: string): string {
    return `${Buffer.byteLength(value)}:${value}`;
}
