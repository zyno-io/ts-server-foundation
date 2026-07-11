import { ref, watch } from 'vue';

import { connected } from '../ws';

let startTime: number | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

export const uptimeSeconds = ref<number | null>(null);

export function formatUptime(s: number): string {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${Math.floor(s % 60)}s`;
    return `${Math.floor(s)}s`;
}

function tick() {
    if (startTime !== null) {
        uptimeSeconds.value = (Date.now() - startTime) / 1000;
    }
}

function startTicker() {
    if (!timer) timer = setInterval(tick, 1000);
}

function stopTicker() {
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
}

export function setUptimeFromMs(ms: number) {
    startTime = Date.now() - ms;
    tick();
}

export function setUptimeFromSeconds(s: number) {
    startTime = Date.now() - s * 1000;
    tick();
}

watch(connected, val => {
    if (val) {
        startTicker();
    } else {
        stopTicker();
    }
});

startTicker();
