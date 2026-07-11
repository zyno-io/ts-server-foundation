<template>
    <div class="app">
        <NavSidebar />
        <main class="main">
            <router-view />
        </main>
    </div>
</template>

<script setup lang="ts">
import NavSidebar from './components/NavSidebar.vue';
</script>

<style>
* {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
}

body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #0f1117;
    color: #e1e4e8;
    font-size: 14px;
}

.app {
    display: flex;
    height: 100vh;
    overflow: hidden;
}

.main {
    flex: 1;
    overflow: auto;
}

.view-padding {
    padding: 24px;
}

a {
    color: #58a6ff;
    text-decoration: none;
}

a:hover {
    text-decoration: underline;
}

table {
    width: 100%;
    border-collapse: collapse;
}

th,
td {
    text-align: left;
    padding: 8px 12px;
    border-bottom: 1px solid #21262d;
}

th {
    color: #8b949e;
    font-weight: 600;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
}

tr:hover {
    background: #161b22;
}

pre {
    background: #161b22;
    border: 1px solid #21262d;
    border-radius: 6px;
    padding: 12px;
    overflow-x: auto;
    font-size: 13px;
}

code {
    font-family: 'SF Mono', SFMono-Regular, Consolas, 'Liberation Mono', Menlo, monospace;
}

.card {
    background: #161b22;
    border: 1px solid #21262d;
    border-radius: 8px;
    padding: 16px;
    margin-bottom: 16px;
}

.page-title {
    font-size: 20px;
    font-weight: 600;
    margin-bottom: 16px;
}

.badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 12px;
    font-size: 12px;
    font-weight: 600;
}

.badge-green {
    background: #0d4429;
    color: #3fb950;
}

.badge-red {
    background: #490d0d;
    color: #f85149;
}

.badge-yellow {
    background: #4a3b0d;
    color: #d29922;
}

.badge-blue {
    background: #0d2d4a;
    color: #58a6ff;
}

.badge-gray {
    background: #21262d;
    color: #8b949e;
}

.mono {
    font-family: 'SF Mono', SFMono-Regular, Consolas, 'Liberation Mono', Menlo, monospace;
}

.text-muted {
    color: #8b949e;
}

.loading {
    color: #8b949e;
    padding: 24px;
}

.error {
    color: #f85149;
    padding: 24px;
}
</style>
