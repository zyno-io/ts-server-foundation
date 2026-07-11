/**
 * Browser SRPC client — based on the internal SrpcClient (src/srpc/SrpcClient.ts).
 *
 * Speaks the real SRPC binary protocol using protobuf encode/decode.
 *
 * Connection lifecycle (mirrors the Node.js SrpcClient):
 *   1. Connect via WebSocket with auth query params
 *   2. Wait for server's initial pingPong (handshake)
 *   3. Respond with pingPong → connection established
 *   4. Send periodic pings; server responds with pongs
 *   5. Auto-reconnect with exponential backoff on disconnect
 *
 * For the DevConsole, authentication is skipped (server accepts all localhost connections).
 */

/** Matches SrpcMessageFns from src/srpc/types.ts */
interface MessageFns<T> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    encode(message: T, writer?: any): { finish(): Uint8Array };
    decode(input: Uint8Array, length?: number): T;
}

interface BaseMessage {
    requestId?: string;
    reply?: boolean;
    error?: string;
    userError?: boolean;
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    pingPong?: {};
    byteStreamOperation?: unknown;
}

type LifecycleHandler = () => void;

export class SrpcBrowserClient<TOutbound extends BaseMessage = BaseMessage, TInbound extends BaseMessage = BaseMessage> {
    private ws: WebSocket | null = null;
    private outboundType: MessageFns<TOutbound>;
    private inboundType: MessageFns<TInbound>;
    private established = false;
    private intentionalDisconnect = false;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private reconnectDelay = 1000;
    private pingInterval: ReturnType<typeof setInterval> | null = null;
    private lastPongMs = 0;
    private streamId = '';

    private connectionHandlers = new Set<LifecycleHandler>();
    private disconnectionHandlers = new Set<LifecycleHandler>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private messageHandlers = new Map<string, (data: any) => any>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private pendingRequests = new Map<string, { resolve: (data: any) => void; reject: (err: Error) => void }>();

    public isConnected = false;

    constructor(
        private url: string,
        outboundType: MessageFns<TOutbound>,
        inboundType: MessageFns<TInbound>,
        private clientId: string
    ) {
        this.outboundType = outboundType;
        this.inboundType = inboundType;
    }

    ////////////////////////////////////////
    // Connection Management

    connect() {
        if (this.ws) {
            this.intentionalDisconnect = true;
            this.ws.close();
            this.ws = null;
        }

        this.intentionalDisconnect = false;
        this.established = false;
        this.streamId = crypto.randomUUID();

        const wsUrl = this.buildWsUrl();
        const ws = new WebSocket(wsUrl);
        ws.binaryType = 'arraybuffer';

        const connectTimeout = setTimeout(() => {
            ws.close();
            this.queueReconnect();
        }, 10_000);

        let handshakeComplete = false;

        ws.onmessage = (ev: MessageEvent) => {
            const data = new Uint8Array(ev.data as ArrayBuffer);
            const message = this.decode(data);
            if (!message) return;

            if (message.pingPong) {
                this.lastPongMs = Date.now();

                if (!handshakeComplete) {
                    // Respond to server's initial ping (completes handshake)
                    handshakeComplete = true;
                    clearTimeout(connectTimeout);
                    this.writeMessage({ pingPong: {} } as Partial<TOutbound>);

                    this.established = true;
                    this.isConnected = true;
                    this.reconnectDelay = 1000;

                    // Start periodic ping (mirrors SrpcClient: 55s interval)
                    this.pingInterval = setInterval(() => this.doPingPong(), 55_000);

                    this.connectionHandlers.forEach(h => h());
                    return;
                }

                // Server responding to our ping
                return;
            }

            if (message.byteStreamOperation) return;

            const { requestId, reply } = message;

            if (reply && requestId) {
                const pending = this.pendingRequests.get(requestId);
                if (pending) {
                    this.pendingRequests.delete(requestId);
                    if (message.error) {
                        pending.reject(new Error(message.error));
                    } else {
                        pending.resolve(message);
                    }
                }
                return;
            }

            // Server-initiated request — find handler
            if (requestId) {
                this.handleServerRequest(requestId, message);
            }
        };

        ws.onclose = () => {
            clearTimeout(connectTimeout);
            this.handleDisconnect();
        };

        ws.onerror = () => {
            // onclose will fire after onerror
        };

        this.ws = ws;
    }

    disconnect() {
        this.intentionalDisconnect = true;

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }

        if (this.ws) {
            this.ws.close(1000, 'Client disconnect');
        }
    }

    ////////////////////////////////////////
    // Connection Lifecycle

    private handleDisconnect() {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }

        const wasConnected = this.isConnected;
        this.isConnected = false;
        this.established = false;
        this.ws = null;

        // Reject all pending requests so callers don't hang forever
        for (const [_id, pending] of this.pendingRequests) {
            pending.reject(new Error('Disconnected'));
        }
        this.pendingRequests.clear();

        if (wasConnected) {
            this.disconnectionHandlers.forEach(h => h());
        }

        if (!this.intentionalDisconnect) {
            this.queueReconnect();
        }
    }

    private queueReconnect() {
        if (this.reconnectTimer) return;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.reconnectDelay = Math.min(this.reconnectDelay * 2, 10_000);
            this.connect();
        }, this.reconnectDelay);
    }

    private doPingPong() {
        if (this.lastPongMs < Date.now() - 75_000) {
            // Pong timeout (mirrors SrpcClient)
            this.ws?.close(4001, 'Pong timeout');
            return;
        }
        this.writeMessage({ pingPong: {} } as Partial<TOutbound>);
    }

    ////////////////////////////////////////
    // Message Handling

    private handleServerRequest(requestId: string, message: TInbound & BaseMessage) {
        for (const [key, handler] of this.messageHandlers) {
            const requestKey = `${key}Request`;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            if ((message as any)[requestKey]) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const result = handler((message as any)[requestKey]);
                const responseKey = `${key}Response`;

                // Handle both sync and async handlers
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const sendReply = (response: any) => {
                    this.writeMessage({
                        requestId,
                        reply: true,
                        [responseKey]: response ?? {}
                    } as Partial<TOutbound>);
                };

                if (result && typeof result.then === 'function') {
                    result.then(sendReply).catch(() => {
                        this.writeMessage({
                            requestId,
                            reply: true,
                            error: 'Handler error'
                        } as Partial<TOutbound>);
                    });
                } else {
                    sendReply(result);
                }
                return;
            }
        }

        // No handler found — reply with error
        this.writeMessage({
            requestId,
            reply: true,
            error: 'Unhandled message type'
        } as Partial<TOutbound>);
    }

    ////////////////////////////////////////
    // Protocol Helpers

    private buildWsUrl(): string {
        const url = new URL(this.url);
        url.searchParams.set('authv', '1');
        url.searchParams.set('appv', '0.0.0');
        url.searchParams.set('ts', String(Date.now()));
        url.searchParams.set('id', this.streamId);
        url.searchParams.set('cid', this.clientId);
        url.searchParams.set('signature', 'browser-no-auth');
        return url.toString();
    }

    private decode(data: Uint8Array): (TInbound & BaseMessage) | null {
        try {
            return this.inboundType.decode(data) as TInbound & BaseMessage;
        } catch {
            return null;
        }
    }

    private writeMessage(message: Partial<TOutbound>): boolean {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            return false;
        }
        try {
            const encoded = this.outboundType.encode(message as TOutbound).finish();
            this.ws.send(encoded);
            return true;
        } catch {
            return false;
        }
    }

    ////////////////////////////////////////
    // Public API

    onConnect(handler: LifecycleHandler) {
        this.connectionHandlers.add(handler);
    }

    offConnect(handler: LifecycleHandler) {
        this.connectionHandlers.delete(handler);
    }

    onDisconnect(handler: LifecycleHandler) {
        this.disconnectionHandlers.add(handler);
    }

    offDisconnect(handler: LifecycleHandler) {
        this.disconnectionHandlers.delete(handler);
    }

    /**
     * Register a handler for server-initiated requests (downstream).
     * Uses the SRPC prefix convention: 'dEvent' handles dEventRequest and replies with dEventResponse.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerMessageHandler(prefix: string, handler: (data: any) => any) {
        this.messageHandlers.set(prefix, handler);
    }

    /**
     * Send a request to the server and wait for a reply.
     * Uses the SRPC prefix convention: 'uReplEval' sends uReplEvalRequest and expects uReplEvalResponse.
     */
    invoke(prefix: string, data: Record<string, unknown>, timeoutMs = 30_000): Promise<TInbound & BaseMessage> {
        return new Promise((resolve, reject) => {
            const requestId = crypto.randomUUID();

            const timer = setTimeout(() => {
                this.pendingRequests.delete(requestId);
                reject(new Error(`Request '${prefix}' timed out`));
            }, timeoutMs);

            this.pendingRequests.set(requestId, {
                resolve: v => {
                    clearTimeout(timer);
                    resolve(v);
                },
                reject: e => {
                    clearTimeout(timer);
                    reject(e);
                }
            });

            const sent = this.writeMessage({
                requestId,
                [`${prefix}Request`]: data
            } as Partial<TOutbound>);

            if (!sent) {
                clearTimeout(timer);
                this.pendingRequests.delete(requestId);
                reject(new Error('Not connected'));
            }
        });
    }
}
