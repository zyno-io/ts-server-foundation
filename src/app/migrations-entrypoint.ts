import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

export function parseEntrypointMigrationsDir(args: string[]): string {
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (arg === '--migrations-dir') {
            const value = args[index + 1];
            if (!value) throw new Error('--migrations-dir requires a value');
            return value;
        }
        if (arg.startsWith('--migrations-dir=')) return arg.slice('--migrations-dir='.length);
    }
    return 'src/migrations';
}

export function sourceToDistMigrationsDir(sourceDir: string): string {
    const absoluteSource = isAbsolute(sourceDir) ? sourceDir : resolve(sourceDir);
    const segments = absoluteSource.split(/[\\/]/);
    if (segments.includes('dist')) return absoluteSource;
    const srcIndex = segments.lastIndexOf('src');
    if (srcIndex !== -1) {
        const base = segments.slice(0, srcIndex).join(sep) || sep;
        return join(base, 'dist', ...segments.slice(srcIndex));
    }
    return join(dirname(absoluteSource), 'dist', basenameNoExt(absoluteSource));
}

function basenameNoExt(path: string): string {
    return path.split(/[\\/]/).filter(Boolean).pop() ?? 'migrations';
}
