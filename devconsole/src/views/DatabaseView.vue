<template>
    <div class="db-layout">
        <!-- Sidebar: entity list -->
        <div class="db-sidebar">
            <h2 class="sidebar-title">Entities</h2>
            <div v-if="loadingEntities" class="loading">Loading...</div>
            <div v-else-if="entitiesError" class="error">{{ entitiesError }}</div>
            <ul v-else class="entity-list">
                <li
                    v-for="entity in entities"
                    :key="entity.table"
                    class="entity-item"
                    :class="{ 'entity-active': selectedEntity?.table === entity.table }"
                    @click="selectEntity(entity)"
                >
                    <span class="entity-name">{{ entity.name }}</span>
                    <span class="entity-table mono text-muted">{{ entity.table }}</span>
                </li>
            </ul>
        </div>

        <!-- Main: query editor + results -->
        <div class="db-main">
            <div class="query-bar">
                <textarea
                    ref="queryInput"
                    v-model="sql"
                    class="query-input mono"
                    rows="3"
                    spellcheck="false"
                    @keydown="onQueryKeydown"
                    placeholder="SELECT * FROM ..."
                ></textarea>
                <div class="query-actions">
                    <button class="run-btn" @click="runQuery" :disabled="running">
                        {{ running ? 'Running...' : 'Run' }}
                    </button>
                    <span class="query-hint text-muted">Ctrl+Enter to execute</span>
                </div>
            </div>

            <div v-if="queryError" class="query-error">{{ queryError }}</div>

            <div v-if="result" class="results-area">
                <div class="results-meta text-muted">
                    <span v-if="result.affectedRows != null">{{ result.affectedRows }} row(s) affected</span>
                    <span v-else>{{ result.rowCount }} row(s)</span>
                </div>
                <div class="results-table-wrap">
                    <table v-if="result.columns.length > 0">
                        <thead>
                            <tr>
                                <th v-for="col in result.columns" :key="col">{{ col }}</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr v-for="(row, i) in result.rows" :key="i">
                                <td v-for="col in result.columns" :key="col" class="mono">
                                    {{ formatCell(row[col]) }}
                                </td>
                            </tr>
                            <tr v-if="result.rows.length === 0">
                                <td :colspan="result.columns.length" class="text-muted" style="text-align: center">No rows</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </div>

            <div v-else-if="!queryError" class="empty-state text-muted">Select an entity or write a query</div>
        </div>
    </div>
</template>

<script setup lang="ts">
import { ref, onMounted, nextTick } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { api, type EntityInfo, type QueryResult } from '../api';

const route = useRoute();
const router = useRouter();

const queryInput = ref<HTMLTextAreaElement | null>(null);
const entities = ref<EntityInfo[]>([]);
const loadingEntities = ref(true);
const entitiesError = ref('');
const selectedEntity = ref<EntityInfo | null>(null);
const sql = ref('');
const running = ref(false);
const result = ref<QueryResult | null>(null);
const queryError = ref('');

function selectEntity(entity: EntityInfo) {
    selectedEntity.value = entity;
    sql.value = `SELECT * FROM ${entity.quotedTable} LIMIT 500`;
    result.value = null;
    queryError.value = '';
    router.replace({ query: { table: entity.table } });
    runQuery();
}

async function runQuery() {
    if (!sql.value.trim() || running.value) return;
    running.value = true;
    queryError.value = '';
    result.value = null;

    try {
        const res = await api.databaseQuery(sql.value);
        if (res.error) {
            queryError.value = res.error;
        } else {
            result.value = res;
        }
    } catch (e) {
        queryError.value = String(e);
    } finally {
        running.value = false;
    }
}

function onQueryKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        runQuery();
    }
}

function formatCell(val: unknown): string {
    if (val === null || val === undefined) return 'NULL';
    if (typeof val === 'object') return JSON.stringify(val);
    return String(val);
}

onMounted(async () => {
    try {
        entities.value = await api.databaseEntities();

        // Restore selection from URL
        const tableName = route.query.table as string | undefined;
        if (tableName) {
            const entity = entities.value.find(e => e.table === tableName);
            if (entity) {
                selectedEntity.value = entity;
                sql.value = `SELECT * FROM ${entity.quotedTable} LIMIT 500`;
                await nextTick();
                runQuery();
            }
        }
    } catch (e) {
        entitiesError.value = String(e);
    } finally {
        loadingEntities.value = false;
    }
});
</script>

<style scoped>
.db-layout {
    display: flex;
    height: 100vh;
}

.db-sidebar {
    width: 220px;
    flex-shrink: 0;
    border-right: 1px solid #21262d;
    overflow-y: auto;
    background: #0f1117;
}

.sidebar-title {
    font-size: 14px;
    font-weight: 600;
    color: #8b949e;
    padding: 16px 12px 8px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
}

.entity-list {
    list-style: none;
    padding: 0 4px;
}

.entity-item {
    display: flex;
    flex-direction: column;
    padding: 6px 10px;
    border-radius: 6px;
    cursor: pointer;
    margin-bottom: 1px;
}

.entity-item:hover {
    background: #21262d;
}

.entity-active {
    background: #1f6feb33 !important;
}

.entity-name {
    font-size: 13px;
    color: #e1e4e8;
    font-weight: 500;
}

.entity-table {
    font-size: 11px;
}

.db-main {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    overflow: hidden;
}

.query-bar {
    padding: 12px 16px;
    border-bottom: 1px solid #21262d;
    background: #161b22;
    flex-shrink: 0;
}

.query-input {
    width: 100%;
    background: #0d1117;
    border: 1px solid #30363d;
    border-radius: 6px;
    color: #e1e4e8;
    padding: 8px 10px;
    font-size: 13px;
    resize: vertical;
    outline: none;
}

.query-input:focus {
    border-color: #58a6ff;
}

.query-actions {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 8px;
}

.run-btn {
    background: #238636;
    color: #fff;
    border: none;
    border-radius: 6px;
    padding: 6px 16px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
}

.run-btn:hover:not(:disabled) {
    background: #2ea043;
}

.run-btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
}

.query-hint {
    font-size: 12px;
}

.query-error {
    padding: 12px 16px;
    background: #3d1114;
    color: #f85149;
    font-size: 13px;
    font-family: 'SF Mono', SFMono-Regular, Consolas, 'Liberation Mono', Menlo, monospace;
    white-space: pre-wrap;
    word-break: break-word;
}

.results-area {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: hidden;
}

.results-meta {
    padding: 6px 16px;
    font-size: 12px;
    border-bottom: 1px solid #21262d;
    flex-shrink: 0;
}

.results-table-wrap {
    flex: 1;
    overflow: auto;
}

.results-table-wrap table {
    min-width: 100%;
}

.results-table-wrap th {
    text-transform: none;
}

.results-table-wrap td {
    font-size: 13px;
    white-space: pre-wrap;
    word-break: break-word;
    max-width: 400px;
    vertical-align: top;
}

.empty-state {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 14px;
}
</style>
