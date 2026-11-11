import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { execProcess } from '../src';

describe('process cancellation', () => {
    it('does not spawn when already aborted', async () => {
        let spawned = false;
        await assert.rejects(
            execProcess(process.execPath, ['-e', ''], {
                signal: AbortSignal.abort(),
                onSpawn() {
                    spawned = true;
                }
            }),
            { name: 'AbortError' }
        );
        assert.equal(spawned, false);
    });

    it('enforces a deadline and waits for process closure', async () => {
        let closed = false;
        let pid = 0;
        await assert.rejects(
            execProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
                timeoutMs: 150,
                onSpawn(child) {
                    pid = child.pid!;
                    child.on('close', () => {
                        closed = true;
                    });
                }
            }),
            { name: 'AbortError' }
        );
        assert.equal(closed, true);
        assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    });

    it('escalates a child that ignores SIGTERM and stops its writes before rejecting', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'tsf-process-abort-'));
        const marker = join(directory, 'ready');
        const controller = new AbortController();
        let pid = 0;
        const work = execProcess(
            process.execPath,
            [
                '-e',
                `const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync(process.argv[1],'ready');setInterval(()=>{},1000);`,
                marker
            ],
            {
                signal: controller.signal,
                killGraceMs: 25,
                onSpawn(child) {
                    pid = child.pid!;
                }
            }
        );
        const rejected = assert.rejects(work, { name: 'AbortError' });
        try {
            for (let attempt = 0; !existsSync(marker) && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
            assert.ok(existsSync(marker));
            controller.abort();
            await rejected;
            assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
        } finally {
            controller.abort();
            await rejected;
            await rm(directory, { recursive: true, force: true });
        }
    });
});
