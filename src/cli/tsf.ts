#!/usr/bin/env node

async function main(): Promise<number> {
    const [cmd, ...rest] = process.argv.slice(2);
    process.argv = [process.argv[0], process.argv[1], ...rest];

    switch (cmd) {
        case 'create-app':
            return require('./tsf-create-app').createAppFromTemplate(rest);
        case 'test':
            return await require('./tsf-test').runTestCli(rest);
        case 'gen-proto':
            return require('./tsf-gen-proto').genProto(rest);
        default:
            console.error('Usage: tsf <command>');
            console.error();
            console.error('Commands:');
            console.error('  create-app <package-name> [path]');
            console.error('  test [node-test-options] [test-files-or-dirs...]');
            console.error('  gen-proto <proto-file-or-dir> <output-dir> [options]');
            return 1;
    }
}

main()
    .then(code => process.exit(code))
    .catch(error => {
        console.error(error);
        process.exit(1);
    });
