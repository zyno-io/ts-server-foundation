#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import { Env } from '../env';

export function genProto(args = process.argv.slice(2)): number {
    if (args.includes('-h') || args.includes('--help')) {
        printUsage();
        return 0;
    }
    if (args.length < 2) {
        printUsage();
        return 1;
    }

    const inputPath = resolve(args[0]);
    const outputDir = resolve(args[1]);
    if (!existsSync(inputPath)) {
        console.error(`Error: Input path does not exist: ${inputPath}`);
        return 1;
    }

    const { protoFiles, protoDir, outputBaseName } = collectProtoFiles(inputPath);
    if (protoFiles.length === 0) {
        console.log('No .proto files found, nothing to generate.');
        return 0;
    }

    mkdirSync(outputDir, { recursive: true });
    const plugin = findTsProtoPlugin();
    if (!plugin) {
        console.error('Error: ts-proto not found. Reinstall @zyno-io/ts-server-foundation or add ts-proto to the current project.');
        return 1;
    }

    const options = buildTsProtoOptions(args.slice(2));
    const protoc = resolveProtocCommand();
    const result = spawnSync(
        protoc.command,
        [
            ...protoc.args,
            `--plugin=protoc-gen-ts_proto=${plugin}`,
            `--ts_proto_out=${outputDir}`,
            `--ts_proto_opt=${options.join(',')}`,
            `-I${protoDir}`,
            ...protoFiles
        ],
        { stdio: 'inherit' }
    );
    if (result.error) {
        console.error(result.error.message);
        return 1;
    }
    if (result.status !== 0) return result.status ?? 1;

    console.log(`Generated ${protoFiles.length} proto file(s) into ${outputDir}.`);
    console.log(`Import generated types from ${join(outputDir, outputBaseName).replace(process.cwd(), '.')}.`);
    return 0;
}

function resolveProtocCommand(): { command: string; args: string[] } {
    if (Env.PROTOC) return { command: Env.PROTOC, args: [] };

    const bundledProtoc = findProtocBin();
    if (bundledProtoc) return { command: process.execPath, args: [bundledProtoc] };

    return { command: 'protoc', args: [] };
}

function printUsage(): void {
    console.log(`Usage: tsf-gen-proto <proto-file-or-dir> <output-dir> [options]

Options:
  --only-types       Only generate type definitions
  --use-date         Use Date for google.protobuf.Timestamp
  --use-map-type     Use ES6 Map for proto maps`);
}

function collectProtoFiles(inputPath: string): {
    protoFiles: string[];
    protoDir: string;
    outputBaseName: string;
} {
    const stat = statSync(inputPath);
    if (stat.isFile()) {
        if (!inputPath.endsWith('.proto')) throw new Error(`Input file must be a .proto file: ${inputPath}`);
        return {
            protoFiles: [inputPath],
            protoDir: dirname(inputPath),
            outputBaseName: basename(inputPath, '.proto')
        };
    }
    if (!stat.isDirectory()) throw new Error(`Input path is neither a file nor directory: ${inputPath}`);
    return {
        protoFiles: readdirSync(inputPath)
            .filter(file => file.endsWith('.proto'))
            .map(file => join(inputPath, file)),
        protoDir: inputPath,
        outputBaseName: 'proto'
    };
}

function findTsProtoPlugin(): string | undefined {
    return findPackageBin('ts-proto', 'protoc-gen-ts_proto');
}

function findProtocBin(): string | undefined {
    return findPackageBin('protoc', 'protoc');
}

function findPackageBin(packageName: string, binName: string): string | undefined {
    try {
        const packageJson = require.resolve(`${packageName}/package.json`, {
            paths: [process.cwd(), __dirname]
        });
        const manifest = JSON.parse(readFileSync(packageJson, 'utf8')) as {
            bin?: string | Record<string, string>;
        };
        const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[binName];
        if (!bin) return undefined;

        const binPath = join(dirname(packageJson), bin);
        return existsSync(binPath) ? binPath : undefined;
    } catch {
        return undefined;
    }
}

function buildTsProtoOptions(args: string[]): string[] {
    const options: string[] = [];
    if (args.includes('--only-types')) options.push('onlyTypes=true');
    if (!args.includes('--use-date')) options.push('useDate=false');
    if (!args.includes('--use-map-type')) options.push('useMapType=false');
    options.push('esModuleInterop=true', 'outputServices=false');
    return options;
}

if (require.main === module) {
    try {
        process.exit(genProto());
    } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
    }
}
