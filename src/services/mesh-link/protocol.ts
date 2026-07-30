import { SrpcMeshProtocolError } from '../../srpc/types';

export const MeshLinkProtocolVersion = 2;
const HeaderLengthBytes = 4;
const MaxHeaderBytes = 64 * 1024;

export type MeshLinkFrameType =
    | 'invoke'
    | 'reserveStreamIds'
    | 'confirmStreamIds'
    | 'releaseStreamIds'
    | 'streamWrite'
    | 'streamFinish'
    | 'streamDestroy'
    | 'streamActivate'
    | 'streamAttach'
    | 'revokeCapability'
    /** Generic MeshClientService request delivery over an authenticated link. */
    | 'clientInvoke'
    /** Exact-generation client close/fence. */
    | 'fenceClient'
    /** Generic MeshClientService metadata mutation. */
    | 'clientUpdateMetadata'
    | 'disconnect'
    | 'updateMetadata'
    | 'accepted'
    | 'result'
    | 'ping'
    | 'pong'
    | 'goAway';

export interface MeshLinkFrameHeader {
    version?: number;
    type: MeshLinkFrameType;
    meshKey?: string;
    id?: string;
    replyTo?: string;
    clientId?: string;
    connectionId?: string;
    prefix?: string;
    timeoutMs?: number;
    /** Authenticated end-to-end invocation deadline (epoch milliseconds). */
    deadlineAt?: number;
    streamId?: number;
    count?: number;
    ids?: number[];
    /** Opaque, per-requester handle capability (v2). */
    capability?: string;
    /** Caller-generated idempotency key for a sender-ID reservation (v2). */
    reservationId?: string;
    ok?: boolean;
    error?: string;
    errorName?: string;
    userError?: boolean;
    reason?: string;
    closeCapability?: boolean;
}

export interface MeshLinkFrame {
    header: MeshLinkFrameHeader;
    body: Buffer;
}

export function encodeMeshLinkFrame(
    header: Omit<MeshLinkFrameHeader, 'version'>,
    body: Uint8Array = new Uint8Array(),
    maxFrameBytes?: number
): Buffer {
    const encodedHeader = Buffer.from(JSON.stringify({ version: MeshLinkProtocolVersion, ...header }));
    if (encodedHeader.length > MaxHeaderBytes) throw new SrpcMeshProtocolError('sRPC mesh frame header is too large');
    const frameLength = HeaderLengthBytes + encodedHeader.length + body.byteLength;
    if (!Number.isSafeInteger(frameLength) || (maxFrameBytes !== undefined && frameLength > maxFrameBytes)) {
        throw new SrpcMeshProtocolError('sRPC mesh frame exceeds the configured limit');
    }
    const result = Buffer.allocUnsafe(frameLength);
    result.writeUInt32BE(encodedHeader.length, 0);
    encodedHeader.copy(result, HeaderLengthBytes);
    Buffer.from(body).copy(result, HeaderLengthBytes + encodedHeader.length);
    return result;
}

export function decodeMeshLinkFrame(data: Uint8Array, maxFrameBytes: number): MeshLinkFrame {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buffer.length > maxFrameBytes) throw new SrpcMeshProtocolError('sRPC mesh frame exceeds the configured limit');
    if (buffer.length < HeaderLengthBytes) throw new SrpcMeshProtocolError('Invalid sRPC mesh frame');
    const headerLength = buffer.readUInt32BE(0);
    if (headerLength < 2 || headerLength > MaxHeaderBytes || HeaderLengthBytes + headerLength > buffer.length) {
        throw new SrpcMeshProtocolError('Invalid sRPC mesh frame header length');
    }
    let header: MeshLinkFrameHeader;
    try {
        header = JSON.parse(buffer.subarray(HeaderLengthBytes, HeaderLengthBytes + headerLength).toString('utf8')) as MeshLinkFrameHeader;
    } catch {
        throw new SrpcMeshProtocolError('Invalid sRPC mesh frame header');
    }
    if (header.version !== MeshLinkProtocolVersion || typeof header.type !== 'string') {
        throw new SrpcMeshProtocolError('Unsupported sRPC mesh protocol version');
    }
    return {
        header,
        body: buffer.subarray(HeaderLengthBytes + headerLength)
    };
}
