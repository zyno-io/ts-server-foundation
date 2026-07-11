<template>
    <div class="json-viewer">
        <button v-if="collapsible" class="toggle" @click="expanded = !expanded">
            {{ expanded ? 'Collapse' : 'Expand' }}
        </button>
        <pre v-if="!collapsible || expanded"><code>{{ formatted }}</code></pre>
    </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';

const props = defineProps<{
    data: unknown;
    collapsible?: boolean;
}>();

const expanded = ref(!props.collapsible);

const formatted = computed(() => {
    try {
        return JSON.stringify(props.data, null, 2);
    } catch {
        return String(props.data);
    }
});
</script>

<style scoped>
.json-viewer {
    position: relative;
}

.toggle {
    background: #21262d;
    border: 1px solid #30363d;
    color: #8b949e;
    border-radius: 4px;
    padding: 4px 8px;
    font-size: 12px;
    cursor: pointer;
    margin-bottom: 8px;
}

.toggle:hover {
    color: #e1e4e8;
}
</style>
