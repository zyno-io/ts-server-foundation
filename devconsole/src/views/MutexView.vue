<template>
    <div class="view-padding">
        <h1 class="page-title">Mutex</h1>
        <div v-if="loading" class="loading">Loading...</div>
        <div v-else-if="error" class="error">{{ error }}</div>
        <template v-else>
            <!-- Active Locks -->
            <h2 class="section-title">Active Locks</h2>
            <div v-if="active.length === 0" class="card text-muted" style="text-align: center; padding: 16px">No active locks</div>
            <div v-else class="card">
                <table>
                    <thead>
                        <tr>
                            <th>Key</th>
                            <th>Status</th>
                            <th>Since</th>
                            <th>Wait</th>
                            <th>Held</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr v-for="entry in active" :key="entry.id">
                            <td class="mono">{{ entry.key }}</td>
                            <td>
                                <span :class="statusBadge(entry.status)">{{ entry.status }}</span>
                            </td>
                            <td class="mono text-muted">
                                {{ formatTimestamp(entry.acquiredAt ?? entry.startedAt) }}
                            </td>
                            <td class="mono text-muted">
                                {{ entry.status === 'pending' ? liveWait(entry) : formatDuration(entry.waitDurationMs) }}
                            </td>
                            <td class="mono text-muted">{{ liveDuration(entry) }}</td>
                        </tr>
                    </tbody>
                </table>
            </div>

            <!-- History -->
            <h2 class="section-title">History</h2>
            <div v-if="history.length === 0" class="card text-muted" style="text-align: center; padding: 16px">No mutex history</div>
            <div v-else class="card">
                <table>
                    <thead>
                        <tr>
                            <th>Time</th>
                            <th>Key</th>
                            <th>Status</th>
                            <th>Wait</th>
                            <th>Held</th>
                            <th>Error</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr v-for="entry in history" :key="entry.id">
                            <td class="mono text-muted">
                                {{ formatTimestamp(entry.acquiredAt ?? entry.startedAt) }}
                            </td>
                            <td class="mono">{{ entry.key }}</td>
                            <td>
                                <span :class="statusBadge(entry.status)">{{ entry.status }}</span>
                            </td>
                            <td class="mono text-muted">{{ formatDuration(entry.waitDurationMs) }}</td>
                            <td class="mono text-muted">{{ formatDuration(entry.durationMs) }}</td>
                            <td class="mono text-muted">{{ entry.error ?? '-' }}</td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </template>
    </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from 'vue';

import { api, type MutexEntry } from '../api';
import { ws, connected } from '../ws';

const active = ref<MutexEntry[]>([]);
const history = ref<MutexEntry[]>([]);
const loading = ref(true);
const error = ref('');
let tickTimer: ReturnType<typeof setInterval> | null = null;
const now = ref(Date.now());

function statusBadge(status: string): string {
    switch (status) {
        case 'pending':
            return 'badge badge-yellow';
        case 'acquired':
            return 'badge badge-blue';
        case 'released':
            return 'badge badge-green';
        case 'error':
        case 'failed':
            return 'badge badge-red';
        default:
            return 'badge badge-gray';
    }
}

function formatTimestamp(ts: number | undefined): string {
    if (!ts) return '-';
    return new Date(ts).toLocaleString('en-GB');
}

function formatDuration(ms: number | undefined): string {
    if (ms == null) return '-';
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
}

function liveDuration(entry: MutexEntry): string {
    const since = entry.acquiredAt ?? entry.startedAt;
    if (!since) return '-';
    const ms = now.value - since;
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
}

function liveWait(entry: MutexEntry): string {
    const ms = now.value - entry.startedAt;
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
}

const onMutexPending = (entry: MutexEntry) => {
    active.value = [...active.value, entry];
    history.value = [entry, ...history.value];
    if (history.value.length > 200) history.value = history.value.slice(0, 200);
};

const onMutexAcquired = (entry: MutexEntry) => {
    // Update existing pending entry in active list
    const activeIdx = active.value.findIndex(e => e.id === entry.id);
    if (activeIdx >= 0) {
        active.value[activeIdx] = entry;
        active.value = [...active.value]; // trigger reactivity
    }
    const histIdx = history.value.findIndex(e => e.id === entry.id);
    if (histIdx >= 0) history.value[histIdx] = entry;
};

const onMutexReleased = (entry: MutexEntry) => {
    active.value = active.value.filter(e => e.id !== entry.id);
    const idx = history.value.findIndex(e => e.id === entry.id);
    if (idx >= 0) history.value[idx] = entry;
};

const onMutexError = (entry: MutexEntry) => {
    active.value = active.value.filter(e => e.id !== entry.id);
    const idx = history.value.findIndex(e => e.id === entry.id);
    if (idx >= 0) history.value[idx] = entry;
};

const onMutexFailed = (entry: MutexEntry) => {
    active.value = active.value.filter(e => e.id !== entry.id);
    const idx = history.value.findIndex(e => e.id === entry.id);
    if (idx >= 0) {
        history.value[idx] = entry;
    } else {
        history.value = [entry, ...history.value];
        if (history.value.length > 200) history.value = history.value.slice(0, 200);
    }
};

async function fetchData() {
    try {
        const data = await api.mutexes();
        active.value = data.active;
        history.value = data.history;
    } catch (e) {
        error.value = String(e);
    } finally {
        loading.value = false;
    }
}

onMounted(() => {
    ws.on('mutex:pending', onMutexPending);
    ws.on('mutex:acquired', onMutexAcquired);
    ws.on('mutex:released', onMutexReleased);
    ws.on('mutex:error', onMutexError);
    ws.on('mutex:failed', onMutexFailed);

    fetchData();

    watch(connected, val => {
        if (val) fetchData();
    });

    tickTimer = setInterval(() => {
        now.value = Date.now();
    }, 500);
});

onUnmounted(() => {
    ws.off('mutex:pending', onMutexPending);
    ws.off('mutex:acquired', onMutexAcquired);
    ws.off('mutex:released', onMutexReleased);
    ws.off('mutex:error', onMutexError);
    ws.off('mutex:failed', onMutexFailed);
    if (tickTimer) clearInterval(tickTimer);
});
</script>

<style scoped>
.section-title {
    font-size: 14px;
    font-weight: 600;
    color: #8b949e;
    margin: 20px 0 8px;
}

.section-title:first-of-type {
    margin-top: 0;
}
</style>
