import type { SrpcConnection, SrpcStream } from '../../srpc/types';
import type { MeshRemoteSrpcConnection } from './mesh-srpc-remote-connection';

/** A mesh client handle resolved to a local stream or a trusted remote handle. */
export type MeshSrpcConnection<TMeta, TRegistryMeta> = SrpcStream<TMeta> | MeshRemoteSrpcConnection<TRegistryMeta>;

/** True only for a locally owned sRPC stream, never a remote mesh handle. */
export function isLocalSrpcStream<TMeta, TRegistryMeta>(connection: MeshSrpcConnection<TMeta, TRegistryMeta>): connection is SrpcStream<TMeta>;
export function isLocalSrpcStream<T>(connection: SrpcConnection<T>): connection is SrpcStream<T>;
export function isLocalSrpcStream(connection: SrpcConnection<unknown>): connection is SrpcStream<unknown> {
    return '$ws' in connection;
}

/**
 * Normalize a local stream's full metadata and a remote connection's trusted
 * registry projection to one registry-metadata value.
 */
export function getSrpcRegistryMetadata<TMeta, TRegistryMeta>(
    connection: MeshSrpcConnection<TMeta, TRegistryMeta>,
    extractLocalRegistryMetadata: (stream: SrpcStream<TMeta>) => TRegistryMeta
): TRegistryMeta {
    if (isLocalSrpcStream(connection)) return extractLocalRegistryMetadata(connection);
    return connection.meta;
}
