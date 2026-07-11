import type { BaseMessage, SrpcDisconnectCause, SrpcStream } from './types';

export type SrpcObservation =
    | {
          type: 'connection';
          stream: SrpcStream;
          at: number;
      }
    | {
          type: 'disconnection';
          stream: SrpcStream;
          cause: SrpcDisconnectCause;
          at: number;
      }
    | {
          type: 'message';
          stream: SrpcStream;
          direction: 'inbound' | 'outbound';
          data: BaseMessage;
          at: number;
      };

export type SrpcObserver = (entry: SrpcObservation) => void;

const srpcObservers = new Set<SrpcObserver>();

export function registerSrpcObserver(observer: SrpcObserver): () => void {
    srpcObservers.add(observer);
    return () => srpcObservers.delete(observer);
}

export function notifySrpcObservers(entry: SrpcObservation): void {
    for (const observer of srpcObservers) {
        try {
            observer(entry);
        } catch {
            // Observers must never affect SRPC behavior.
        }
    }
}
