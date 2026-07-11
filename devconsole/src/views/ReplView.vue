<template>
    <div class="repl-layout">
        <div class="repl-output" ref="outputEl">
            <div v-for="(entry, i) in history" :key="i" class="repl-entry">
                <div class="repl-input-line">
                    <span class="repl-prompt">&gt;</span>
                    <pre class="repl-code mono">{{ entry.code }}</pre>
                </div>
                <pre v-if="entry.output" class="repl-result mono">{{ entry.output }}</pre>
                <pre v-if="entry.error" class="repl-error mono">{{ entry.error }}</pre>
            </div>
            <div v-if="running" class="repl-running text-muted">Evaluating...</div>
        </div>
        <div class="repl-input-bar">
            <span class="repl-prompt">&gt;</span>
            <div class="repl-input-wrap" ref="inputWrap">
                <textarea
                    ref="inputEl"
                    v-model="code"
                    class="repl-input mono"
                    rows="1"
                    spellcheck="false"
                    placeholder="Enter JavaScript... ($ = classes, $$ = instances)"
                    @keydown="onKeydown"
                    @input="autoResize"
                ></textarea>
                <div v-if="completions.length > 0" class="ac-popup" ref="acPopup">
                    <div
                        v-for="(item, i) in completions"
                        :key="item.label"
                        class="ac-item"
                        :class="{ 'ac-selected': i === acIndex }"
                        @mousedown.prevent="acceptCompletion(i)"
                    >
                        <span class="ac-kind" :class="'ac-kind-' + item.kind">{{ kindIcon(item.kind) }}</span>
                        <span class="ac-label mono">{{ item.label }}</span>
                    </div>
                </div>
            </div>
            <button class="run-btn" @click="run" :disabled="running || !code.trim()">Run</button>
        </div>
    </div>
</template>

<script setup lang="ts">
import { ref, nextTick, onMounted } from 'vue';

import { ws } from '../ws';

interface ReplEntry {
    code: string;
    output: string;
    error?: string;
}

interface CompletionItem {
    label: string;
    kind: string;
}

const outputEl = ref<HTMLElement | null>(null);
const inputEl = ref<HTMLTextAreaElement | null>(null);
const inputWrap = ref<HTMLElement | null>(null);
const acPopup = ref<HTMLElement | null>(null);
const code = ref('');
const running = ref(false);
const history = ref<ReplEntry[]>([]);
const commandHistory = ref<string[]>([]);
let historyIndex = -1;

// Autocomplete state
const completions = ref<CompletionItem[]>([]);
const acIndex = ref(0);
let acReplaceStart = 0;
let acReplaceEnd = 0;
let acDebounceTimer: ReturnType<typeof setTimeout> | null = null;

function scrollToBottom() {
    nextTick(() => {
        if (outputEl.value) {
            outputEl.value.scrollTop = outputEl.value.scrollHeight;
        }
    });
}

function autoResize() {
    const el = inputEl.value;
    if (el) {
        el.style.height = 'auto';
        el.style.height = Math.min(el.scrollHeight, 200) + 'px';
    }
}

function dismissCompletions() {
    completions.value = [];
    acIndex.value = 0;
    if (acDebounceTimer) {
        clearTimeout(acDebounceTimer);
        acDebounceTimer = null;
    }
}

async function requestCompletions() {
    const el = inputEl.value;
    if (!el) return;

    const cursorPos = el.selectionStart ?? code.value.length;
    try {
        const reply = await ws.invoke('uReplComplete', { code: code.value, cursorPos });
        // oxlint-disable-next-line typescript/no-explicit-any
        const response = (reply as any).uReplCompleteResponse;
        if (!response) return;

        const items: CompletionItem[] = response.items ?? [];
        if (items.length === 0) {
            dismissCompletions();
            return;
        }

        completions.value = items;
        acIndex.value = 0;
        acReplaceStart = response.replaceStart ?? cursorPos;
        acReplaceEnd = response.replaceEnd ?? cursorPos;
    } catch {
        dismissCompletions();
    }
}

function triggerCompletionDebounced() {
    if (acDebounceTimer) clearTimeout(acDebounceTimer);
    acDebounceTimer = setTimeout(() => {
        acDebounceTimer = null;
        requestCompletions();
    }, 100);
}

function acceptCompletion(index: number) {
    const item = completions.value[index];
    if (!item) return;

    const before = code.value.slice(0, acReplaceStart);
    const after = code.value.slice(acReplaceEnd);
    code.value = before + item.label + after;
    dismissCompletions();

    nextTick(() => {
        const el = inputEl.value;
        if (el) {
            const newPos = acReplaceStart + item.label.length;
            el.selectionStart = newPos;
            el.selectionEnd = newPos;
            el.focus();
            autoResize();
        }
    });
}

function kindIcon(kind: string): string {
    switch (kind) {
        case 'method':
            return 'f';
        case 'accessor':
            return 'a';
        case 'property':
            return 'p';
        case 'global':
            return 'g';
        default:
            return '?';
    }
}

async function run() {
    const src = code.value.trim();
    if (!src || running.value) return;

    dismissCompletions();
    commandHistory.value.push(src);
    historyIndex = -1;
    code.value = '';
    autoResize();
    running.value = true;
    scrollToBottom();

    try {
        const reply = await ws.invoke('uReplEval', { code: src });
        // oxlint-disable-next-line typescript/no-explicit-any
        const response = (reply as any).uReplEvalResponse ?? {};
        history.value.push({
            code: src,
            output: response.output ?? '',
            error: response.error
        });
    } catch (err) {
        history.value.push({
            code: src,
            output: '',
            error: err instanceof Error ? err.message : String(err)
        });
    } finally {
        running.value = false;
        scrollToBottom();
        nextTick(() => inputEl.value?.focus());
    }
}

function onKeydown(e: KeyboardEvent) {
    // Autocomplete navigation
    if (completions.value.length > 0) {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            acIndex.value = (acIndex.value + 1) % completions.value.length;
            scrollAcItemIntoView();
            return;
        }
        if (e.key === 'ArrowUp') {
            e.preventDefault();
            acIndex.value = (acIndex.value - 1 + completions.value.length) % completions.value.length;
            scrollAcItemIntoView();
            return;
        }
        if (e.key === 'PageDown') {
            e.preventDefault();
            acIndex.value = Math.min(acIndex.value + 10, completions.value.length - 1);
            scrollAcItemIntoView();
            return;
        }
        if (e.key === 'PageUp') {
            e.preventDefault();
            acIndex.value = Math.max(acIndex.value - 10, 0);
            scrollAcItemIntoView();
            return;
        }
        if (e.key === 'Tab' || e.key === 'Enter') {
            if (e.key === 'Enter' && e.shiftKey) {
                dismissCompletions();
                return;
            }
            e.preventDefault();
            acceptCompletion(acIndex.value);
            return;
        }
        if (e.key === 'Escape') {
            e.preventDefault();
            dismissCompletions();
            return;
        }
    }

    // Tab triggers completion when popup is not shown
    if (e.key === 'Tab') {
        e.preventDefault();
        requestCompletions();
        return;
    }

    // Execute on Enter (without shift)
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        run();
        return;
    }

    // Command history with arrow keys (only when no multiline and no completions)
    if (e.key === 'ArrowUp' && !code.value.includes('\n')) {
        if (commandHistory.value.length > 0) {
            if (historyIndex === -1) {
                historyIndex = commandHistory.value.length - 1;
            } else if (historyIndex > 0) {
                historyIndex--;
            }
            code.value = commandHistory.value[historyIndex];
            dismissCompletions();
            nextTick(autoResize);
        }
        return;
    }
    if (e.key === 'ArrowDown' && !code.value.includes('\n')) {
        if (historyIndex >= 0) {
            historyIndex++;
            if (historyIndex >= commandHistory.value.length) {
                historyIndex = -1;
                code.value = '';
            } else {
                code.value = commandHistory.value[historyIndex];
            }
            dismissCompletions();
            nextTick(autoResize);
        }
        return;
    }

    // Trigger completions on typing after a dot
    if (e.key === '.') {
        nextTick(triggerCompletionDebounced);
        return;
    }

    // Re-trigger completions on alphanumeric/underscore/$ keys while typing
    if (/^[a-zA-Z0-9_$]$/.test(e.key)) {
        nextTick(triggerCompletionDebounced);
        return;
    }

    // Backspace — re-trigger or dismiss
    if (e.key === 'Backspace') {
        nextTick(() => {
            if (completions.value.length > 0) {
                triggerCompletionDebounced();
            }
        });
        return;
    }

    // Any other key dismisses completions
    if (completions.value.length > 0 && e.key !== 'Shift' && e.key !== 'Control' && e.key !== 'Alt' && e.key !== 'Meta') {
        dismissCompletions();
    }
}

function scrollAcItemIntoView() {
    nextTick(() => {
        const popup = acPopup.value;
        if (!popup) return;
        const selected = popup.children[acIndex.value] as HTMLElement;
        if (selected) {
            selected.scrollIntoView({ block: 'nearest' });
        }
    });
}

onMounted(() => {
    inputEl.value?.focus();
});
</script>

<style scoped>
.repl-layout {
    display: flex;
    flex-direction: column;
    height: 100vh;
}

.repl-output {
    flex: 1;
    overflow-y: auto;
    padding: 16px;
}

.repl-entry {
    margin-bottom: 12px;
}

.repl-input-line {
    display: flex;
    gap: 8px;
    align-items: flex-start;
}

.repl-prompt {
    color: #58a6ff;
    font-weight: 700;
    font-family: 'SF Mono', SFMono-Regular, Consolas, 'Liberation Mono', Menlo, monospace;
    font-size: 13px;
    flex-shrink: 0;
    line-height: 1.5;
    user-select: none;
}

.repl-code {
    color: #e1e4e8;
    font-size: 13px;
    margin: 0;
    background: none;
    border: none;
    padding: 0;
    white-space: pre-wrap;
    word-break: break-word;
}

.repl-result {
    color: #8b949e;
    font-size: 13px;
    margin: 2px 0 0 18px;
    background: none;
    border: none;
    padding: 0;
    white-space: pre-wrap;
    word-break: break-word;
}

.repl-error {
    color: #f85149;
    font-size: 13px;
    margin: 2px 0 0 18px;
    background: none;
    border: none;
    padding: 0;
    white-space: pre-wrap;
    word-break: break-word;
}

.repl-running {
    margin-left: 18px;
    font-size: 13px;
}

.repl-input-bar {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 12px 16px;
    border-top: 1px solid #21262d;
    background: #161b22;
    flex-shrink: 0;
}

.repl-input-wrap {
    flex: 1;
    position: relative;
}

.repl-input {
    width: 100%;
    background: #0d1117;
    border: 1px solid #30363d;
    border-radius: 6px;
    color: #e1e4e8;
    padding: 6px 10px;
    font-size: 13px;
    resize: none;
    outline: none;
    line-height: 1.5;
    overflow: hidden;
}

.repl-input:focus {
    border-color: #58a6ff;
}

.run-btn {
    background: #238636;
    color: #fff;
    border: none;
    border-radius: 6px;
    padding: 6px 14px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    flex-shrink: 0;
    align-self: flex-end;
}

.run-btn:hover:not(:disabled) {
    background: #2ea043;
}

.run-btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
}

/* Autocomplete popup */
.ac-popup {
    position: absolute;
    bottom: 100%;
    left: 0;
    margin-bottom: 4px;
    background: #1c2128;
    border: 1px solid #30363d;
    border-radius: 6px;
    max-height: 240px;
    overflow-y: auto;
    min-width: 220px;
    max-width: 400px;
    z-index: 100;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
}

.ac-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 10px;
    cursor: pointer;
    font-size: 13px;
}

.ac-item:hover {
    background: #21262d;
}

.ac-selected {
    background: #1f6feb44 !important;
}

.ac-kind {
    width: 18px;
    height: 18px;
    border-radius: 3px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 11px;
    font-weight: 700;
    flex-shrink: 0;
}

.ac-kind-method {
    background: #3d2d6b;
    color: #b392f0;
}

.ac-kind-property {
    background: #0d3d5e;
    color: #79c0ff;
}

.ac-kind-accessor {
    background: #3d3d0d;
    color: #d2a822;
}

.ac-kind-global {
    background: #1a3d1a;
    color: #7ee787;
}

.ac-label {
    color: #e1e4e8;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
</style>
