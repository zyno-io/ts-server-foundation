#!/usr/bin/env node

export function update(): number {
    console.log('No automatic updater is available for ts-server-foundation yet.');
    return 0;
}

if (require.main === module) {
    process.exit(update());
}
