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
