<template>
    <div class="srpc-layout" ref="layoutEl" data-resize-container>
        <div class="srpc-top" :class="{ 'has-detail': !!selectedConn }">
            <div class="page-header">
                <h1 class="page-title">SRPC Connections</h1>
                <div class="header-actions">
                    <input v-model="messageFilter" type="text" class="filter-input" placeholder="Filter messages..." />
                    <button class="btn btn-danger" @click="clearAll">Clear</button>
                </div>
            </div>
            <div v-if="loading" class="loading">Loading...</div>
            <div v-else-if="error" class="error">{{ error }}</div>
            <template v-else-if="data">
                <div class="card">
                    <table>
                        <thead>
                            <tr>
                                <th>Client ID</th>
                                <th>Address</th>
                                <th>App Version</th>
                                <th>Connected</th>
                                <th>Messages</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr
                                v-for="conn in data.active"
                                :key="conn.streamId"
                                class="clickable-row"
                                :class="{ 'selected-row': selectedConn?.streamId === conn.streamId }"
                                @click="selectConnection(conn)"
                            >
                                <td class="mono">{{ conn.clientId }}</td>
                                <td class="mono">{{ conn.address }}</td>
                                <td>{{ conn.appVersion }}</td>
                                <td class="text-muted">{{ formatTime(conn.connectedAt) }}</td>
                                <td class="mono">{{ conn.messageCount }}</td>
                            </tr>
                            <tr v-if="data.active.length === 0">
                                <td colspan="5" class="text-muted" style="text-align: center">No active connections</td>
                            </tr>
                        </tbody>
                    </table>
                </div>

                <h2 class="section-title">Recent Disconnections ({{ data.recentDisconnections.length }})</h2>
                <div class="card">
                    <table>
                        <thead>
                            <tr>
                                <th>Client ID</th>
                                <th>Disconnected</th>
                                <th>Cause</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr v-for="d in data.recentDisconnections" :key="d.streamId">
                                <td class="mono">{{ d.clientId }}</td>
                                <td class="text-muted">{{ formatTime(d.disconnectedAt) }}</td>
                                <td>
                                    <span class="badge badge-yellow">{{ d.cause }}</span>
                                </td>
                            </tr>
                            <tr v-if="data.recentDisconnections.length === 0">
                                <td colspan="3" class="text-muted" style="text-align: center">No recent disconnections</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </template>
        </div>

        <div v-if="selectedConn" class="resize-handle" @mousedown="startResize"></div>
        <div v-if="selectedConn" class="detail-panel" :style="{ height: panelHeight + 'px' }">
            <div class="detail-panel-header">
                <span class="detail-panel-title">
                    <span class="mono">{{ selectedConn.clientId }}</span>
                    <span class="text-muted">&mdash;</span>
                    <span class="mono text-muted">{{ selectedConn.address }}</span>
                </span>
                <button class="detail-close" @click="closeDetail">&times;</button>
            </div>
            <div class="detail-panel-body">
                <div class="messages-and-detail">
                    <div class="messages-list">
                        <table>
                            <thead>
                                <tr>
                                    <th>Time</th>
                                    <th>Dir</th>
                                    <th>Type</th>
                                    <th>Reply</th>
                                    <th>Error</th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr
                                    v-for="msg in streamMessages"
                                    :key="msg.id + msg.timestamp"
                                    class="clickable-row"
                                    :class="{ 'selected-row': selectedMsg === msg }"
                                    @click="selectMessage(msg)"
                                >
                                    <td class="mono text-muted">{{ formatTime(msg.timestamp) }}</td>
                                    <td>
                                        <span :class="msg.direction === 'inbound' ? 'badge badge-blue' : 'badge badge-green'">
                                            {{ msg.direction === 'inbound' ? 'IN' : 'OUT' }}
                                        </span>
                                    </td>
                                    <td class="mono">{{ msg.messageType }}</td>
                                    <td>
                                        <span v-if="msg.isReply" class="badge badge-gray">reply</span>
                                    </td>
                                    <td>
                                        <span v-if="msg.error" class="badge badge-red">{{ msg.error }}</span>
                                    </td>
                                </tr>
                                <tr v-if="streamMessages.length === 0">
                                    <td colspan="5" class="text-muted" style="text-align: center">No messages</td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                    <div v-if="selectedMsg" class="message-detail">
                        <div class="detail-split">
                            <div class="detail-pane">
                                <h3 class="pane-title">Request</h3>
                                <template v-if="requestMsg">
                                    <div class="msg-meta">
                                        <span :class="requestMsg.direction === 'inbound' ? 'badge badge-blue' : 'badge badge-green'">
                                            {{ requestMsg.direction === 'inbound' ? 'IN' : 'OUT' }}
                                        </span>
                                        <span class="mono">{{ requestMsg.messageType }}</span>
                                        <span class="mono text-muted">{{ formatTimeFull(requestMsg.timestamp) }}</span>
                                    </div>
                                    <pre><code>{{ formatJson(requestMsg.data) }}</code></pre>
                                </template>
                                <span v-else class="text-muted">(no request found)</span>
                            </div>
                            <div class="detail-pane">
                                <h3 class="pane-title">Response</h3>
                                <template v-if="replyMsg">
                                    <div class="msg-meta">
                                        <span :class="replyMsg.direction === 'inbound' ? 'badge badge-blue' : 'badge badge-green'">
                                            {{ replyMsg.direction === 'inbound' ? 'IN' : 'OUT' }}
                                        </span>
                                        <span class="mono">{{ replyMsg.messageType }}</span>
                                        <span class="mono text-muted">{{ formatTimeFull(replyMsg.timestamp) }}</span>
                                    </div>
                                    <div v-if="replyMsg.error" class="msg-error">{{ replyMsg.error }}</div>
                                    <pre><code>{{ formatJson(replyMsg.data) }}</code></pre>
                                </template>
                                <span v-else class="text-muted">(no reply)</span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { useRouter, useRoute } from 'vue-router';

import { api, type SrpcData, type SrpcConnection, type SrpcDisconnection, type SrpcMessage } from '../api';
import { useResizePanel } from '../composables/useResizePanel';
import { ws, connected } from '../ws';

const router = useRouter();
const route = useRoute();

const MAX_MESSAGES = 500;
const layoutEl = ref<HTMLElement | null>(null);
const { panelHeight, startResize, initHeight } = useResizePanel('tsf:srpcPanelHeight', 0.5);

const data = ref<SrpcData | null>(null);
const messages = ref<SrpcMessage[]>([]);
const loading = ref(true);
const error = ref('');
const selectedConn = ref<SrpcConnection | null>(null);
const selectedMsg = ref<SrpcMessage | null>(null);

function formatTime(ts: number): string {
    return new Date(ts).toLocaleTimeString('en-GB');
}

function formatTimeFull(ts: number): string {
    return new Date(ts).toLocaleString('en-GB');
}

function formatJson(data: unknown): string {
    try {
        return JSON.stringify(data, null, 2);
    } catch {
        return String(data);
    }
}

const messageFilter = ref('');

const streamMessages = computed(() => {
    if (!selectedConn.value) return [];
    const streamId = selectedConn.value.streamId;
    let msgs = messages.value.filter(m => m.streamId === streamId);
    if (messageFilter.value) {
        const q = messageFilter.value.toLowerCase();
        msgs = msgs.filter(m => m.messageType.toLowerCase().includes(q));
    }
    return msgs;
});

const requestMsg = computed(() => {
    if (!selectedMsg.value) return null;
    if (!selectedMsg.value.isReply) return selectedMsg.value;
    // Selected message is a reply, find the original request with the same id
    return messages.value.find(m => m.id === selectedMsg.value!.id && !m.isReply && m.streamId === selectedMsg.value!.streamId) ?? null;
});

const replyMsg = computed(() => {
    if (!selectedMsg.value) return null;
    if (selectedMsg.value.isReply) return selectedMsg.value;
    // Selected message is a request, find its reply
    return messages.value.find(m => m.id === selectedMsg.value!.id && m.isReply && m.streamId === selectedMsg.value!.streamId) ?? null;
});

function updateQuery() {
    const query: Record<string, string> = {};
    if (selectedConn.value) query.conn = selectedConn.value.streamId;
    if (selectedMsg.value) query.msg = selectedMsg.value.id + ':' + selectedMsg.value.timestamp;
    router.replace({ query });
}

function selectConnection(conn: SrpcConnection) {
    if (selectedConn.value?.streamId === conn.streamId) {
        closeDetail();
    } else {
        selectedConn.value = conn;
        selectedMsg.value = null;
        updateQuery();
    }
}

function selectMessage(msg: SrpcMessage) {
    selectedMsg.value = selectedMsg.value === msg ? null : msg;
    updateQuery();
}

function closeDetail() {
    selectedConn.value = null;
    selectedMsg.value = null;
    updateQuery();
}

async function clearAll() {
    await api.clearSrpcMessages();
    messages.value = [];
    if (data.value) {
        data.value.recentDisconnections = [];
    }
    selectedMsg.value = null;
}

const onCleared = () => {
    messages.value = [];
    if (data.value) {
        data.value.recentDisconnections = [];
    }
    selectedMsg.value = null;
};

const onConnection = (conn: SrpcConnection) => {
    if (data.value) {
        data.value.active.push(conn);
    }
};

const onDisconnection = (disc: SrpcDisconnection) => {
    if (data.value) {
        data.value.active = data.value.active.filter(c => c.streamId !== disc.streamId);
        data.value.recentDisconnections.unshift(disc);
        if (data.value.recentDisconnections.length > 50) data.value.recentDisconnections.pop();
    }
};

const onNewMessage = (msg: SrpcMessage) => {
    messages.value.unshift(msg);
    if (messages.value.length > MAX_MESSAGES) messages.value.pop();

    // Update message count on the connection
    if (data.value) {
        const conn = data.value.active.find(c => c.streamId === msg.streamId);
        if (conn) conn.messageCount++;
    }
};

async function fetchData() {
    try {
        const [srpcData, srpcMessages] = await Promise.all([api.srpc(), api.srpcMessages()]);
        data.value = srpcData;
        messages.value = srpcMessages;
        const qconn = route.query.conn as string | undefined;
        if (qconn) {
            selectedConn.value = srpcData.active.find(c => c.streamId === qconn) ?? null;
            const qmsg = route.query.msg as string | undefined;
            if (qmsg && selectedConn.value) {
                const [msgId, msgTs] = qmsg.split(':');
                selectedMsg.value = srpcMessages.find(m => m.id === msgId && String(m.timestamp) === msgTs) ?? null;
            }
        }
    } catch (e) {
        error.value = String(e);
    } finally {
        loading.value = false;
    }
}

onMounted(() => {
    ws.on('srpc:connection', onConnection);
    ws.on('srpc:disconnection', onDisconnection);
    ws.on('srpc:message', onNewMessage);
    ws.on('srpc:cleared', onCleared);

    fetchData();

    watch(connected, val => {
        if (val) fetchData();
    });

    if (layoutEl.value) initHeight(layoutEl.value);
});

onUnmounted(() => {
    ws.off('srpc:connection', onConnection);
    ws.off('srpc:disconnection', onDisconnection);
    ws.off('srpc:message', onNewMessage);
    ws.off('srpc:cleared', onCleared);
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

.srpc-layout {
    display: flex;
    flex-direction: column;
    height: 100vh;
}

.srpc-top {
    flex: 1;
    overflow-y: auto;
    min-height: 0;
    padding: 24px;
}

.section-title {
    font-size: 16px;
    font-weight: 600;
    margin: 16px 0 8px;
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
}

.detail-close {
    background: none;
    border: none;
    color: #8b949e;
    font-size: 20px;
    cursor: pointer;
    padding: 0 4px;
    line-height: 1;
    flex-shrink: 0;
}

.detail-close:hover {
    color: #e1e4e8;
}

.detail-panel-body {
    flex: 1;
    overflow: hidden;
}

.messages-and-detail {
    display: flex;
    height: 100%;
}

.messages-list {
    width: 45%;
    min-width: 300px;
    overflow-y: auto;
    border-right: 1px solid #21262d;
}

.message-detail {
    flex: 1;
    min-width: 0;
    overflow-y: auto;
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
    font-size: 12px;
}

.pane-title {
    font-size: 13px;
    font-weight: 600;
    margin-bottom: 8px;
    color: #e1e4e8;
}

.msg-meta {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    margin-bottom: 8px;
}

.msg-error {
    color: #f85149;
    font-size: 13px;
    margin-bottom: 8px;
}
</style>
