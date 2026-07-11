import { unlink } from 'node:fs/promises';
import { Readable, Writable } from 'node:stream';

export class PipeError extends Error {
    constructor(
        public readonly cause: Error,
        public readonly side: 'input' | 'output'
    ) {
        super(cause.message);
        this.name = 'PipeError';
    }
}

export function safePipe(input: Readable, output: Writable): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        let settled = false;
        const fail = (error: Error, side: 'input' | 'output') => {
            if (settled) return;
            settled = true;
            if (side === 'input' && !output.destroyed) output.destroy();
            if (side === 'output' && !input.destroyed) input.destroy();
            reject(new PipeError(error, side));
        };
        const finish = () => {
            if (settled) return;
            settled = true;
            resolve();
        };

        input.on('close', () => {
            if (!input.readableEnded) fail(new Error('Input stream aborted'), 'input');
        });
        input.on('error', error => fail(error, 'input'));
        output.on('close', () => {
            if (!output.writableEnded) fail(new Error('Output stream aborted'), 'output');
        });
        output.on('error', error => fail(error, 'output'));
        output.on('finish', finish);

        input.pipe(output);
    });
}

export class ResourceTracker {
    readonly files: string[] = [];
    readonly streams: Array<Readable | Writable> = [];
    private failure: unknown;

    addStream(stream: Readable | Writable): void {
        stream.on('error', error => {
            this.failure ??= error;
        });
        this.streams.push(stream);
    }

    addFile(file: string): void {
        this.files.push(file);
    }

    getFailure(): unknown {
        return this.failure;
    }

    async cleanup(): Promise<void> {
        await Promise.all(this.files.map(file => unlink(file).catch(() => {})));
        for (const stream of this.streams) {
            if (!stream.destroyed) stream.destroy();
        }
    }
}

export function withResourceCleanup<T>(fn: (tracker: ResourceTracker) => Promise<T>, onError?: (error: unknown) => void): Promise<T> {
    const tracker = new ResourceTracker();

    return (async () => {
        try {
            const result = await fn(tracker);
            const failure = tracker.getFailure();
            if (failure !== undefined) throw failure;
            return result;
        } catch (error) {
            onError?.(error);
            throw error;
        } finally {
            await tracker.cleanup();
        }
    })();
}
