export class EventToken<TEvent = void> {
    constructor(readonly name: string) {}
}

type EventHandler<TEvent> = (event: TEvent) => void | Promise<void>;
type ListenerMethodKey = string | symbol;

interface RegisteredEventHandler<TEvent> {
    handler: EventHandler<TEvent>;
    order: number;
}

export interface ListenerMethodMetadata<TEvent = unknown> {
    token: EventToken<TEvent>;
    methodName: ListenerMethodKey;
    order: number;
}

const listenerMetadata = new WeakMap<object, ListenerMethodMetadata[]>();

export class EventBus {
    private handlers = new Map<EventToken<any>, RegisteredEventHandler<any>[]>();

    listen<TEvent>(token: EventToken<TEvent>, handler: EventHandler<TEvent>, order = 0): () => void {
        const handlers = this.handlers.get(token) ?? [];
        const registered = { handler, order };
        handlers.push(registered);
        handlers.sort((a, b) => b.order - a.order);
        this.handlers.set(token, handlers);

        return () => {
            const current = this.handlers.get(token) ?? [];
            this.handlers.set(
                token,
                current.filter(item => item !== registered)
            );
        };
    }

    async dispatch<TEvent>(token: EventToken<TEvent>, event: TEvent): Promise<void> {
        const handlers = [...(this.handlers.get(token) ?? [])];
        for (const { handler } of handlers) {
            await handler(event);
        }
    }
}

function listen<TEvent>(token: EventToken<TEvent>, order = 0): MethodDecorator {
    return (target, propertyKey) => {
        const handlers = listenerMetadata.get(target) ?? [];
        handlers.push({ token, methodName: propertyKey, order });
        listenerMetadata.set(target, handlers);
    };
}

export const event = { listen };
export const eventDispatcher = { listen };

export function getListenerMethodMetadata(instanceOrPrototype: object): ListenerMethodMetadata[] {
    const result: ListenerMethodMetadata[] = [];
    const seen = new Set<string | symbol>();
    let prototype = typeof instanceOrPrototype === 'function' ? instanceOrPrototype.prototype : instanceOrPrototype;

    while (prototype && prototype !== Object.prototype) {
        for (const item of listenerMetadata.get(prototype) ?? []) {
            if (seen.has(item.methodName)) continue;
            seen.add(item.methodName);
            result.push(item);
        }
        prototype = Object.getPrototypeOf(prototype);
    }

    return result;
}
