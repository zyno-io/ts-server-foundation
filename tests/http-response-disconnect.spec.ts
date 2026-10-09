import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import type { ServerResponse } from 'node:http';
import { describe, it } from 'node:test';

import { writeNodeResponse, writeUnhandledNodeError } from '../src/http/base';
import { MemoryHttpResponse, NodeHttpResponse } from '../src/http/response';

function writeError(code: string): NodeJS.ErrnoException {
    return Object.assign(new Error(`write ${code}`), { code, errno: -32, syscall: 'write' });
}

function nativeResponse(): ServerResponse {
    return Object.assign(new EventEmitter(), {
        statusCode: 200,
        headersSent: false,
        destroyed: false,
        writableEnded: false,
        setHeader() {},
        writeHead() {},
        flushHeaders() {},
        write() {
            return true;
        },
        end() {},
        destroy() {
            this.destroyed = true;
            return this;
        }
    }) as unknown as ServerResponse;
}

const writePaths: Record<string, (outgoing: ServerResponse) => void> = {
    'memory response': outgoing => writeNodeResponse(outgoing, new MemoryHttpResponse()),
    'fallback response': outgoing => writeUnhandledNodeError(outgoing, new Error('request failed')),
    'committed fallback response': outgoing => {
        Object.defineProperty(outgoing, 'headersSent', { value: true });
        writeUnhandledNodeError(outgoing, new Error('request failed'));
    },
    'buffered flush': outgoing => new NodeHttpResponse(outgoing).flush(),
    'buffered stream handoff': outgoing => {
        const response = new NodeHttpResponse(outgoing);
        response._write('buffered', 'utf8', () => {});
        response.write('streaming');
    },
    'stream write': outgoing => new NodeHttpResponse(outgoing).write('streaming'),
    'stream finalization': outgoing => {
        outgoing.writeHead = (() => outgoing) as ServerResponse['writeHead'];
        const response = new NodeHttpResponse(outgoing);
        response.writeHead(200);
        response._final(() => {});
    },
    writeHead: outgoing => {
        new NodeHttpResponse(outgoing).writeHead(200);
    },
    flushHeaders: outgoing => new NodeHttpResponse(outgoing).flushHeaders()
};

describe('HTTP response disconnects', () => {
    for (const [name, write] of Object.entries(writePaths)) {
        for (const code of ['EPIPE', 'ECONNRESET']) {
            it(`treats synchronous ${code} during ${name} as a closed client`, () => {
                const outgoing = nativeResponse();
                const fail = () => {
                    throw writeError(code);
                };
                outgoing.write = fail;
                outgoing.end = fail;
                outgoing.writeHead = fail;
                outgoing.flushHeaders = fail;
                assert.doesNotThrow(() => write(outgoing));
                assert.equal(outgoing.destroyed, true);
            });
        }
        it(`preserves other synchronous errors during ${name}`, () => {
            const outgoing = nativeResponse();
            const error = writeError('EIO');
            const fail = () => {
                throw error;
            };
            outgoing.write = fail;
            outgoing.end = fail;
            outgoing.writeHead = fail;
            outgoing.flushHeaders = fail;
            assert.throws(
                () => write(outgoing),
                candidate => candidate === error
            );
        });
    }

    for (const code of ['EPIPE', 'ECONNRESET']) {
        it(`handles an asynchronous native ${code} without emitting a wrapper error`, () => {
            const outgoing = nativeResponse();
            const response = new NodeHttpResponse(outgoing);
            const errors: Error[] = [];
            response.on('error', error => errors.push(error));
            outgoing.emit('error', writeError(code));
            assert.equal(outgoing.destroyed, true);
            assert.deepEqual(errors, []);
        });

        for (const operation of ['write', 'end'] as const) {
            it(`handles asynchronous ${code} from the ${operation} callback`, async () => {
                const outgoing = nativeResponse();
                const response = new NodeHttpResponse(outgoing);
                response.writeHead(200);
                if (operation === 'write') {
                    outgoing.write = ((_chunk: unknown, _encoding: unknown, callback: (error: Error) => void) => {
                        setImmediate(() => callback(writeError(code)));
                        return true;
                    }) as ServerResponse['write'];
                } else {
                    outgoing.end = ((callback: (error: Error) => void) => {
                        setImmediate(() => callback(writeError(code)));
                        return outgoing;
                    }) as ServerResponse['end'];
                }
                await new Promise<void>((resolve, reject) => {
                    response.on('error', reject);
                    if (operation === 'write') response.write('data', error => (error ? reject(error) : resolve()));
                    else response.end(resolve);
                });
                assert.equal(outgoing.destroyed, true);
                assert.equal(response.destroyed, true);
            });
        }
    }

    for (const write of [writeNodeResponse, (outgoing: ServerResponse) => writeUnhandledNodeError(outgoing, new Error('failed'))]) {
        for (const code of ['EPIPE', 'ECONNRESET']) {
            it(`handles asynchronous ${code} after a direct response write`, () => {
                const outgoing = nativeResponse();
                write(outgoing, new MemoryHttpResponse());
                assert.doesNotThrow(() => outgoing.emit('error', writeError(code)));
                assert.equal(outgoing.destroyed, true);
            });
        }
    }

    for (const operation of ['write', 'end'] as const) {
        it(`preserves unrelated errors from the ${operation} callback`, async () => {
            const outgoing = nativeResponse();
            const response = new NodeHttpResponse(outgoing);
            response.writeHead(200);
            const error = writeError('EIO');
            const observed = new Promise<Error>(resolve => response.once('error', resolve));
            if (operation === 'write') {
                outgoing.write = ((_chunk: unknown, _encoding: unknown, callback: (error: Error) => void) => {
                    setImmediate(() => callback(error));
                    return true;
                }) as ServerResponse['write'];
                response.write('data');
            } else {
                outgoing.end = ((callback: (error: Error) => void) => {
                    setImmediate(() => callback(error));
                    return outgoing;
                }) as ServerResponse['end'];
                response.end();
            }
            const actual = await observed;
            assert.equal(actual, error);
        });
    }

    it('does not swallow an unowned asynchronous response error', () => {
        const outgoing = nativeResponse();
        writeNodeResponse(outgoing, new MemoryHttpResponse());
        const error = writeError('EIO');
        assert.throws(
            () => outgoing.emit('error', error),
            candidate => candidate === error
        );
    });

    it('forwards other asynchronous response errors to the wrapper', async () => {
        const outgoing = nativeResponse();
        const response = new NodeHttpResponse(outgoing);
        const error = writeError('EIO');
        const observed = new Promise<Error>(resolve => response.once('error', resolve));
        outgoing.emit('error', error);
        const actual = await observed;
        assert.equal(actual, error);
    });

    it('preserves native errors after the wrapper has already closed', async () => {
        const outgoing = nativeResponse();
        const response = new NodeHttpResponse(outgoing);
        const closed = once(response, 'close');
        response.destroy();
        await closed;
        const error = writeError('EIO');
        assert.throws(
            () => outgoing.emit('error', error),
            candidate => candidate === error
        );
    });

    it('keeps unrelated native errors visible to an existing owner after the wrapper closes', async () => {
        const outgoing = nativeResponse();
        const response = new NodeHttpResponse(outgoing);
        const closed = once(response, 'close');
        response.destroy();
        await closed;
        const error = writeError('EIO');
        let observed: Error | undefined;
        response.once('error', actual => {
            observed = actual;
        });
        outgoing.emit('error', error);
        assert.equal(observed, error);
    });

    for (const operation of ['write', 'end'] as const) {
        it(`preserves a late ${operation} callback error after the wrapper closes`, async () => {
            const outgoing = nativeResponse();
            const response = new NodeHttpResponse(outgoing);
            response.writeHead(200);
            let complete!: (error: Error) => void;
            if (operation === 'write') {
                outgoing.write = ((_chunk: unknown, _encoding: unknown, callback: (error: Error) => void) => {
                    complete = callback;
                    return true;
                }) as ServerResponse['write'];
                response.write('data');
            } else {
                outgoing.end = ((callback: (error: Error) => void) => {
                    complete = callback;
                    return outgoing;
                }) as ServerResponse['end'];
                response.end();
            }
            const closed = once(response, 'close');
            response.destroy();
            await closed;
            const error = writeError('EIO');
            assert.throws(
                () => complete(error),
                candidate => candidate === error
            );
        });
    }

    it('preserves an existing one-time native error owner', () => {
        const outgoing = nativeResponse();
        let observed: Error | undefined;
        outgoing.once('error', error => {
            observed = error;
        });
        writeNodeResponse(outgoing, new MemoryHttpResponse());
        const error = writeError('EIO');
        assert.doesNotThrow(() => outgoing.emit('error', error));
        assert.equal(observed, error);
    });

    for (const timing of ['before', 'after'] as const) {
        for (const persistent of [true, false]) {
            it(`preserves a ${persistent ? 'persistent' : 'one-time'} native error owner installed ${timing} the wrapper`, async () => {
                const outgoing = nativeResponse();
                const error = writeError('EIO');
                const nativeErrors: Error[] = [];
                const wrapperErrors: Error[] = [];
                const ownError = () => {
                    if (persistent) outgoing.on('error', actual => nativeErrors.push(actual));
                    else outgoing.once('error', actual => nativeErrors.push(actual));
                };
                if (timing === 'before') ownError();
                const response = new NodeHttpResponse(outgoing);
                response.on('error', actual => wrapperErrors.push(actual));
                if (timing === 'after') ownError();
                outgoing.emit('error', error);
                await new Promise<void>(resolve => setImmediate(resolve));
                assert.deepEqual(nativeErrors, [error]);
                assert.deepEqual(wrapperErrors, []);
            });
        }
    }

    it('surfaces the next native error after a one-time owner has been consumed', async () => {
        const outgoing = nativeResponse();
        outgoing.once('error', () => {});
        const response = new NodeHttpResponse(outgoing);
        outgoing.emit('error', writeError('EIO'));
        const error = writeError('ENOSPC');
        const observed = new Promise<Error>(resolve => response.once('error', resolve));
        outgoing.emit('error', error);
        const actual = await observed;
        assert.equal(actual, error);
    });

    it('preserves connection errors explicitly supplied by the response owner', async () => {
        const outgoing = nativeResponse();
        const response = new NodeHttpResponse(outgoing);
        const error = writeError('ECONNRESET');
        const observed = new Promise<Error>(resolve => response.once('error', resolve));
        response.destroy(error);
        const actual = await observed;
        assert.equal(actual, error);
    });

    it('does not attempt a fallback response after the client has disconnected', () => {
        const outgoing = nativeResponse();
        Object.defineProperty(outgoing, 'destroyed', { value: true });
        outgoing.end = () => {
            throw new Error('must not write again');
        };
        writeUnhandledNodeError(outgoing, writeError('EPIPE'));
        assert.equal(outgoing.destroyed, true);
    });

    it('still sends a fallback response for an upstream connection error', () => {
        const outgoing = nativeResponse();
        let ended = false;
        outgoing.end = (() => {
            ended = true;
            return outgoing;
        }) as ServerResponse['end'];
        writeUnhandledNodeError(outgoing, writeError('ECONNRESET'));
        assert.equal(ended, true);
        assert.equal(outgoing.destroyed, false);
    });

    it('keeps the process alive and accepts another request after the client socket is destroyed', () => {
        const script = `
            const assert = require('node:assert/strict');
            const { once } = require('node:events');
            const { createServer, get } = require('node:http');
            const { connect } = require('node:net');
            const { HttpServerRuntime, writeNodeResponse, writeUnhandledNodeError } = require(${JSON.stringify(require.resolve('../src/http/base'))});
            const { MemoryHttpResponse, NodeHttpResponse } = require(${JSON.stringify(require.resolve('../src/http/response'))});
            async function run() {
                // Keep the server side in the close race, and deterministically inject the native
                // write failure. This exercises the real request listener and fallback catch path.
                for (const code of ['EPIPE', 'ECONNRESET']) {
                    for (const mode of ['response', 'fallback']) {
                        let accept, release, finish;
                        const accepted = new Promise(resolve => accept = resolve);
                        const released = new Promise(resolve => release = resolve);
                        const ended = new Promise(resolve => finish = resolve);
                        let writes = 0;
                        const runtime = new HttpServerRuntime({
                            config: { APP_ENV: 'test', HTTP_REQUEST_LOGGING_MODE: 'none', HTTP_KEEP_ALIVE_TIMEOUT_MS: 70000 },
                            logger: { scoped() { return this; } },
                            router: {
                                hasFallbackController() { return false; },
                                async handle(request, response) {
                                    if (request.path === '/health') { response.end('alive'); return response; }
                                    response.outgoing.once('close', finish);
                                    response.outgoing.end = () => {
                                        writes++;
                                        throw Object.assign(new Error('write ' + code), { code, syscall: 'write' });
                                    };
                                    accept();
                                    await released;
                                    if (mode === 'fallback') throw new Error('controller failed');
                                    response.end('late body');
                                    return response;
                                }
                            }
                        });
                        const server = await runtime.listen(0, '127.0.0.1');
                        const port = server.address().port;
                        const client = connect(port, '127.0.0.1');
                        await once(client, 'connect');
                        client.write('GET /disconnect HTTP/1.1\\r\\nHost: localhost\\r\\n\\r\\n');
                        await accepted;
                        client.destroy();
                        release();
                        await ended;
                        const body = await new Promise((resolve, reject) => {
                            get({ host: '127.0.0.1', port, path: '/health', agent: false }, response => {
                                let body = '';
                                response.on('data', chunk => body += chunk);
                                response.on('end', () => resolve(body));
                                response.on('error', reject);
                            }).on('error', reject);
                        });
                        assert.equal(body, 'alive');
                        assert.equal(writes, 1, 'the failed response must not be ended again');
                        await runtime.close();
                    }
                }
                for (const mode of ['memory', 'fallback', 'buffered', 'stream']) {
                    let received;
                    const accepted = new Promise(resolve => received = resolve);
                    let finish;
                    const ended = new Promise(resolve => finish = resolve);
                    const server = createServer(async (request, outgoing) => {
                        if (request.url === '/health') { outgoing.end('alive'); return; }
                        const response = new NodeHttpResponse(outgoing);
                        if (mode === 'stream') response.writeHead(200);
                        const closed = once(outgoing, 'close');
                        received();
                        await closed;
                        if (mode === 'memory') writeNodeResponse(outgoing, new MemoryHttpResponse());
                        if (mode === 'fallback') writeUnhandledNodeError(outgoing, new Error('failed request'));
                        if (mode === 'buffered') { response.end('late body'); response.flush(); }
                        if (mode === 'stream') response.end('late stream');
                        // Allow queued stream callbacks/error events to run before checking health.
                        setImmediate(finish);
                    });
                    server.listen(0, '127.0.0.1');
                    await once(server, 'listening');
                    const port = server.address().port;
                    const client = connect(port, '127.0.0.1');
                    await once(client, 'connect');
                    client.write('GET /disconnect HTTP/1.1\\r\\nHost: localhost\\r\\n\\r\\n');
                    await accepted;
                    client.destroy();
                    await ended;
                    const body = await new Promise((resolve, reject) => {
                        get({ host: '127.0.0.1', port, path: '/health', agent: false }, response => {
                            let body = '';
                            response.on('data', chunk => body += chunk);
                            response.on('end', () => resolve(body));
                            response.on('error', reject);
                        }).on('error', reject);
                    });
                    assert.equal(body, 'alive');
                    await new Promise(resolve => server.close(resolve));
                }
                console.log('alive after all disconnect paths');
            }
            run().catch(error => { console.error(error); process.exitCode = 1; });
        `;
        // A separate process ensures an uncaught exception cannot be hidden by the test runner.
        const child = spawnSync(process.execPath, ['-e', script], {
            encoding: 'utf8',
            timeout: 15000,
            env: { ...process.env, APP_ENV: 'test' }
        });
        assert.equal(child.error, undefined);
        assert.equal(child.status, 0, child.stderr);
        assert.match(child.stdout, /alive after all disconnect paths/);
    });
});
