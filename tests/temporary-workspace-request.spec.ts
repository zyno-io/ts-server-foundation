import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { access, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { describe, it } from 'node:test';

import {
    BaseAppConfig,
    createApp,
    execProcess,
    FileUpload,
    getRequestTemporaryWorkspace,
    http,
    HttpBody,
    HttpRequest,
    HttpResponse,
    MemoryHttpResponse,
    temporaryFiles,
    withRequestTemporaryWorkspace,
    withTemporaryWorkspace
} from '../src';

describe('temporary workspace scopes', () => {
    for (const fails of [false, true]) {
        it(`releases registered and partial outputs after scoped ${fails ? 'failure' : 'success'}`, async () => {
            let directory = '';
            const work = withTemporaryWorkspace(async workspace => {
                directory = workspace.directory;
                assert.equal(existsSync(workspace.path('result.wav')), false, 'external tools need a nonexistent output');
                assert.throws(() => workspace.path('../escape'));
                assert.throws(() => workspace.path('released'));
                await writeFile(workspace.path('result.wav'), 'completed');
                await writeFile(join(workspace.directory, 'unregistered.partial'), 'partial');
                if (fails) throw new Error('tool failed');
                return 42;
            });
            if (fails) await assert.rejects(work, /tool failed/);
            else {
                const result = await work;
                assert.equal(result, 42);
            }
            await assert.rejects(access(directory), { code: 'ENOENT' });
        });
    }

    for (const fails of [false, true]) {
        it(`shares multipart ownership and cleans derived output after route ${fails ? 'failure' : 'success'}`, async () => {
            let directory = '';
            @http.controller()
            class Controller {
                @http.POST('/convert')
                async convert(body: HttpBody<{ file: FileUpload }>, request: HttpRequest, response: HttpResponse): Promise<void> {
                    await withRequestTemporaryWorkspace(
                        request,
                        response,
                        async (workspace, signal) => {
                            directory = workspace.directory;
                            assert.equal(dirname(body.file.path), directory);
                            const content = await readFile(body.file.path, 'utf8');
                            assert.equal(content, 'input');
                            await writeFile(`${body.file.path}.partial`, 'unregistered output');
                            const metadata = await readFile(join(directory, 'owner.json'), 'utf8');
                            assert.equal(JSON.parse(metadata).replayable, true);
                            if (fails) throw new Error('conversion failed');
                            await pipeline(Readable.from(['converted']), response, { signal });
                        },
                        { replayable: true, timeoutMs: 5000 }
                    );
                }
            }
            const app = createApp({ config: BaseAppConfig, controllers: [Controller] });
            const request = HttpRequest.POST('/convert').multiPart([{ name: 'file', file: Buffer.from('input'), fileName: 'input.raw' }]);
            const response = await app.http.request(request);
            assert.equal(response.statusCode, fails ? 500 : 200);
            if (!fails) assert.equal(response.bodyString, 'converted');
            await assert.rejects(access(directory), { code: 'ENOENT' });
            await app.stop();
        });
    }

    it('kills and awaits a writing process on response disconnect before the router releases its directory', async () => {
        let pid = 0;
        let directory = '';
        let closedBeforeReturn = false;
        @http.controller()
        class Controller {
            @http.GET('/work')
            async work(request: HttpRequest, response: HttpResponse): Promise<void> {
                await withRequestTemporaryWorkspace(request, response, async (workspace, signal) => {
                    directory = workspace.directory;
                    const same = await getRequestTemporaryWorkspace(request);
                    assert.equal(same, workspace);
                    const output = workspace.path('partial.raw');
                    const script =
                        "const fs=require('node:fs');fs.writeFileSync(process.argv[1],'partial');process.stdout.write('ready');setInterval(()=>fs.appendFileSync(process.argv[1],'more'),10)";
                    const processWork = execProcess(process.execPath, ['-e', script, output], {
                        signal,
                        onSpawn(child) {
                            pid = child.pid!;
                            child.once('close', () => {
                                closedBeforeReturn = true;
                            });
                            child.stdout?.once('data', () => {
                                assert.equal(existsSync(output), true);
                                response.destroy();
                            });
                        }
                    });
                    await processWork;
                });
            }
        }
        const app = createApp({ config: BaseAppConfig, controllers: [Controller] });
        const response = new MemoryHttpResponse();
        await app.router.handle(HttpRequest.GET('/work'), response);
        assert.ok(pid);
        assert.equal(closedBeforeReturn, true);
        assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
        await assert.rejects(access(directory), { code: 'ENOENT' });
        await app.stop();
    });

    it('preserves a live workspace during a sweep and releases it through request cleanup', async () => {
        const request = HttpRequest.POST('/work');
        const workspace = await getRequestTemporaryWorkspace(request);
        await writeFile(workspace.path('live'), 'in use');
        const result = await temporaryFiles.sweep();
        assert.ok(result.removed >= 0);
        await access(workspace.path('live'));
        const uploads = await import('../src/http/uploads');
        const { cleanupUploadedFiles } = uploads;
        await cleanupUploadedFiles(request);
        await assert.rejects(access(workspace.directory), { code: 'ENOENT' });
    });
});
