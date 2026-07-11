import type { IncomingMessage, Server } from 'node:http';
import type { Socket } from 'node:net';

import WebSocket from 'ws';

export type HttpUpgradeHandler = (request: IncomingMessage, socket: Socket, head: Buffer) => void;

export type VerifyClientFn = (
    info: { origin: string; secure: boolean; req: IncomingMessage },
    cb: (res: boolean, code?: number, message?: string) => void
) => void;

export interface WebSocketUpgradeHandlerOptions {
    wsPath: string;
    wsServer: WebSocket.Server;
    verifyClient: VerifyClientFn;
}

export interface InstallWebSocketUpgradeHandlerOptions extends WebSocketUpgradeHandlerOptions {
    httpServer: Server;
}

const UpgradeClaimedSymbol = Symbol.for('@zyno-io/ts-server-foundation:http-upgrade-claimed');
const UpgradeClaimHandlingInstalledSymbol = Symbol.for('@zyno-io/ts-server-foundation:http-upgrade-claim-handling-installed');
const UpgradeRejectTimerSymbol = Symbol.for('@zyno-io/ts-server-foundation:http-upgrade-reject-timer');
const InstalledUpgradeHandlersSymbol = Symbol.for('@zyno-io/ts-server-foundation:http-installed-upgrade-handlers');
const UpgradeClaimStateSymbol = Symbol.for('@zyno-io/ts-server-foundation:http-upgrade-claim-state');
const UpgradeWriteRestoreSymbol = Symbol.for('@zyno-io/ts-server-foundation:http-upgrade-write-restore');

interface InstalledUpgradeHandler {
    handler: HttpUpgradeHandler;
    count: number;
}

interface UpgradeClaimState {
    originalEmit: Server['emit'];
    fallbackHandler: HttpUpgradeHandler;
}

export function createWebSocketUpgradeHandler(options: WebSocketUpgradeHandlerOptions): HttpUpgradeHandler {
    const { wsPath, wsServer, verifyClient } = options;
    return (request, socket, head) => {
        const pathname = request.url?.split('?')[0];
        if (pathname !== wsPath) return;

        markUpgradeClaimed(socket);
        verifyClient({ origin: String(request.headers.origin ?? ''), secure: false, req: request }, (allowed, code, message) => {
            if (!allowed) {
                socket.write(`HTTP/1.1 ${code ?? 403} ${message ?? 'Forbidden'}\r\n\r\n`);
                socket.destroy();
                return;
            }

            wsServer.handleUpgrade(request, socket, head, ws => {
                wsServer.emit('connection', ws, request);
            });
        });
    };
}

export function installWebSocketUpgradeHandler(options: InstallWebSocketUpgradeHandlerOptions): HttpUpgradeHandler {
    installUpgradeClaimHandling(options.httpServer);
    const installedHandlers = getInstalledHandlers(options.httpServer);
    const installed = installedHandlers.get(options.wsPath);
    if (installed) {
        installed.count++;
        return installed.handler;
    }

    const handler = createWebSocketUpgradeHandler(options);
    options.httpServer.prependListener('upgrade', handler);
    installedHandlers.set(options.wsPath, { handler, count: 1 });
    return handler;
}

export function removeWebSocketUpgradeHandler(httpServer: Server, wsPath: string, handler: HttpUpgradeHandler): void {
    const installedHandlers = getInstalledHandlers(httpServer);
    const installed = installedHandlers.get(wsPath);
    if (!installed || installed.handler !== handler) return;

    installed.count--;
    if (installed.count > 0) return;

    httpServer.off('upgrade', handler);
    installedHandlers.delete(wsPath);
    if (installedHandlers.size === 0) uninstallUpgradeClaimHandling(httpServer);
}

export function installUpgradeClaimHandling(server: Server): void {
    const anyServer = server as Server & {
        [UpgradeClaimHandlingInstalledSymbol]?: boolean;
        [UpgradeClaimStateSymbol]?: UpgradeClaimState;
    };
    if (anyServer[UpgradeClaimHandlingInstalledSymbol]) return;
    anyServer[UpgradeClaimHandlingInstalledSymbol] = true;

    const originalEmit = server.emit;
    server.emit = function (this: Server, event: string | symbol, ...args: unknown[]): boolean {
        if (event !== 'upgrade') return originalEmit.apply(this, [event, ...args]);

        const socket = args[1] as Socket;
        installUpgradeWriteClaimDetection(socket);
        const listeners = this.rawListeners('upgrade').slice();
        for (const listener of listeners) {
            (listener as (...listenerArgs: unknown[]) => unknown).apply(this, args);
            if ((socket as Socket & { [UpgradeClaimedSymbol]?: boolean })[UpgradeClaimedSymbol]) break;
        }
        return listeners.length > 0;
    };

    const fallbackHandler: HttpUpgradeHandler = (_request, socket) => {
        clearUpgradeRejectionTimer(socket);
        const timer = setTimeout(() => {
            if (!(socket as Socket & { [UpgradeClaimedSymbol]?: boolean })[UpgradeClaimedSymbol] && !socket.destroyed) {
                socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
                socket.destroy();
            }
            clearUpgradeRejectionTimer(socket);
            clearUpgradeWriteClaimDetection(socket);
        }, 1000);
        timer.unref?.();
        (socket as Socket & { [UpgradeRejectTimerSymbol]?: ReturnType<typeof setTimeout> })[UpgradeRejectTimerSymbol] = timer;
        socket.once('close', () => {
            clearUpgradeRejectionTimer(socket);
            clearUpgradeWriteClaimDetection(socket);
        });
    };

    anyServer[UpgradeClaimStateSymbol] = { originalEmit, fallbackHandler };
    server.on('upgrade', fallbackHandler);
}

function uninstallUpgradeClaimHandling(server: Server): void {
    const anyServer = server as Server & {
        [UpgradeClaimHandlingInstalledSymbol]?: boolean;
        [UpgradeClaimStateSymbol]?: UpgradeClaimState;
    };
    const state = anyServer[UpgradeClaimStateSymbol];
    if (!state) return;

    server.off('upgrade', state.fallbackHandler);
    server.emit = state.originalEmit;
    delete anyServer[UpgradeClaimHandlingInstalledSymbol];
    delete anyServer[UpgradeClaimStateSymbol];
}

function markUpgradeClaimed(socket: Socket): void {
    (socket as Socket & { [UpgradeClaimedSymbol]?: boolean })[UpgradeClaimedSymbol] = true;
    clearUpgradeRejectionTimer(socket);
    clearUpgradeWriteClaimDetection(socket);
}

function installUpgradeWriteClaimDetection(socket: Socket): void {
    const anySocket = socket as Socket & { [UpgradeWriteRestoreSymbol]?: () => void };
    if (anySocket[UpgradeWriteRestoreSymbol]) return;
    const originalWrite = socket.write;
    const patchedWrite: typeof socket.write = function (this: Socket, chunk: unknown, ...args: unknown[]) {
        if (isSuccessfulUpgradeResponse(chunk)) markUpgradeClaimed(this);
        return (originalWrite as (...writeArgs: unknown[]) => boolean).apply(this, [chunk, ...args]);
    } as typeof socket.write;
    socket.write = patchedWrite;
    anySocket[UpgradeWriteRestoreSymbol] = () => {
        if (socket.write === patchedWrite) socket.write = originalWrite;
    };
}

function clearUpgradeWriteClaimDetection(socket: Socket): void {
    const anySocket = socket as Socket & { [UpgradeWriteRestoreSymbol]?: () => void };
    const restore = anySocket[UpgradeWriteRestoreSymbol];
    if (!restore) return;
    delete anySocket[UpgradeWriteRestoreSymbol];
    restore();
}

function isSuccessfulUpgradeResponse(chunk: unknown): boolean {
    if (typeof chunk === 'string') return /^HTTP\/1\.[01] 101\b/i.test(chunk);
    if (Buffer.isBuffer(chunk)) return /^HTTP\/1\.[01] 101\b/i.test(chunk.toString('latin1', 0, Math.min(chunk.length, 32)));
    return false;
}

function clearUpgradeRejectionTimer(socket: Socket): void {
    const timer = (socket as Socket & { [UpgradeRejectTimerSymbol]?: ReturnType<typeof setTimeout> })[UpgradeRejectTimerSymbol];
    if (!timer) return;
    clearTimeout(timer);
    delete (socket as Socket & { [UpgradeRejectTimerSymbol]?: ReturnType<typeof setTimeout> })[UpgradeRejectTimerSymbol];
}

function getInstalledHandlers(httpServer: Server): Map<string, InstalledUpgradeHandler> {
    const anyServer = httpServer as Server & {
        [InstalledUpgradeHandlersSymbol]?: Map<string, InstalledUpgradeHandler>;
    };
    anyServer[InstalledUpgradeHandlersSymbol] ??= new Map();
    return anyServer[InstalledUpgradeHandlersSymbol];
}
