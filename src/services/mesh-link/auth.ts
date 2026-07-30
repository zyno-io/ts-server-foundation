import { createHmac, createPublicKey, generateKeyPairSync, randomBytes, sign, timingSafeEqual, type KeyObject, verify } from 'node:crypto';

import { SrpcMeshAuthenticationError } from '../../srpc/types';
import { MeshLinkProtocolVersion } from './protocol';

const DefaultClockSkewMs = 30_000;
const NonceTtlMs = 60_000;
const MaxRememberedNonces = 10_000;
const NonceBucketMs = 1_000;
const NonceBucketCount = Math.ceil(NonceTtlMs / NonceBucketMs) + 1;

export interface MeshLinkAuthIdentity {
    processId: string;
    endpointId?: string;
    requesterEndpointId?: string;
    requestNonce?: string;
    /** The endpoint the request proof is intended for (v2). */
    audienceEndpointId?: string;
    endpointPublicKey?: string;
    endpointSignature?: string;
    timestamp: number;
    nonce: string;
    signature: string;
}

export type MeshLinkAuthPurpose = 'request' | 'response';

export interface MeshLinkEndpointKeyPair {
    privateKey: KeyObject;
    /** SPKI DER, base64 encoded for publication in MeshNode metadata. */
    publicKey: string;
}

export function createMeshLinkEndpointKeyPair(): MeshLinkEndpointKeyPair {
    const keyPair = generateKeyPairSync('ed25519');
    return { privateKey: keyPair.privateKey, publicKey: keyPair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') };
}

export function signMeshLinkEndpointProof(
    privateKey: KeyObject,
    identity: MeshLinkAuthIdentity,
    path: string,
    purpose: MeshLinkAuthPurpose,
    responseTo?: { endpointId: string; nonce: string }
): string {
    return sign(null, Buffer.from(endpointProofPayload(identity, path, purpose, responseTo)), privateKey).toString('base64');
}

export function verifyMeshLinkEndpointProof(
    identity: MeshLinkAuthIdentity,
    path: string,
    purpose: MeshLinkAuthPurpose,
    responseTo?: { endpointId: string; nonce: string }
): boolean {
    if (!identity.endpointPublicKey || !identity.endpointSignature) return false;
    try {
        return verify(
            null,
            Buffer.from(endpointProofPayload(identity, path, purpose, responseTo)),
            createPublicKey({ key: Buffer.from(identity.endpointPublicKey, 'base64'), format: 'der', type: 'spki' }),
            Buffer.from(identity.endpointSignature, 'base64')
        );
    } catch {
        return false;
    }
}

export class MeshLinkAuthenticator {
    private readonly seenNonces = new Map<string, number>();
    /** A timing wheel makes expiry bounded by one bucket, rather than scanning the
     * entire cache on every handshake.  When full we reject new handshakes: evicting
     * a live nonce would turn a resource limit into a replay vulnerability. */
    private readonly nonceBuckets = Array.from({ length: NonceBucketCount }, () => new Set<string>());
    private lastPrunedBucket = Math.floor(Date.now() / NonceBucketMs);

    constructor(
        private readonly secret: string,
        private readonly clockSkewMs = DefaultClockSkewMs
    ) {
        if (Buffer.byteLength(secret) < 16) throw new Error('MESH_LINK_SECRET must contain at least 16 bytes');
    }

    createIdentity(
        processId: string,
        path: string,
        purpose: MeshLinkAuthPurpose = 'request',
        endpointId = processId,
        responseTo?: { endpointId: string; nonce: string },
        audienceEndpointId?: string
    ): MeshLinkAuthIdentity {
        const timestamp = Date.now();
        const nonce = randomBytes(16).toString('hex');
        return {
            processId,
            endpointId,
            requesterEndpointId: purpose === 'response' ? responseTo?.endpointId : undefined,
            requestNonce: purpose === 'response' ? responseTo?.nonce : undefined,
            audienceEndpointId: purpose === 'request' ? audienceEndpointId : undefined,
            timestamp,
            nonce,
            signature: this.sign(processId, endpointId, timestamp, nonce, path, purpose, responseTo, audienceEndpointId)
        };
    }

    verify(
        identity: MeshLinkAuthIdentity,
        path: string,
        purpose: MeshLinkAuthPurpose = 'request',
        responseTo?: { endpointId: string; nonce: string }
    ): void {
        const now = Date.now();
        this.pruneNonces(now);
        if (!identity.processId || !identity.nonce || !Number.isFinite(identity.timestamp)) {
            throw new SrpcMeshAuthenticationError();
        }
        if (!identity.endpointId) throw new SrpcMeshAuthenticationError();
        if (
            purpose === 'response' &&
            (!identity.requesterEndpointId ||
                !identity.requestNonce ||
                !responseTo ||
                identity.requesterEndpointId !== responseTo.endpointId ||
                identity.requestNonce !== responseTo.nonce)
        ) {
            throw new SrpcMeshAuthenticationError('sRPC mesh response proof does not match its request');
        }
        if (Math.abs(now - identity.timestamp) > this.clockSkewMs) {
            throw new SrpcMeshAuthenticationError('sRPC mesh authentication timestamp is outside the allowed window');
        }
        const nonceKey = `${identity.processId}:${identity.nonce}`;
        if (this.seenNonces.has(nonceKey)) throw new SrpcMeshAuthenticationError('sRPC mesh authentication nonce was replayed');

        const expected = Buffer.from(
            this.sign(
                identity.processId,
                identity.endpointId ?? identity.processId,
                identity.timestamp,
                identity.nonce,
                path,
                purpose,
                purpose === 'response' ? { endpointId: identity.requesterEndpointId ?? '', nonce: identity.requestNonce ?? '' } : undefined,
                identity.audienceEndpointId
            ),
            'hex'
        );
        const actual = Buffer.from(identity.signature, 'hex');
        if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new SrpcMeshAuthenticationError();

        if (this.seenNonces.size >= MaxRememberedNonces) {
            throw new SrpcMeshAuthenticationError('sRPC mesh authentication replay cache is saturated');
        }
        const expiresAt = now + NonceTtlMs;
        this.seenNonces.set(nonceKey, expiresAt);
        this.nonceBuckets[Math.floor(expiresAt / NonceBucketMs) % NonceBucketCount].add(nonceKey);
    }

    private sign(
        processId: string,
        endpointId: string,
        timestamp: number,
        nonce: string,
        path: string,
        purpose: MeshLinkAuthPurpose,
        responseTo?: { endpointId: string; nonce: string },
        audienceEndpointId?: string
    ): string {
        const signature = createHmac('sha256', this.secret).update(lengthPrefixed(processId)).update(lengthPrefixed(endpointId));
        signature
            .update(lengthPrefixed(String(timestamp)))
            .update(lengthPrefixed(nonce))
            .update(lengthPrefixed(path))
            .update(lengthPrefixed(purpose));
        if (purpose === 'response') {
            signature.update(lengthPrefixed(responseTo?.endpointId ?? ''));
            signature.update(lengthPrefixed(responseTo?.nonce ?? ''));
        }
        if (purpose === 'request') signature.update(lengthPrefixed(audienceEndpointId ?? ''));
        return signature.update(lengthPrefixed(String(MeshLinkProtocolVersion))).digest('hex');
    }

    private pruneNonces(now: number): void {
        const nowBucket = Math.floor(now / NonceBucketMs);
        if (nowBucket <= this.lastPrunedBucket) return;
        // A large clock jump only needs to visit each fixed bucket once.  The
        // expiry comparison protects against bucket wrap-around.
        const steps = Math.min(nowBucket - this.lastPrunedBucket, NonceBucketCount);
        for (let offset = 0; offset < steps; offset++) {
            const bucket = this.nonceBuckets[(this.lastPrunedBucket + offset) % NonceBucketCount];
            for (const nonce of bucket) {
                const expiresAt = this.seenNonces.get(nonce);
                if (expiresAt !== undefined && expiresAt <= now) this.seenNonces.delete(nonce);
            }
            bucket.clear();
        }
        this.lastPrunedBucket = nowBucket;
    }
}

function endpointProofPayload(
    identity: MeshLinkAuthIdentity,
    path: string,
    purpose: MeshLinkAuthPurpose,
    responseTo?: { endpointId: string; nonce: string }
): string {
    return [
        identity.processId,
        identity.endpointId ?? '',
        identity.timestamp,
        identity.nonce,
        identity.signature,
        identity.audienceEndpointId ?? '',
        path,
        purpose,
        MeshLinkProtocolVersion,
        responseTo?.endpointId ?? '',
        responseTo?.nonce ?? ''
    ]
        .map(value => lengthPrefixed(String(value)))
        .join('');
}

function lengthPrefixed(value: string): string {
    return `${Buffer.byteLength(value)}:${value}`;
}
