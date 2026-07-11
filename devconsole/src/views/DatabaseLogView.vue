<template>
    <div class="dblog-layout" ref="layoutEl" data-resize-container>
        <div class="dblog-list" :class="{ 'has-detail': !!selected }">
            <div class="page-header">
                <h1 class="page-title">Database Log</h1>
                <div class="header-actions">
                    <input v-model="searchFilter" type="text" class="filter-input" placeholder="Filter SQL..." />
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
                            <th>SQL</th>
                            <th>Params</th>
                            <th>Duration</th>
                            <th>Status</th>
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
                            <td class="mono sql-cell">{{ truncateSql(entry.sql) }}</td>
                            <td class="mono text-muted">{{ entry.params.length || '' }}</td>
                            <td class="mono text-muted">
                                {{ entry.durationMs != null ? entry.durationMs + 'ms' : '' }}
                            </td>
                            <td>
                                <span v-if="entry.status === 'running'" class="badge badge-yellow">running</span>
                                <span v-else-if="entry.status === 'error'" class="badge badge-red">error</span>
                                <span v-else class="badge badge-green">ok</span>
                            </td>
                        </tr>
                        <tr v-if="filteredData.length === 0">
                            <td colspan="5" class="text-muted" style="text-align: center">No queries captured yet</td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </div>

        <div v-if="selected" class="resize-handle" @mousedown="startResize"></div>
        <div v-if="selected" class="detail-panel" :style="{ height: panelHeight + 'px' }">
            <div class="detail-panel-header">
                <span class="detail-panel-title">
                    <span class="mono text-muted">{{ formatTimeFull(selected.timestamp) }}</span>
                    <span class="header-sep"></span>
                    <span class="mono text-muted">{{ selected.durationMs != null ? selected.durationMs + 'ms' : '...' }}</span>
                    <span class="header-sep"></span>
                    <span v-if="selected.status === 'running'" class="badge badge-yellow">running</span>
                    <span v-else-if="selected.status === 'error'" class="badge badge-red">error</span>
                    <span v-else class="badge badge-green">ok</span>
                </span>
                <button class="detail-close" @click="closeDetail">&times;</button>
            </div>
            <div class="detail-panel-body">
                <div class="detail-content">
                    <h4 class="subsection-title">Composite SQL</h4>
                    <pre><code>{{ compositeSql }}</code></pre>
                    <h4 class="subsection-title">Prepared SQL</h4>
                    <pre><code>{{ selected.sql }}</code></pre>
                    <template v-if="selected.params.length > 0">
                        <h4 class="subsection-title">Bindings</h4>
                        <pre><code>{{ formatJson(selected.params) }}</code></pre>
                    </template>
                    <template v-if="selected.error">
                        <h4 class="subsection-title">Error</h4>
                        <pre class="detail-error"><code>{{ selected.error }}</code></pre>
                    </template>
                </div>
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { useRouter, useRoute } from 'vue-router';

import { api, type DatabaseQueryEntry } from '../api';
import { useResizePanel } from '../composables/useResizePanel';
import { ws, connected } from '../ws';

const router = useRouter();
const route = useRoute();

const MAX_ENTRIES = 500;
const layoutEl = ref<HTMLElement | null>(null);
const { panelHeight, startResize, initHeight } = useResizePanel('tsf:dblogPanelHeight');
const data = ref<DatabaseQueryEntry[] | null>(null);
const loading = ref(true);
const error = ref('');
const selected = ref<DatabaseQueryEntry | null>(null);
const searchFilter = ref('');

const filteredData = computed(() => {
    if (!data.value) return [];
    if (!searchFilter.value) return data.value;
    const q = searchFilter.value.toLowerCase();
    return data.value.filter(e => e.sql.toLowerCase().includes(q));
});

function formatTime(ts: number): string {
    return new Date(ts).toLocaleTimeString('en-GB');
}

function formatTimeFull(ts: number): string {
    return new Date(ts).toLocaleString('en-GB');
}

function truncateSql(sql: string): string {
    return sql.length > 120 ? sql.slice(0, 120) + '...' : sql;
}

function formatDateUtc(d: Date): string {
    const y = d.getUTCFullYear();
    const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dy = String(d.getUTCDate()).padStart(2, '0');
    const h = String(d.getUTCHours()).padStart(2, '0');
    const mi = String(d.getUTCMinutes()).padStart(2, '0');
    const s = String(d.getUTCSeconds()).padStart(2, '0');
    return `'${y}-${mo}-${dy} ${h}:${mi}:${s}'`;
}

function escapeSqlString(s: string): string {
    // eslint-disable-next-line no-control-regex
    return "'" + s.replace(/\\/g, '\\\\').replace(/'/g, "''").replace(/\x00/g, '\\0') + "'";
}

function formatParam(val: unknown): string {
    if (val === null || val === undefined) return 'NULL';
    if (typeof val === 'boolean') return val ? 'TRUE' : 'FALSE';
    if (typeof val === 'number') return String(val);
    if (typeof val === 'string') {
        // ISO date string (from Date serialization over JSON)
        if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(val)) {
            const d = new Date(val);
            if (!isNaN(d.getTime())) return formatDateUtc(d);
        }
        return escapeSqlString(val);
    }
    if (val instanceof Date || (typeof val === 'object' && val !== null && Object.prototype.toString.call(val) === '[object Date]')) {
        return formatDateUtc(val as Date);
    }
    // Objects/arrays → JSON string
    if (typeof val === 'object') {
        try {
            return escapeSqlString(JSON.stringify(val));
        } catch {
            // fall through
        }
    }
    return escapeSqlString(String(val));
}

const compositeSql = computed(() => {
    if (!selected.value) return '';
    const { sql, params } = selected.value;
    if (!params.length) return sql;
    let i = 0;
    return sql.replace(/\?/g, () => (i < params.length ? formatParam(params[i++]) : '?'));
});

function formatJson(data: unknown): string {
    try {
        return JSON.stringify(data, null, 2);
    } catch {
        return String(data);
    }
}

function selectEntry(entry: DatabaseQueryEntry) {
    const next = selected.value?.id === entry.id ? null : entry;
    selected.value = next;
    router.replace({ query: next ? { id: next.id } : {} });
}

function closeDetail() {
    selected.value = null;
    router.replace({ query: {} });
}

async function clearAll() {
    await api.clearDatabaseQueries();
    data.value = [];
    selected.value = null;
}

const onCleared = () => {
    data.value = [];
    selected.value = null;
};

const onNewQuery = (entry: DatabaseQueryEntry) => {
    if (data.value) {
        data.value.unshift(entry);
        if (data.value.length > MAX_ENTRIES) data.value.pop();
    }
};

const onQueryComplete = (updated: DatabaseQueryEntry) => {
    if (!data.value) return;
    const existing = data.value.find(e => e.id === updated.id);
    if (existing) {
        existing.status = updated.status;
        existing.durationMs = updated.durationMs;
        existing.error = updated.error;
        // Force reactivity update for the selected entry
        if (selected.value?.id === updated.id) {
            selected.value = { ...existing };
            const idx = data.value.indexOf(existing);
            if (idx !== -1) data.value[idx] = selected.value;
        }
    }
};

async function fetchData() {
    try {
        data.value = await api.databaseQueries();
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
    ws.on('db:query', onNewQuery);
    ws.on('db:query:complete', onQueryComplete);
    ws.on('db:cleared', onCleared);

    fetchData();

    watch(connected, val => {
        if (val) fetchData();
    });

    if (layoutEl.value) initHeight(layoutEl.value);
});

onUnmounted(() => {
    ws.off('db:query', onNewQuery);
    ws.off('db:query:complete', onQueryComplete);
    ws.off('db:cleared', onCleared);
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

.dblog-layout {
    display: flex;
    flex-direction: column;
    height: 100vh;
}

.dblog-list {
    flex: 1;
    overflow-y: auto;
    min-height: 0;
    padding: 24px;
}

.dblog-list.has-detail {
    flex: 1;
}

.sql-cell {
    max-width: 500px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
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

.detail-content {
    padding: 12px;
    overflow-y: auto;
    height: 100%;
}

.detail-content pre {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
}

.detail-error {
    color: #f85149;
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
