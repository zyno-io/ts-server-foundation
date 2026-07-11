<template>
    <div class="view-padding">
        <div class="page-header">
            <h1 class="page-title">Health Checks</h1>
            <button class="btn" @click="runChecks" :disabled="loading">
                {{ loading ? 'Running...' : 'Run Checks' }}
            </button>
        </div>
        <div v-if="loading && !data.length" class="loading">Loading...</div>
        <div v-else-if="error" class="error">{{ error }}</div>
        <div v-else-if="data.length === 0" class="card text-muted" style="text-align: center; padding: 24px">No health checks registered</div>
        <div v-else class="card">
            <table>
                <thead>
                    <tr>
                        <th>Check</th>
                        <th>Status</th>
                        <th>Error</th>
                    </tr>
                </thead>
                <tbody>
                    <tr v-for="(check, i) in data" :key="i">
                        <td class="mono">{{ check.name }}</td>
                        <td>
                            <span :class="check.status === 'ok' ? 'badge badge-green' : 'badge badge-red'">
                                {{ check.status === 'ok' ? 'OK' : 'Error' }}
                            </span>
                        </td>
                        <td class="mono text-muted">{{ check.error ?? '-' }}</td>
                    </tr>
                </tbody>
            </table>
        </div>
    </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';

import { api, type HealthCheckResult } from '../api';

const data = ref<HealthCheckResult[]>([]);
const loading = ref(true);
const error = ref('');

async function runChecks() {
    loading.value = true;
    error.value = '';
    try {
        data.value = await api.healthChecks();
    } catch (e) {
        error.value = String(e);
    } finally {
        loading.value = false;
    }
}

onMounted(() => runChecks());
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

.btn {
    background: #21262d;
    color: #c9d1d9;
    border: 1px solid #30363d;
    border-radius: 6px;
    padding: 6px 16px;
    font-size: 13px;
    cursor: pointer;
}

.btn:hover:not(:disabled) {
    background: #30363d;
    border-color: #8b949e;
}

.btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}
</style>
