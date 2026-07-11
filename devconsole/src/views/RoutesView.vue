<template>
    <div class="view-padding">
        <h1 class="page-title">Routes</h1>
        <div v-if="loading" class="loading">Loading...</div>
        <div v-else-if="error" class="error">{{ error }}</div>
        <div v-else class="card">
            <table>
                <thead>
                    <tr>
                        <th class="sortable" @click="toggleSort('methods')">
                            Methods
                            <span class="sort-indicator">{{ sortIndicator('methods') }}</span>
                        </th>
                        <th class="sortable" @click="toggleSort('path')">
                            Path
                            <span class="sort-indicator">{{ sortIndicator('path') }}</span>
                        </th>
                        <th class="sortable" @click="toggleSort('controller')">
                            Controller
                            <span class="sort-indicator">{{ sortIndicator('controller') }}</span>
                        </th>
                        <th class="sortable" @click="toggleSort('methodName')">
                            Method
                            <span class="sort-indicator">{{ sortIndicator('methodName') }}</span>
                        </th>
                    </tr>
                </thead>
                <tbody>
                    <tr v-for="(route, i) in sortedData" :key="i">
                        <td>
                            <span v-for="method in route.methods" :key="method" class="badge badge-blue" style="margin-right: 4px">
                                {{ method }}
                            </span>
                        </td>
                        <td class="mono">{{ route.path }}</td>
                        <td class="mono text-muted">{{ route.controller ?? '-' }}</td>
                        <td class="mono text-muted">{{ route.methodName ?? '-' }}</td>
                    </tr>
                </tbody>
            </table>
        </div>
    </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';

import { api, type RouteInfo } from '../api';

type SortKey = keyof RouteInfo;
type SortDir = 'asc' | 'desc';

const data = ref<RouteInfo[]>([]);
const loading = ref(true);
const error = ref('');
const sortKey = ref<SortKey>('controller');
const sortDir = ref<SortDir>('asc');

function toggleSort(key: SortKey) {
    if (sortKey.value === key) {
        sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc';
    } else {
        sortKey.value = key;
        sortDir.value = 'asc';
    }
}

function sortIndicator(key: SortKey): string {
    if (sortKey.value !== key) return '';
    return sortDir.value === 'asc' ? ' ▲' : ' ▼';
}

const sortedData = computed(() => {
    const key = sortKey.value;
    const dir = sortDir.value === 'asc' ? 1 : -1;
    return [...data.value].sort((a, b) => {
        const aVal = key === 'methods' ? (a.methods ?? []).join(',') : (a[key] ?? '');
        const bVal = key === 'methods' ? (b.methods ?? []).join(',') : (b[key] ?? '');
        return aVal < bVal ? -dir : aVal > bVal ? dir : 0;
    });
});

onMounted(async () => {
    try {
        data.value = await api.routes();
    } catch (e) {
        error.value = String(e);
    } finally {
        loading.value = false;
    }
});
</script>

<style scoped>
.sortable {
    cursor: pointer;
    user-select: none;
}

.sortable:hover {
    text-decoration: underline;
}

.sort-indicator {
    font-size: 0.75em;
}
</style>
