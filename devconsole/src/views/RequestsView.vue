<template>
    <div class="requests-layout" ref="layoutEl" data-resize-container>
        <div class="requests-list" :class="{ 'has-detail': !!selected }">
            <div class="page-header">
                <h1 class="page-title">HTTP Requests</h1>
                <div class="header-actions">
                    <input v-model="searchFilter" type="text" class="filter-input" placeholder="Filter URLs..." />
                    <button class="btn btn-danger" @click="clearAll">Clear</button>
                </div>
            </div>
            <div v-if="loading" class="loading">Loading...</div>
            <div v-else-if="error" class="error">{{ error }}</div>
            <div v-else class="card">
                <table>
                    <thead>
                        <tr>
                            <th>Time</th>
                            <th>Method</th>
                            <th>URL</th>
                            <th>Status</th>
                            <th>Duration</th>
                            <th>Remote IP</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr
                            v-for="entry in filteredData"
                            :key="entry.id"
                            class="clickable-row"
                            :class="{ 'selected-row': selected?.id === entry.id }"
                            @click="selectEntry(entry)"
                        >
                            <td class="mono text-muted">{{ formatTime(entry.timestamp) }}</td>
                            <td>
                                <span class="badge badge-blue">{{ entry.method }}</span>
                            </td>
                            <td class="mono">{{ entry.url }}</td>
                            <td>
                                <span :class="statusBadge(entry.statusCode)">{{ entry.statusCode }}</span>
                            </td>
                            <td class="mono text-muted">{{ entry.durationMs }}ms</td>
                            <td class="mono text-muted">{{ entry.remoteAddress }}</td>
                        </tr>
                        <tr v-if="filteredData.length === 0">
                            <td colspan="6" class="text-muted" style="text-align: center">No requests captured yet</td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </div>

        <div v-if="selected" class="resize-handle" @mousedown="startResize"></div>
        <div v-if="selected" class="detail-panel" :style="{ height: panelHeight + 'px' }">
            <div class="detail-panel-header">
                <span class="detail-panel-title">
                    <span class="badge badge-blue">{{ selected.method }}</span>
                    <span class="mono">{{ selected.url }}</span>
                    <span class="header-sep"></span>
                    <span :class="statusBadge(selected.statusCode)">{{ selected.statusCode }}</span>
                    <span class="mono text-muted">{{ selected.durationMs }}ms</span>
                    <span class="header-sep"></span>
                    <span class="mono text-muted">{{ selected.remoteAddress }}</span>
                    <span class="header-sep"></span>
                    <span class="mono text-muted">{{ new Date(selected.timestamp).toLocaleString('en-GB') }}</span>
                </span>
                <div class="detail-controls">
                    <label class="pretty-toggle">
                        <input type="checkbox" v-model="prettyJson" />
                        <span>Pretty</span>
                    </label>
                    <button class="detail-close" @click="closeDetail">&times;</button>
                </div>
            </div>
            <div class="detail-panel-body">
                <div class="detail-split">
                    <div class="detail-pane">
                        <h4 class="subsection-title">Request Headers</h4>
                        <JsonViewer :data="selected.requestHeaders" />
                        <h4 class="subsection-title">Request Body</h4>
                        <pre v-if="selected.requestBody"><code>{{ formatBody(selected.requestBody) }}</code></pre>
                        <span v-else class="text-muted">(empty)</span>
                    </div>
                    <div class="detail-pane">
                        <h4 class="subsection-title">Response Headers</h4>
                        <JsonViewer :data="selected.responseHeaders" />
                        <h4 class="subsection-title">Response Body</h4>
                        <pre v-if="selected.responseBody"><code>{{ formatBody(selected.responseBody) }}</code></pre>
                        <span v-else class="text-muted">(empty)</span>
                        <template v-if="selected.error">
                            <h4 class="subsection-title">Exception</h4>
                            <pre
                                class="detail-error"
                            ><code>{{ selected.error.stack ?? `${selected.error.name}: ${selected.error.message}` }}</code></pre>
                            <div v-if="errorDetails(selected.error)" class="error-details">
                                <JsonViewer :data="errorDetails(selected.error)!" />
                            </div>
                            <template v-if="selected.error.cause">
                                <h4 class="subsection-title">Caused By</h4>
                                <pre
                                    class="detail-error"
                                ><code>{{ selected.error.cause.stack ?? `${selected.error.cause.name}: ${selected.error.cause.message}` }}</code></pre>
                                <div v-if="errorDetails(selected.error.cause)" class="error-details">
                                    <JsonViewer :data="errorDetails(selected.error.cause)!" />
                                </div>
                            </template>
                        </template>
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { useRouter, useRoute } from 'vue-router';

import { api, type HttpEntry, type ErrorInfo } from '../api';
import JsonViewer from '../components/JsonViewer.vue';
import { useResizePanel } from '../composables/useResizePanel';
import { ws, connected } from '../ws';

const router = useRouter();
const route = useRoute();

const MAX_ENTRIES = 500;
const layoutEl = ref<HTMLElement | null>(null);
const { panelHeight, startResize, initHeight } = useResizePanel('tsf:requestsPanelHeight');
const data = ref<HttpEntry[] | null>(null);
const loading = ref(true);
const error = ref('');
const selected = ref<HttpEntry | null>(null);
const prettyJson = ref(localStorage.getItem('tsf:prettyJson') !== 'false');
const searchFilter = ref('');

const filteredData = computed(() => {
    if (!data.value) return [];
    if (!searchFilter.value) return data.value;
    const q = searchFilter.value.toLowerCase();
    return data.value.filter(e => e.url.toLowerCase().includes(q));
});

watch(prettyJson, v => localStorage.setItem('tsf:prettyJson', String(v)));

function formatTime(ts: number): string {
    return new Date(ts).toLocaleTimeString('en-GB');
}

function statusBadge(code: number): string {
    if (code >= 500) return 'badge badge-red';
    if (code >= 400) return 'badge badge-yellow';
    if (code >= 300) return 'badge badge-gray';
    return 'badge badge-green';
}

function formatBody(body: string): string {
    if (!prettyJson.value) return body;
    try {
        return JSON.stringify(JSON.parse(body), null, 2);
    } catch {
        return body;
    }
}

const ERROR_SKIP_KEYS = new Set(['name', 'message', 'stack', 'cause']);
function errorDetails(err: ErrorInfo): Record<string, unknown> | null {
    const details: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(err)) {
        if (!ERROR_SKIP_KEYS.has(key)) details[key] = value;
    }
    return Object.keys(details).length > 0 ? details : null;
}

function selectEntry(entry: HttpEntry) {
    const next = selected.value?.id === entry.id ? null : entry;
    selected.value = next;
    router.replace({ query: next ? { id: next.id } : {} });
}

function closeDetail() {
    selected.value = null;
    router.replace({ query: {} });
}

async function clearAll() {
    await api.clearRequests();
    data.value = [];
    selected.value = null;
}

const onCleared = () => {
    data.value = [];
    selected.value = null;
};

const onNewEntry = (entry: HttpEntry) => {
    if (data.value) {
        data.value.unshift(entry);
        if (data.value.length > MAX_ENTRIES) data.value.pop();
    }
};

async function fetchData() {
    try {
        data.value = await api.requests();
        const qid = route.query.id as string | undefined;
        if (qid && data.value) {
            selected.value = data.value.find(e => e.id === qid) ?? null;
        }
    } catch (e) {
        error.value = String(e);
    } finally {
        loading.value = false;
    }
}

onMounted(() => {
    ws.on('http:entry', onNewEntry);
    ws.on('http:cleared', onCleared);

    fetchData();

    watch(connected, val => {
        if (val) fetchData();
    });

    if (layoutEl.value) initHeight(layoutEl.value);
});

onUnmounted(() => {
    ws.off('http:entry', onNewEntry);
    ws.off('http:cleared', onCleared);
});
</script>

<style scoped>
.page-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 16px;
}

.page-header .page-title {
    margin-bottom: 0;
}

.header-actions {
    display: flex;
    align-items: center;
    gap: 8px;
}

.filter-input {
    background: #0d1117;
    color: #c9d1d9;
    border: 1px solid #30363d;
    border-radius: 6px;
    padding: 6px 12px;
    font-size: 13px;
    width: 220px;
}

.filter-input::placeholder {
    color: #484f58;
}

.filter-input:focus {
    outline: none;
    border-color: #58a6ff;
}

.btn {
    background: #21262d;
    color: #c9d1d9;
    border: 1px solid #30363d;
    border-radius: 6px;
    padding: 6px 16px;
    font-size: 13px;
    cursor: pointer;
}

.btn:hover {
    background: #30363d;
    border-color: #8b949e;
}

.btn-danger {
    color: #f85149;
    border-color: #f8514966;
}

.btn-danger:hover {
    background: #da36332a;
    border-color: #f85149;
}

.requests-layout {
    display: flex;
    flex-direction: column;
    height: 100vh;
}

.requests-list {
    flex: 1;
    overflow-y: auto;
    min-height: 0;
    padding: 24px;
}

.requests-list.has-detail {
    flex: 1;
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

.detail-controls {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-shrink: 0;
}

.pretty-toggle {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
    color: #8b949e;
    cursor: pointer;
    user-select: none;
}

.pretty-toggle input {
    cursor: pointer;
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

.detail-error {
    color: #f85149;
    font-size: 12px;
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
}

.error-details {
    margin-top: 4px;
    font-size: 12px;
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
</style>
