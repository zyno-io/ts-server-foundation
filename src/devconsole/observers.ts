import { uuid7 } from '../helpers';
import { registerDatabaseQueryObserver } from '../database';
import { registerMutexObserver, type MutexObservation } from '../helpers/redis/mutex';
import { registerSrpcObserver, type SrpcObservation } from '../srpc';
import { registerWorkerObserver, type WorkerObservation } from '../services/worker';
import type { App } from '../app';
import type { BaseMessage } from '../srpc';
import type { HttpRequestObservation } from '../http';
import type { DevConsoleStore } from './store';
import { serializeErrorInfo } from './store';

export function installDevConsoleObservers(app: App<any>, store: DevConsoleStore): () => void {
    const cleanup = [
        app.http.registerObserver(entry => recordHttpObservation(store, entry)),
        registerDatabaseQueryObserver(entry => {
            const query = {
                id: entry.id,
                timestamp: entry.startedAt,
                sql: entry.sql,
                params: entry.bindings,
                status: entry.phase === 'start' ? ('running' as const) : entry.error ? ('error' as const) : ('ok' as const),
                durationMs: entry.phase === 'finish' ? entry.durationMs : undefined,
                error: entry.error instanceof Error ? entry.error.message : entry.error ? String(entry.error) : undefined
            };
            if (entry.phase === 'start') store.addDatabaseQuery(query);
            else store.completeDatabaseQuery(query);
        }),
        registerWorkerObserver(entry => recordWorkerObservation(store, entry)),
        registerMutexObserver(entry => recordMutexObservation(store, entry)),
        registerSrpcObserver(entry => recordSrpcObservation(store, entry))
    ];

    return () => {
        for (const item of cleanup.reverse()) item();
    };
}

function recordHttpObservation(store: DevConsoleStore, entry: HttpRequestObservation): void {
    if (entry.request.path.startsWith('/_devconsole')) return;
    store.addHttpEntry({
        id: uuid7(),
        timestamp: entry.startedAt,
        method: entry.request.method,
        url: entry.request.url,
        remoteAddress: entry.request.getRemoteAddress(),
        requestHeaders: entry.request.headers,
        requestBody: bufferToBoundedText(entry.request.body),
        statusCode: entry.response.statusCode,
        responseHeaders: entry.response.headers,
        responseBody: bufferToBoundedText(entry.response.body),
        durationMs: entry.durationMs,
        error: serializeErrorInfo(entry.error)
    });
}

function recordWorkerObservation(store: DevConsoleStore, entry: WorkerObservation): void {
    if (entry.type === 'completed' || entry.type === 'failed') {
        store.broadcastWorkerEvent('job', {
            id: entry.record.id,
            queue: entry.record.queue,
            queueId: entry.record.queueId,
            name: entry.record.name,
            data: entry.record.data,
            status: entry.record.status,
            result: entry.record.result,
            attempt: entry.record.attempt,
            traceId: entry.record.traceId,
            createdAt: entry.record.createdAt.getTime(),
            shouldExecuteAt: entry.record.shouldExecuteAt.getTime(),
            executedAt: entry.record.executedAt.getTime(),
            completedAt: entry.record.completedAt.getTime()
        });
        return;
    }

    store.broadcastWorkerEvent(entry.type, {
        id: entry.job.id,
        queue: entry.job.queue,
        name: entry.job.name,
        status: entry.type
    });
}

function recordMutexObservation(store: DevConsoleStore, entry: MutexObservation): void {
    if (entry.type === 'pending') {
        store.addMutexPending({
            id: entry.id,
            key: entry.key,
            status: 'pending',
            startedAt: entry.startedAt
        });
    } else if (entry.type === 'acquired') {
        store.updateMutexAcquired(entry.id, entry.waited, entry.at);
    } else if (entry.type === 'released') {
        store.updateMutexReleased(entry.id, entry.at);
    } else if (entry.type === 'error') {
        store.updateMutexError(entry.id, entry.error, entry.at);
    } else {
        store.addMutexFailed({
            id: entry.id,
            key: entry.key,
            status: 'failed',
            startedAt: entry.startedAt,
            releasedAt: entry.at,
            durationMs: entry.at - entry.startedAt,
            waited: entry.waited,
            error: entry.error instanceof Error ? entry.error.message : entry.error ? String(entry.error) : undefined
        });
    }
}

function recordSrpcObservation(store: DevConsoleStore, entry: SrpcObservation): void {
    const meta = entry.stream.meta as Record<string, unknown>;
    if (meta.devconsole === true) return;

    if (entry.type === 'connection') {
        store.addSrpcConnection({
            streamId: entry.stream.id,
            clientId: entry.stream.clientId,
            clientStreamId: entry.stream.clientStreamId,
            appVersion: entry.stream.appVersion,
            address: entry.stream.address,
            connectedAt: entry.stream.connectedAt,
            lastPingAt: entry.stream.lastPingAt,
            meta,
            messageCount: 0
        });
        return;
    }

    if (entry.type === 'disconnection') {
        store.removeSrpcConnection(entry.stream.id, entry.stream.clientId, entry.cause);
        return;
    }

    const messageType = getSrpcMessageType(entry.data);
    if (!messageType || messageType === 'pingPong') return;
    store.addSrpcMessage({
        id: String(entry.data.requestId ?? uuid7()),
        timestamp: entry.at,
        streamId: entry.stream.id,
        clientId: entry.stream.clientId,
        direction: entry.direction,
        messageType,
        isReply: entry.data.reply === true,
        data: toRecord(entry.data),
        error: entry.data.error,
        isUserError: entry.data.userError
    });
}

function getSrpcMessageType(message: BaseMessage): string | undefined {
    for (const [key, value] of Object.entries(message)) {
        if (value == null) continue;
        if (['requestId', 'reply', 'error', 'userError', 'trace'].includes(key)) continue;
        return key.replace(/Request$|Response$/, '');
    }
    return undefined;
}

function toRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : { value };
}

function bufferToBoundedText(body: Buffer | undefined): string | null {
    if (!body?.length) return null;
    const maxBytes = 64 * 1024;
    const prefix = body.subarray(0, maxBytes).toString('utf8');
    return body.length > maxBytes ? `${prefix}\n... truncated ${body.length - maxBytes} byte(s)` : prefix;
}
