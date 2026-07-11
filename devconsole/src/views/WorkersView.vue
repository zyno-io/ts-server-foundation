<template>
    <div class="workers-layout" ref="layoutEl" data-resize-container>
        <div class="workers-list" :class="{ 'has-detail': !!selected }">
            <h1 class="page-title">Workers</h1>
            <div v-if="loading" class="loading">Loading...</div>
            <div v-else-if="error" class="error">{{ error }}</div>
            <template v-else>
                <!-- Queue summary -->
                <div v-if="Object.keys(counts).length > 0" class="queue-summary">
                    <div v-for="(queueCounts, name) in counts" :key="name" class="queue-chip">
                        <span class="queue-chip-name">{{ name }}</span>
                        <template v-if="isError(queueCounts)">
                            <span class="text-muted">error</span>
                        </template>
                        <template v-else>
                            <span
                                v-for="[key, val] in Object.entries(queueCounts as Record<string, number>).filter(([, v]) => v > 0)"
                                :key="key"
                                class="queue-chip-stat"
                            >
                                {{ key }}: <strong>{{ val }}</strong>
                            </span>
                            <span v-if="Object.values(queueCounts as Record<string, number>).every(v => v === 0)" class="text-muted">idle</span>
                        </template>
                    </div>
                </div>

                <!-- No data -->
                <div v-if="jobs.length === 0" class="card text-muted" style="text-align: center; padding: 24px">No jobs recorded</div>

                <!-- Jobs table -->
                <div v-else class="card">
                    <table>
                        <thead>
                            <tr>
                                <th>Completed</th>
                                <th>Queue</th>
                                <th>Name</th>
                                <th>Status</th>
                                <th>Duration</th>
                                <th>Attempt</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr
                                v-for="job in jobs"
                                :key="job.id"
                                class="clickable-row"
                                :class="{ 'selected-row': selected?.id === job.id }"
                                @click="selectJob(job)"
                            >
                                <td class="mono text-muted">{{ formatTime(job) }}</td>
                                <td class="mono">{{ job.queue }}</td>
                                <td class="mono">{{ job.name }}</td>
                                <td>
                                    <span :class="statusBadge(job.status)">{{ job.status }}</span>
                                </td>
                                <td class="mono text-muted">{{ formatDuration(job) }}</td>
                                <td class="mono text-muted">{{ job.attempt }}</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </template>
        </div>

        <div v-if="selected" class="resize-handle" @mousedown="startResize"></div>
        <div v-if="selected" class="detail-panel" :style="{ height: panelHeight + 'px' }">
            <div class="detail-panel-header">
                <span class="detail-panel-title">
                    <span class="mono">{{ selected.name }}</span>
                    <span class="header-sep"></span>
                    <span :class="statusBadge(selected.status)">{{ selected.status }}</span>
                    <span class="header-sep"></span>
                    <span class="mono text-muted">{{ selected.queue }}</span>
                    <template v-if="selected.traceId">
                        <span class="header-sep"></span>
                        <span class="mono text-muted">trace: {{ selected.traceId }}</span>
                    </template>
                    <span class="header-sep"></span>
                    <span class="mono text-muted">attempt {{ selected.attempt }}</span>
                </span>
                <button class="detail-close" @click="closeDetail">&times;</button>
            </div>
            <div class="detail-panel-body">
                <div class="detail-split">
                    <div class="detail-pane">
                        <h4 class="subsection-title">Input Data</h4>
                        <JsonViewer v-if="selected.data != null" :data="selected.data" />
                        <span v-else class="text-muted">(none)</span>

                        <h4 class="subsection-title">Timestamps</h4>
                        <table class="timestamps-table">
                            <tbody>
                                <tr>
                                    <td class="text-muted">Created</td>
                                    <td class="mono">{{ formatTimestamp(selected.createdAt) }}</td>
                                </tr>
                                <tr v-if="selected.shouldExecuteAt !== selected.createdAt">
                                    <td class="text-muted">Scheduled</td>
                                    <td class="mono">{{ formatTimestamp(selected.shouldExecuteAt) }}</td>
                                </tr>
                                <tr v-if="selected.executedAt">
                                    <td class="text-muted">Executed</td>
                                    <td class="mono">{{ formatTimestamp(selected.executedAt) }}</td>
                                </tr>
                                <tr v-if="selected.completedAt">
                                    <td class="text-muted">Completed</td>
                                    <td class="mono">{{ formatTimestamp(selected.completedAt) }}</td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                    <div class="detail-pane">
                        <h4 class="subsection-title">Result</h4>
                        <JsonViewer v-if="selected.result != null" :data="selected.result" />
                        <span v-else class="text-muted">(none)</span>
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { useRouter, useRoute } from 'vue-router';

import { api, type WorkerJob } from '../api';
import JsonViewer from '../components/JsonViewer.vue';
import { useResizePanel } from '../composables/useResizePanel';
import { ws, connected } from '../ws';

const router = useRouter();
const route = useRoute();

const layoutEl = ref<HTMLElement | null>(null);
const { panelHeight, startResize, initHeight } = useResizePanel('tsf:workersPanelHeight');
const counts = ref<Record<string, unknown>>({});
const liveJobs = ref<WorkerJob[]>([]);
const historyJobs = ref<WorkerJob[]>([]);
const loading = ref(true);
const error = ref('');
const selected = ref<WorkerJob | null>(null);

const jobs = computed<WorkerJob[]>(() => {
    // Live jobs first (sorted newest first), then history (already sorted by completedAt desc)
    const live = [...liveJobs.value].sort((a, b) => b.createdAt - a.createdAt);
    return [...live, ...historyJobs.value];
});

function isError(val: unknown): boolean {
    return typeof val === 'object' && val !== null && 'error' in val;
}

function statusBadge(status: string): string {
    switch (status) {
        case 'completed':
            return 'badge badge-green';
        case 'failed':
            return 'badge badge-red';
        case 'active':
            return 'badge badge-blue';
        case 'delayed':
            return 'badge badge-yellow';
        case 'waiting':
            return 'badge badge-gray';
        default:
            return 'badge badge-gray';
    }
}

function formatTime(job: WorkerJob): string {
    const ts = job.completedAt ?? job.executedAt ?? job.createdAt;
    return new Date(ts).toLocaleString('en-GB');
}

function formatDuration(job: WorkerJob): string {
    if (!job.executedAt || !job.completedAt) return '-';
    const ms = job.completedAt - job.executedAt;
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
}

function formatTimestamp(ts: number | null | undefined): string {
    if (!ts) return '-';
    return new Date(ts).toLocaleString('en-GB');
}

function selectJob(job: WorkerJob) {
    const next = selected.value?.id === job.id ? null : job;
    selected.value = next;
    router.replace({ query: next ? { id: next.id } : {} });
}

function closeDetail() {
    selected.value = null;
    router.replace({ query: {} });
}

const MAX_HISTORY = 500;

// Real-time: completed/failed job arrives from observer
const onWorkerJob = (job: WorkerJob) => {
    historyJobs.value.unshift(job);
    if (historyJobs.value.length > MAX_HISTORY) historyJobs.value.pop();
    // Remove from live if present
    liveJobs.value = liveJobs.value.filter(j => j.queueId !== job.queueId || j.queue !== job.queue);
    refreshCounts();
};

// Real-time: job added/active/delayed — refresh live section
const onWorkerLiveEvent = () => {
    api.workersJobs()
        .then(data => {
            liveJobs.value = data.live;
        })
        .catch(() => {
            /* ignore */
        });
    refreshCounts();
};

function refreshCounts() {
    api.workers()
        .then(data => {
            counts.value = data;
        })
        .catch(() => {
            /* ignore */
        });
}

async function fetchData() {
    try {
        const [countsData, jobsData] = await Promise.all([api.workers(), api.workersJobs()]);
        counts.value = countsData;
        liveJobs.value = jobsData.live;
        historyJobs.value = jobsData.history;

        const qid = route.query.id as string | undefined;
        if (qid) {
            selected.value = jobs.value.find(j => j.id === qid) ?? null;
        }
    } catch (e) {
        error.value = String(e);
    } finally {
        loading.value = false;
    }
}

onMounted(() => {
    ws.on('worker:job', onWorkerJob);
    ws.on('worker:added', onWorkerLiveEvent);
    ws.on('worker:active', onWorkerLiveEvent);
    ws.on('worker:delayed', onWorkerLiveEvent);

    fetchData();

    watch(connected, val => {
        if (val) fetchData();
    });

    if (layoutEl.value) initHeight(layoutEl.value);
});

onUnmounted(() => {
    ws.off('worker:job', onWorkerJob);
    ws.off('worker:added', onWorkerLiveEvent);
    ws.off('worker:active', onWorkerLiveEvent);
    ws.off('worker:delayed', onWorkerLiveEvent);
});
</script>

<style scoped>
.workers-layout {
    display: flex;
    flex-direction: column;
    height: 100vh;
}

.workers-list {
    flex: 1;
    overflow-y: auto;
    min-height: 0;
    padding: 24px;
}

.workers-list.has-detail {
    flex: 1;
}

.queue-summary {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-bottom: 16px;
}

.queue-chip {
    display: flex;
    align-items: center;
    gap: 8px;
    background: #161b22;
    border: 1px solid #21262d;
    border-radius: 6px;
    padding: 6px 12px;
    font-size: 13px;
}

.queue-chip-name {
    font-weight: 600;
    color: #f0f6fc;
}

.queue-chip-stat {
    color: #8b949e;
    font-size: 12px;
}

.queue-chip-stat strong {
    color: #e1e4e8;
}

.clickable-row {
    cursor: pointer;
    border-left: 2px solid transparent;
}

.clickable-row:hover {
    background: #1c2128;
}

.selected-row {
    background: #1c2128 !important;
    border-left-color: #58a6ff;
}

.resize-handle {
    flex-shrink: 0;
    height: 4px;
    background: #30363d;
    cursor: row-resize;
}

.resize-handle:hover {
    background: #58a6ff;
}

.detail-panel {
    flex-shrink: 0;
    min-height: 150px;
    background: #161b22;
    display: flex;
    flex-direction: column;
}

.detail-panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 16px;
    border-bottom: 1px solid #21262d;
    background: #1c2128;
    flex-shrink: 0;
}

.detail-panel-title {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
}

.header-sep {
    width: 1px;
    height: 14px;
    background: #30363d;
    flex-shrink: 0;
}

.detail-close {
    background: none;
    border: none;
    color: #8b949e;
    font-size: 20px;
    cursor: pointer;
    padding: 0 4px;
    line-height: 1;
}

.detail-close:hover {
    color: #e1e4e8;
}

.detail-panel-body {
    flex: 1;
    overflow: hidden;
}

.detail-split {
    display: flex;
    height: 100%;
}

.detail-pane {
    flex: 1;
    min-width: 0;
    overflow-y: auto;
    padding: 12px;
}

.detail-pane + .detail-pane {
    border-left: 1px solid #21262d;
}

.detail-pane pre {
    margin: 0;
}

.subsection-title {
    font-size: 11px;
    font-weight: 600;
    color: #8b949e;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin: 12px 0 4px;
}

.subsection-title:first-of-type {
    margin-top: 0;
}

.timestamps-table {
    font-size: 13px;
}

.timestamps-table td {
    padding: 4px 12px 4px 0;
    border: none;
}

.timestamps-table tr:hover {
    background: none;
}
</style>
