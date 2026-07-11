import { defineConfig } from 'vitepress';

// https://vitepress.dev/reference/site-config
export default defineConfig({
    srcDir: 'content',
    title: '@zyno-io/ts-server-foundation',
    description: 'TypeScript server foundation with reflected type metadata',
    base: '/ts-server-foundation/',

    themeConfig: {
        // https://vitepress.dev/reference/default-theme-config
        nav: [
            { text: 'Home', link: '/' },
            { text: 'Overview', link: '/overview' },
            { text: 'Getting Started', link: '/getting-started' },
            { text: 'Release', link: '/release' }
        ],

        sidebar: [
            {
                text: 'Introduction',
                items: [
                    { text: 'Feature Overview', link: '/overview' },
                    { text: 'Getting Started', link: '/getting-started' },
                    { text: 'Public API', link: '/public-api' },
                    { text: 'Dependency Injection', link: '/di' },
                    { text: 'Configuration', link: '/configuration' },
                    { text: 'Environment', link: '/env' },
                    { text: 'Release', link: '/release' },
                    { text: 'Documentation Maintenance', link: '/documentation-plan' }
                ]
            },
            {
                text: 'Current Core',
                items: [
                    { text: 'Database', link: '/database' },
                    { text: 'SQL', link: '/sql' },
                    { text: 'Migrations', link: '/migrations' },
                    { text: 'HTTP', link: '/http' },
                    { text: 'Uploads', link: '/uploads' },
                    { text: 'OpenAPI', link: '/openapi' },
                    { text: 'Authentication', link: '/authentication' },
                    { text: 'Health Checks', link: '/health' },
                    { text: 'Logging', link: '/logging' },
                    { text: 'Types', link: '/types' },
                    { text: 'Type Reflection', link: '/reflection' },
                    { text: 'Type Reflection Architecture', link: '/type-reflection-architecture' }
                ]
            },
            {
                text: 'Services',
                items: [
                    { text: 'Workers', link: '/worker' },
                    { text: 'SRPC', link: '/srpc' },
                    { text: 'DevConsole', link: '/devconsole' },
                    { text: 'Redis', link: '/redis' },
                    { text: 'Leader Service', link: '/leader-service' },
                    { text: 'Mail', link: '/mail' },
                    { text: 'Mesh Service', link: '/mesh-service' },
                    { text: 'Mesh Client Tracking', link: '/mesh-client' }
                ]
            },
            {
                text: 'Utilities',
                items: [
                    { text: 'Helpers', link: '/helpers' },
                    { text: 'Telemetry', link: '/telemetry' },
                    { text: 'Testing', link: '/testing' },
                    { text: 'CLI Tools', link: '/cli' }
                ]
            }
        ],

        socialLinks: [{ icon: 'github', link: 'https://github.com/zyno-io/ts-server-foundation' }],

        search: {
            provider: 'local'
        },

        footer: {
            message: 'Released under the MIT License.',
            copyright: 'Copyright © 2024-present Signal 24'
        }
    }
});
