<template>
    <nav class="sidebar">
        <div class="sidebar-header">
            <span class="logo">DevConsole</span>
            <span class="conn-dot" :class="connected ? 'conn-on' : 'conn-off'" :title="connected ? 'Connected' : 'Disconnected'"></span>
        </div>
        <ul class="nav-list">
            <li v-for="item in navItems" :key="item.path">
                <router-link :to="item.path" :class="{ active: isActive(item.path) }">
                    {{ item.label }}
                </router-link>
            </li>
        </ul>
        <div class="sidebar-status">
            <div class="status-row">
                <span class="status-label">PID</span>
                <span class="status-value mono">{{ proc?.pid ?? '—' }}</span>
            </div>
            <div class="status-row">
                <span class="status-label">Uptime</span>
                <span class="status-value mono">{{ uptimeSeconds != null ? formatUptime(uptimeSeconds) : '—' }}</span>
            </div>
            <div class="status-row">
                <span class="status-label">CPU</span>
                <span class="status-value mono">{{ cpuPercent !== null ? cpuPercent + '%' : '—' }}</span>
            </div>
            <div class="status-row">
                <span class="status-label">Memory</span>
                <span class="status-value mono">{{ proc ? formatBytes(proc.memory.rss) : '—' }}</span>
            </div>
        </div>
    </nav>
</template>

<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from 'vue';
import { useRoute } from 'vue-router';

import { api, type ProcessInfo } from '../api';
import { uptimeSeconds, formatUptime, setUptimeFromSeconds } from '../composables/useUptime';
import { ws } from '../ws';

const connected = ws.connected;

const route = useRoute();

const navItems = [
    { path: '/', label: 'Dashboard' },
    { path: '/routes', label: 'Routes' },
    { path: '/openapi', label: 'OpenAPI' },
    { path: '/requests', label: 'Requests' },
    { path: '/srpc', label: 'SRPC' },
    { path: '/database', label: 'Database Entities' },
    { path: '/database-log', label: 'Database Log' },
    { path: '/health', label: 'Health' },
    { path: '/mutex', label: 'Mutex' },
    { path: '/repl', label: 'REPL' },
    { path: '/env', label: 'Environment' },
    { path: '/workers', label: 'Workers' }
];

function isActive(path: string): boolean {
    if (route.path === path) return true;
    if (path === '/') return false;
    if (!route.path.startsWith(path + '/')) return false;
    return !navItems.some(
        item => item.path !== path && item.path.length > path.length && (route.path === item.path || route.path.startsWith(item.path + '/'))
    );
}

const proc = ref<ProcessInfo | null>(null);
const cpuPercent = ref<string | null>(null);
let prevCpu: NodeJS.CpuUsage | null = null;
let prevTime = 0;
let timer: ReturnType<typeof setInterval> | null = null;

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function poll() {
    try {
        const data = await api.process();
        proc.value = data;
        setUptimeFromSeconds(data.uptime);
        const now = Date.now();
        if (prevCpu && prevTime) {
            const dt = (now - prevTime) * 1000; // wall time in microseconds
            const du = data.cpu.user - prevCpu.user + (data.cpu.system - prevCpu.system);
            cpuPercent.value = dt > 0 ? ((du / dt) * 100).toFixed(1) : '0.0';
        }
        prevCpu = data.cpu;
        prevTime = now;
    } catch {
        // ignore poll errors
    }
}

onMounted(() => {
    poll();
    timer = setInterval(poll, 3000);

    watch(connected, val => {
        if (val) {
            poll();
            if (!timer) timer = setInterval(poll, 3000);
        } else {
            if (timer) {
                clearInterval(timer);
                timer = null;
            }
        }
    });
});

onUnmounted(() => {
    if (timer) clearInterval(timer);
});
</script>

<style scoped>
.sidebar {
    width: 200px;
    background: #161b22;
    border-right: 1px solid #21262d;
    min-height: 100vh;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
}

.sidebar-header {
    padding: 16px;
    border-bottom: 1px solid #21262d;
    display: flex;
    align-items: center;
    gap: 8px;
}

.logo {
    font-weight: 700;
    font-size: 16px;
    color: #f0f6fc;
}

.conn-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
}

.conn-on {
    background: #3fb950;
    box-shadow: 0 0 4px #3fb95088;
}

.conn-off {
    background: #f85149;
    box-shadow: 0 0 4px #f8514988;
}

.nav-list {
    list-style: none;
    padding: 8px;
    flex: 1;
}

.nav-list li a {
    display: block;
    padding: 8px 12px;
    border-radius: 6px;
    color: #8b949e;
    text-decoration: none;
    font-size: 14px;
}

.nav-list li a:hover {
    color: #e1e4e8;
    background: #21262d;
    text-decoration: none;
}

.nav-list li a.active {
    color: #f0f6fc;
    background: #1f6feb33;
}

.sidebar-status {
    padding: 12px;
    border-top: 1px solid #21262d;
    font-size: 12px;
}

.status-row {
    display: flex;
    justify-content: space-between;
    padding: 2px 0;
}

.status-label {
    color: #484f58;
}

.status-value {
    color: #8b949e;
}
</style>
