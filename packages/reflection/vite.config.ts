import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
    build: {
        emptyOutDir: false,
        lib: {
            entry: {
                index: fileURLToPath(new URL('./src/index.ts', import.meta.url)),
                'type-metadata-runtime': fileURLToPath(new URL('./src/type-metadata-runtime.ts', import.meta.url))
            },
            formats: ['es', 'cjs'],
            fileName: (format, entryName) => `${entryName}.${format === 'es' ? 'js' : 'cjs'}`
        },
        outDir: fileURLToPath(new URL('./dist', import.meta.url)),
        rollupOptions: {
            output: {
                assetFileNames: '[name][extname]'
            }
        }
    },
    root
});
