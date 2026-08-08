import type { SrpcMeta } from '../../srpc/types';

import type { MeshSrpcServerOptions } from './mesh-srpc-server';

const MAX_SAFE_TIMER_MS = 2_147_483_647;

/**
 * The application configuration required to run a Redis-backed sRPC mesh
 * with authenticated direct peer links. Applications may extend this shape
 * with their own mesh prerequisites.
 */
export interface MeshSrpcConfiguration {
    MESH_LINK_NAMESPACE: string;
    REDIS_HOST?: string;
    REDIS_SENTINEL_HOST?: string;
    MESH_REDIS_HOST?: string;
    MESH_REDIS_SENTINEL_HOST?: string;
    MESH_LINK_ADVERTISE_URL?: string;
    MESH_LINK_PATH: string;
    MESH_LINK_SECRET?: string;
    MESH_LINK_CONNECT_TIMEOUT_MS: number;
    MESH_LINK_REQUEST_TIMEOUT_MS: number;
    MESH_LINK_IDLE_TIMEOUT_MS: number;
    MESH_LINK_MAX_FRAME_BYTES: number;
    MESH_LINK_MAX_BUFFERED_BYTES: number;
}

export interface MeshSrpcServerConfigurationOptions {
    /** A stable client-population segment, for example `devices` or `endpoints`. */
    meshKeySuffix: string;
    /** Application WebSocket paths that must never be claimed by the mesh link. */
    clientWebSocketPaths?: readonly string[];
}

export type MeshSrpcServerConfiguration = Pick<MeshSrpcServerOptions<SrpcMeta>, 'meshKey' | 'meshLink' | 'meshOptions'>;

/**
 * Construct the standard MeshSrpcServer options and reject incomplete or
 * unsafe infrastructure before an application accepts client connections.
 */
export function getMeshSrpcServerOptions(config: MeshSrpcConfiguration, options: MeshSrpcServerConfigurationOptions): MeshSrpcServerConfiguration {
    validateMeshSrpcConfiguration(config, options);

    return {
        meshKey: `${config.MESH_LINK_NAMESPACE}:${options.meshKeySuffix}`,
        meshLink: {
            advertiseUrl: config.MESH_LINK_ADVERTISE_URL,
            path: config.MESH_LINK_PATH,
            secret: config.MESH_LINK_SECRET,
            connectTimeoutMs: config.MESH_LINK_CONNECT_TIMEOUT_MS,
            requestTimeoutMs: config.MESH_LINK_REQUEST_TIMEOUT_MS,
            idleTimeoutMs: config.MESH_LINK_IDLE_TIMEOUT_MS,
            maxFrameBytes: config.MESH_LINK_MAX_FRAME_BYTES,
            maxBufferedBytes: config.MESH_LINK_MAX_BUFFERED_BYTES
        }
    };
}

export function validateMeshSrpcConfiguration(config: MeshSrpcConfiguration, options: MeshSrpcServerConfigurationOptions): void {
    validateMeshKeySegment(config.MESH_LINK_NAMESPACE, 'MESH_LINK_NAMESPACE', 128);
    validateMeshKeySegment(options.meshKeySuffix, 'meshKeySuffix', 64);

    if (!hasRedisConfiguration(config)) {
        throw new Error('sRPC mesh requires MESH_REDIS_HOST, MESH_REDIS_SENTINEL_HOST, REDIS_HOST, or REDIS_SENTINEL_HOST');
    }

    const secret = config.MESH_LINK_SECRET;
    if (!secret || Buffer.byteLength(secret) < 16) {
        throw new Error('sRPC mesh requires MESH_LINK_SECRET with at least 16 bytes');
    }

    const path = config.MESH_LINK_PATH;
    if (!path.startsWith('/') || path.includes('?') || path.includes('#')) {
        throw new Error('MESH_LINK_PATH must be an absolute URL path without query or fragment');
    }
    if (options.clientWebSocketPaths?.includes(path)) {
        throw new Error('MESH_LINK_PATH must not overlap a configured client WebSocket path');
    }

    validateTimer(config.MESH_LINK_CONNECT_TIMEOUT_MS, 'MESH_LINK_CONNECT_TIMEOUT_MS', 100);
    validateTimer(config.MESH_LINK_REQUEST_TIMEOUT_MS, 'MESH_LINK_REQUEST_TIMEOUT_MS', 1);
    validateTimer(config.MESH_LINK_IDLE_TIMEOUT_MS, 'MESH_LINK_IDLE_TIMEOUT_MS', 1_000);

    if (
        !Number.isSafeInteger(config.MESH_LINK_MAX_FRAME_BYTES) ||
        config.MESH_LINK_MAX_FRAME_BYTES < 1_024 ||
        config.MESH_LINK_MAX_FRAME_BYTES > 64 * 1024 * 1024
    ) {
        throw new Error('MESH_LINK_MAX_FRAME_BYTES must be an integer between 1024 and 67108864');
    }
    if (!Number.isSafeInteger(config.MESH_LINK_MAX_BUFFERED_BYTES) || config.MESH_LINK_MAX_BUFFERED_BYTES < config.MESH_LINK_MAX_FRAME_BYTES) {
        throw new Error('MESH_LINK_MAX_BUFFERED_BYTES must be an integer at least as large as MESH_LINK_MAX_FRAME_BYTES');
    }
    if (config.MESH_LINK_ADVERTISE_URL) validateAdvertiseUrl(config.MESH_LINK_ADVERTISE_URL, path);
}

function validateMeshKeySegment(value: string, name: string, maximumBytes: number): void {
    const trimmed = value.trim();
    if (!trimmed || trimmed !== value || Buffer.byteLength(trimmed) > maximumBytes || !/^[a-zA-Z0-9][a-zA-Z0-9:_-]*$/.test(trimmed)) {
        throw new Error(`${name} must be 1-${maximumBytes} URL-safe characters`);
    }
}

function hasRedisConfiguration(config: MeshSrpcConfiguration): boolean {
    return !!(config.MESH_REDIS_HOST || config.MESH_REDIS_SENTINEL_HOST || config.REDIS_HOST || config.REDIS_SENTINEL_HOST);
}

function validateTimer(value: number, name: string, minimum: number): void {
    if (!Number.isSafeInteger(value) || value < minimum || value > MAX_SAFE_TIMER_MS) {
        throw new Error(`${name} must be an integer between ${minimum} and ${MAX_SAFE_TIMER_MS}`);
    }
}

function validateAdvertiseUrl(value: string, path: string): void {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new Error('MESH_LINK_ADVERTISE_URL must be an absolute ws: or wss: URL');
    }

    if ((url.protocol !== 'ws:' && url.protocol !== 'wss:') || !url.hostname || url.username || url.password) {
        throw new Error('MESH_LINK_ADVERTISE_URL must be an unauthenticated ws: or wss: URL');
    }
    if (url.search || url.hash) throw new Error('MESH_LINK_ADVERTISE_URL must not include query parameters or a fragment');

    if (url.pathname !== '/' && url.pathname !== path) {
        throw new Error('MESH_LINK_ADVERTISE_URL path must be / or match MESH_LINK_PATH');
    }
}
