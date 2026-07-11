<template>
    <div class="view-padding">
        <h1 class="page-title">Dashboard</h1>
        <div v-if="loading" class="loading">Loading...</div>
        <div v-else-if="error" class="error">{{ error }}</div>
        <template v-else-if="data">
            <div class="stats-grid">
                <div class="card stat-card">
                    <div class="stat-label">Application</div>
                    <div class="stat-value">{{ data.name }}</div>
                    <div class="stat-detail">v{{ data.version }}</div>
                </div>
                <div class="card stat-card">
                    <div class="stat-label">Environment</div>
                    <div class="stat-value">{{ data.env }}</div>
                </div>
                <div class="card stat-card">
                    <div class="stat-label">Uptime</div>
                    <div class="stat-value">
                        {{ uptimeSeconds !== null ? formatUptime(uptimeSeconds) : '' }}
                    </div>
                </div>
                <div class="card stat-card">
                    <div class="stat-label">HTTP Requests</div>
                    <div class="stat-value">{{ data.counts.httpEntries }}</div>
                </div>
                <div class="card stat-card">
                    <div class="stat-label">SRPC Connections</div>
                    <div class="stat-value">{{ data.counts.srpcActiveConnections }}</div>
                </div>
                <div class="card stat-card">
                    <div class="stat-label">SRPC Messages</div>
                    <div class="stat-value">{{ data.counts.srpcMessages }}</div>
                </div>
            </div>

            <template v-if="proc">
                <h2 class="section-title">Process</h2>
                <div class="stats-grid">
                    <div class="card stat-card">
                        <div class="stat-label">PID</div>
                        <div class="stat-value mono">{{ proc.pid }}</div>
                    </div>
                    <div class="card stat-card">
                        <div class="stat-label">Node Version</div>
                        <div class="stat-value">{{ proc.nodeVersion }}</div>
                    </div>
                    <div class="card stat-card">
                        <div class="stat-label">Platform</div>
                        <div class="stat-value">{{ proc.platform }} / {{ proc.arch }}</div>
                    </div>
                </div>

                <div class="info-columns">
                    <div>
                        <h2 class="section-title">Memory</h2>
                        <div class="card">
                            <table>
                                <tbody>
                                    <tr v-for="[key, val] in memoryEntries" :key="key">
                                        <td>{{ key }}</td>
                                        <td class="mono">{{ formatBytes(val) }}</td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>
                    </div>
                    <div>
                        <h2 class="section-title">CPU</h2>
                        <div class="card">
                            <table>
                                <tbody>
                                    <tr>
                                        <td>User</td>
                                        <td class="mono">{{ (proc.cpu.user / 1000).toFixed(1) }}ms</td>
                                    </tr>
                                    <tr>
                                        <td>System</td>
                                        <td class="mono">{{ (proc.cpu.system / 1000).toFixed(1) }}ms</td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            </template>
        </template>
    </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';

import { api, type OverviewData, type ProcessInfo } from '../api';
import { uptimeSeconds, formatUptime, setUptimeFromMs } from '../composables/useUptime';
import { ws, connected } from '../ws';

const data = ref<OverviewData | null>(null);
const proc = ref<ProcessInfo | null>(null);
const loading = ref(true);
const error = ref('');

const memoryEntries = computed(() => {
    if (!proc.value) return [];
    return Object.entries(proc.value.memory);
});

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const onHttpEntry = () => {
    if (data.value) data.value.counts.httpEntries++;
};
const onSrpcMessage = () => {
    if (data.value) data.value.counts.srpcMessages++;
};
const onSrpcConnection = () => {
    if (data.value) data.value.counts.srpcActiveConnections++;
};
const onSrpcDisconnection = () => {
    if (data.value) {
        data.value.counts.srpcActiveConnections = Math.max(0, data.value.counts.srpcActiveConnections - 1);
        data.value.counts.srpcDisconnected++;
    }
};

async function fetchData() {
    try {
        const [overview, process] = await Promise.all([api.overview(), api.process()]);
        data.value = overview;
        proc.value = process;
        setUptimeFromMs(overview.uptime);
    } catch (e) {
        error.value = String(e);
    } finally {
        loading.value = false;
    }
}

onMounted(() => {
    ws.on('http:entry', onHttpEntry);
    ws.on('srpc:message', onSrpcMessage);
    ws.on('srpc:connection', onSrpcConnection);
    ws.on('srpc:disconnection', onSrpcDisconnection);

    fetchData();

    watch(connected, val => {
        if (val) fetchData();
    });
});

onUnmounted(() => {
    ws.off('http:entry', onHttpEntry);
    ws.off('srpc:message', onSrpcMessage);
    ws.off('srpc:connection', onSrpcConnection);
    ws.off('srpc:disconnection', onSrpcDisconnection);
});
</script>

<style scoped>
.stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 16px;
    margin-bottom: 16px;
}

.stat-card {
    text-align: center;
}

.stat-label {
    font-size: 12px;
    color: #8b949e;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 8px;
}

.stat-value {
    font-size: 24px;
    font-weight: 600;
    color: #f0f6fc;
}

.stat-detail {
    font-size: 13px;
    color: #8b949e;
    margin-top: 4px;
}

.section-title {
    font-size: 16px;
    font-weight: 600;
    margin: 16px 0 8px;
}

.info-columns {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
}
</style>
