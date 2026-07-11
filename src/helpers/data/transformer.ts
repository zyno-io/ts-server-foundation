import { asyncMap } from './array';

export class Transformer<I> {
    private executor?: (input: unknown[]) => unknown[] | Promise<unknown[]>;

    static create<I>(input: I[]): Transformer<I> {
        return new Transformer(input);
    }

    constructor(private readonly input: I[] | Transformer<unknown>) {}

    apply<O>(fn: (input: I[]) => O[] | Promise<O[]>, shouldApply = true): Transformer<O> {
        this.executor = shouldApply ? input => fn(input as I[]) : input => input;
        return new Transformer<O>(this as unknown as Transformer<unknown>);
    }

    applyEach<O>(fn: (input: I) => O, shouldApply = true): Transformer<O> {
        return this.apply(items => items.map(fn), shouldApply);
    }

    applyEachAsync<O>(fn: (input: I) => Promise<O>, shouldApply = true): Transformer<O> {
        return this.apply(items => asyncMap(items, fn), shouldApply);
    }

    narrow<K extends Array<keyof I>>(...keys: K): Transformer<Pick<I, K[number]>> {
        return this.apply(items => items.map(item => pick(item, keys)));
    }

    async execute(): Promise<unknown[]> {
        if (!this.executor) throw new Error('No executor defined');
        const input = await this.get();
        return this.executor(input);
    }

    async get(): Promise<I[]> {
        if (this.input instanceof Transformer) return (await this.input.execute()) as I[];
        return this.input;
    }
}

function pick<T, K extends keyof T>(item: T, keys: readonly K[]): Pick<T, K> {
    const result = {} as Pick<T, K>;
    for (const key of keys) result[key] = item[key];
    return result;
}
