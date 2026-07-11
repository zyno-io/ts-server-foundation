import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';

const docsDirectory = join(process.cwd(), 'docs', 'content');
const configPath = join(process.cwd(), 'docs', '.vitepress', 'config.mts');
const markdownFiles = readdirSync(docsDirectory)
    .filter(file => file.endsWith('.md'))
    .map(file => join(docsDirectory, file));

describe('documentation quality', () => {
    it('resolves local Markdown links, assets, and heading anchors', () => {
        const failures: string[] = [];

        for (const file of markdownFiles) {
            const markdown = readFileSync(file, 'utf8');
            const content = withoutFencedCode(markdown);
            for (const target of markdownLinkTargets(content)) {
                if (isExternalTarget(target)) continue;

                const [rawPath, rawFragment] = target.split('#', 2);
                const fragment = rawFragment ? decodeURIComponent(rawFragment) : undefined;
                const targetPath = resolveDocumentationTarget(file, rawPath);
                if (!targetPath || !existsSync(targetPath)) {
                    failures.push(`${basename(file)}: missing target ${target}`);
                    continue;
                }
                if (fragment && targetPath.endsWith('.md')) {
                    const anchors = markdownHeadingAnchors(readFileSync(targetPath, 'utf8'));
                    if (!anchors.has(fragment)) failures.push(`${basename(file)}: missing anchor ${target}`);
                }
            }
        }

        assert.deepStrictEqual(failures, []);
    });

    it('gives every public content page one H1 and a sidebar entry', () => {
        const config = readFileSync(configPath, 'utf8');
        const sidebarConfig = config.slice(config.indexOf('sidebar:'), config.indexOf('socialLinks:'));
        const sidebarLinks = new Set([...sidebarConfig.matchAll(/link:\s*'\/(?!')([^']+)'/g)].map(match => match[1]));
        const failures: string[] = [];

        for (const file of markdownFiles.filter(isPublicContentPage)) {
            const markdown = withoutFencedCode(readFileSync(file, 'utf8'));
            const h1Count = [...markdown.matchAll(/^#\s+.+$/gm)].length;
            const route = basename(file, '.md');
            if (h1Count !== 1) failures.push(`${basename(file)}: expected one H1, found ${h1Count}`);
            if (!sidebarLinks.has(route)) failures.push(`${basename(file)}: missing sidebar entry`);
        }

        assert.deepStrictEqual(failures, []);
    });
});

function withoutFencedCode(markdown: string): string {
    return markdown.replace(/^\s*(```|~~~)[\s\S]*?^\s*\1\s*$/gm, '');
}

function markdownLinkTargets(markdown: string): string[] {
    return [...markdown.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+['"][^'"]*['"])?\)/g)].map(match => match[1].replace(/^<|>$/g, ''));
}

function isExternalTarget(target: string): boolean {
    return /^(?:[a-z]+:|\/\/)/i.test(target);
}

function resolveDocumentationTarget(sourceFile: string, target: string): string | undefined {
    const cleanTarget = target.split('?', 1)[0];
    if (!cleanTarget) return sourceFile;
    if (cleanTarget.startsWith('/images/')) return join(docsDirectory, 'public', cleanTarget);

    const candidate = cleanTarget.startsWith('/') ? join(docsDirectory, cleanTarget) : resolve(dirname(sourceFile), cleanTarget);
    if (extname(candidate)) return candidate;
    if (existsSync(`${candidate}.md`)) return `${candidate}.md`;
    if (existsSync(join(candidate, 'index.md'))) return join(candidate, 'index.md');
    return candidate;
}

function markdownHeadingAnchors(markdown: string): Set<string> {
    const anchors = new Set<string>();
    const counts = new Map<string, number>();
    for (const match of withoutFencedCode(markdown).matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
        const heading = match[1];
        const explicit = heading.match(/\s+\{#([^}]+)\}\s*$/)?.[1];
        const base = explicit ?? slugifyHeading(heading.replace(/\s+\{#[^}]+\}\s*$/, ''));
        const count = counts.get(base) ?? 0;
        anchors.add(count === 0 ? base : `${base}-${count}`);
        counts.set(base, count + 1);
    }
    return anchors;
}

function slugifyHeading(heading: string): string {
    return heading
        .replace(/`([^`]*)`/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/<[^>]+>/g, '')
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s_-]/gu, '')
        .replace(/\s+/g, '-');
}

function isPublicContentPage(file: string): boolean {
    const name = basename(file);
    return name !== 'index.md' && name === name.toLowerCase();
}
