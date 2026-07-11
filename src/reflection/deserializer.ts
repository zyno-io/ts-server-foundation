import type { Type } from './model';

type DeserializeHandler = (type: Type, state: DeserializerState) => void;

export class DeserializerRegistry {
    private readonly decorators: {
        predicate: (type: Type) => boolean;
        handler: DeserializeHandler;
    }[] = [];

    addDecorator(predicate: (type: Type) => boolean, handler: DeserializeHandler): void {
        this.decorators.push({ predicate, handler });
    }

    apply(type: Type, value: unknown): unknown {
        let result = value;
        for (const decorator of this.decorators) {
            if (!decorator.predicate(type)) continue;
            const state = new DeserializerState();
            decorator.handler(type, state);
            result = state.apply(result);
        }
        return result;
    }
}

export class DeserializerState {
    private transforms: ((value: unknown) => unknown)[] = [];

    addTransform(transform: (value: unknown) => unknown): void {
        this.transforms.push(transform);
    }

    apply(value: unknown): unknown {
        return this.transforms.reduce((current, transform) => transform(current), value);
    }
}

export const deserializer = new DeserializerRegistry();
