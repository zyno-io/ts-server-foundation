<template>
    <div class="view-padding">
        <h1 class="page-title">Environment</h1>
        <div v-if="loading" class="loading">Loading...</div>
        <div v-else-if="error" class="error">{{ error }}</div>
        <div v-else class="card">
            <table>
                <thead>
                    <tr>
                        <th>Key</th>
                        <th>Value</th>
                    </tr>
                </thead>
                <tbody>
                    <tr v-for="[key, value] in entries" :key="key">
                        <td class="mono">{{ key }}</td>
                        <td :class="{ mono: true, 'text-muted': value === '****' }">{{ value ?? '(null)' }}</td>
                    </tr>
                </tbody>
            </table>
        </div>
    </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';

import { api } from '../api';

const data = ref<Record<string, unknown> | null>(null);
const loading = ref(true);
const error = ref('');

const entries = computed(() => {
    if (!data.value) return [];
    return Object.entries(data.value).sort(([a], [b]) => a.localeCompare(b));
});

onMounted(async () => {
    try {
        data.value = await api.env();
    } catch (e) {
        error.value = String(e);
    } finally {
        loading.value = false;
    }
});
</script>
