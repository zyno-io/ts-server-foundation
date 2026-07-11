import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
    root,
    plugins: [vue()],
    base: '/_devconsole/',
    build: {
        outDir: '../dist/devconsole',
        emptyOutDir: true
    },
    server: {
        proxy: {
            '/_devconsole/api': 'http://localhost:3000',
            '/openapi.json': 'http://localhost:3000',
            '/_devconsole/ws': {
                target: 'ws://localhost:3000',
                ws: true
            }
        }
    }
});
