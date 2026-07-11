import type { QueuedWorkerJob, WorkerJobRecord } from './types';

export type WorkerObservation =
    | { type: 'added' | 'active' | 'delayed'; job: QueuedWorkerJob }
    | { type: 'completed' | 'failed'; job: QueuedWorkerJob; record: WorkerJobRecord };

export type WorkerObserver = (entry: WorkerObservation) => void;

const workerObservers = new Set<WorkerObserver>();

export function registerWorkerObserver(observer: WorkerObserver): () => void {
    workerObservers.add(observer);
    return () => workerObservers.delete(observer);
}

export function notifyWorkerObservers(entry: WorkerObservation): void {
    for (const observer of workerObservers) {
        try {
            observer(entry);
        } catch {
            // Observers must never affect worker execution.
        }
    }
}
