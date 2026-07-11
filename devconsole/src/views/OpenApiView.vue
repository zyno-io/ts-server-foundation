<template>
    <div class="openapi-view">
        <div v-if="loading" class="view-padding loading">Loading OpenAPI schema...</div>
        <div v-else-if="error" class="view-padding error">{{ error }}</div>
        <div v-show="!loading && !error" ref="swaggerEl" class="swagger-container"></div>
    </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';

const swaggerEl = ref<HTMLElement>();
const loading = ref(true);
const error = ref('');

const SWAGGER_VERSION = '5.20.1';
const CDN = `https://unpkg.com/swagger-ui-dist@${SWAGGER_VERSION}`;

function loadCSS(href: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = href;
        link.onload = () => resolve();
        link.onerror = () => reject(new Error(`Failed to load CSS: ${href}`));
        document.head.appendChild(link);
    });
}

function loadScript(src: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error(`Failed to load script: ${src}`));
        document.head.appendChild(script);
    });
}

onMounted(async () => {
    try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (!(window as any).SwaggerUIBundle) {
            await loadCSS(`${CDN}/swagger-ui.css`);
            await loadScript(`${CDN}/swagger-ui-bundle.js`);
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const SwaggerUIBundle = (window as any).SwaggerUIBundle;
        if (!SwaggerUIBundle) {
            throw new Error('SwaggerUIBundle not available');
        }

        SwaggerUIBundle({
            url: '/openapi.json',
            domNode: swaggerEl.value,
            presets: [SwaggerUIBundle.presets.apis],
            layout: 'BaseLayout',
            deepLinking: false,
            defaultModelsExpandDepth: 1,
            docExpansion: 'list',
            filter: true,
            tryItOutEnabled: true
        });

        loading.value = false;
    } catch (e) {
        error.value = String(e);
        loading.value = false;
    }
});
</script>

<style scoped>
.openapi-view {
    height: 100vh;
    overflow-y: auto;
}

.swagger-container {
    padding: 0 24px 24px;
}
</style>

<style>
/* ============================================================
   DevConsole dark theme for Swagger UI
   ============================================================
   Strategy: revert the App.vue global reset so Swagger layout
   works, then nuke ALL backgrounds transparent before layering
   dark backgrounds only where needed. This prevents any light
   theme from bleeding through.
   ============================================================ */

/* ── 1. Undo global `* { margin:0; padding:0 }` reset ─────── */

.swagger-container * {
    margin: revert;
    padding: revert;
    box-sizing: revert;
}

/* ── 2. Nuke every Swagger background to transparent ───────── */

.swagger-container .swagger-ui,
.swagger-container .swagger-ui div,
.swagger-container .swagger-ui section,
.swagger-container .swagger-ui header,
.swagger-container .swagger-ui span,
.swagger-container .swagger-ui small,
.swagger-container .swagger-ui td,
.swagger-container .swagger-ui th,
.swagger-container .swagger-ui tr,
.swagger-container .swagger-ui table,
.swagger-container .swagger-ui ul,
.swagger-container .swagger-ui li,
.swagger-container .swagger-ui p,
.swagger-container .swagger-ui label,
.swagger-container .swagger-ui h1,
.swagger-container .swagger-ui h2,
.swagger-container .swagger-ui h3,
.swagger-container .swagger-ui h4,
.swagger-container .swagger-ui h5,
.swagger-container .swagger-ui hgroup {
    background-color: transparent !important;
    background: transparent !important;
}

/* ── 3. Global typography & colors ─────────────────────────── */

.swagger-container .swagger-ui {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif !important;
    font-size: 14px;
    color: #e1e4e8;
}

.swagger-container .swagger-ui * {
    border-color: #21262d !important;
}

.swagger-container .swagger-ui svg:not(.opblock-summary-method svg) {
    fill: #8b949e;
}

.swagger-container .swagger-ui a {
    color: #58a6ff;
}

.swagger-container .swagger-ui .wrapper {
    padding: 0;
    max-width: none;
}

/* ── Info header ───────────────────────────────────────────── */

.swagger-container .swagger-ui .info {
    margin: 20px 0 12px;
}

.swagger-container .swagger-ui .info .title {
    color: #f0f6fc;
    font-size: 20px;
    font-weight: 600;
}

/* version + OAS badges */
.swagger-container .swagger-ui .info .title small {
    background: #21262d !important;
    color: #8b949e !important;
    border: none !important;
    font-size: 11px;
    padding: 2px 8px !important;
    border-radius: 12px;
    font-weight: 600;
    vertical-align: middle;
    top: 0;
    position: relative;
}

.swagger-container .swagger-ui .info .title small pre {
    color: #8b949e;
    padding: 0 !important;
    font-family: inherit;
    font-size: inherit;
    border: none !important;
}

.swagger-container .swagger-ui .info .base-url {
    color: #484f58;
    font-size: 12px;
}

.swagger-container .swagger-ui .info p,
.swagger-container .swagger-ui .info li,
.swagger-container .swagger-ui .info table td,
.swagger-container .swagger-ui .info table th,
.swagger-container .swagger-ui .info h1,
.swagger-container .swagger-ui .info h2,
.swagger-container .swagger-ui .info h3,
.swagger-container .swagger-ui .info h4 {
    color: #8b949e;
}

.swagger-container .swagger-ui .info a {
    color: #58a6ff;
}

/* ── Scheme / server selector ──────────────────────────────── */

.swagger-container .swagger-ui .scheme-container {
    box-shadow: none;
    padding: 12px 0;
}

.swagger-container .swagger-ui .scheme-container label {
    color: #8b949e;
    font-size: 12px;
}

/* ── Filter bar ────────────────────────────────────────────── */

.swagger-container .swagger-ui .filter-container {
    margin: 0;
    padding: 12px 0;
}

.swagger-container .swagger-ui .filter-container .operation-filter-input {
    background: #161b22 !important;
    border: 1px solid #30363d !important;
    color: #e1e4e8;
    border-radius: 6px;
    padding: 8px 12px;
    font-size: 13px;
}

/* ── Tag sections ──────────────────────────────────────────── */

.swagger-container .swagger-ui .opblock-tag {
    color: #e1e4e8;
    font-size: 16px;
    font-weight: 600;
    padding: 12px 0;
}

.swagger-container .swagger-ui .opblock-tag small {
    color: #484f58;
    font-size: 12px;
}

.swagger-container .swagger-ui .opblock-tag a {
    color: inherit;
}

.swagger-container .swagger-ui .opblock-tag svg {
    fill: #484f58;
}

/* ── Operation blocks ──────────────────────────────────────── */

.swagger-container .swagger-ui .opblock {
    margin: 0 0 4px;
    border-radius: 6px;
    border: 1px solid !important;
    box-shadow: none;
}

.swagger-container .swagger-ui .opblock .opblock-summary {
    padding: 8px 12px;
}

/* method badge — pill style matching DevConsole badges */
.swagger-container .swagger-ui .opblock .opblock-summary-method {
    font-size: 11px !important;
    font-weight: 700;
    padding: 3px 0 !important;
    min-width: 62px;
    border-radius: 12px !important;
    text-align: center;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}

.swagger-container .swagger-ui .opblock .opblock-summary-path,
.swagger-container .swagger-ui .opblock .opblock-summary-path span,
.swagger-container .swagger-ui .opblock .opblock-summary-path a {
    color: #e1e4e8 !important;
    font-family: 'SF Mono', SFMono-Regular, Consolas, 'Liberation Mono', Menlo, monospace;
    font-size: 13px;
}

.swagger-container .swagger-ui .opblock .opblock-summary-description {
    color: #484f58;
    font-size: 13px;
}

.swagger-container .swagger-ui .opblock .opblock-summary-control svg {
    fill: #484f58;
}

/* GET */
.swagger-container .swagger-ui .opblock.opblock-get {
    background: rgba(13, 45, 74, 0.2) !important;
    border-color: rgba(88, 166, 255, 0.15) !important;
}
.swagger-container .swagger-ui .opblock.opblock-get .opblock-summary-method {
    background: #0d2d4a !important;
    color: #58a6ff !important;
}

/* POST */
.swagger-container .swagger-ui .opblock.opblock-post {
    background: rgba(13, 68, 41, 0.2) !important;
    border-color: rgba(63, 185, 80, 0.15) !important;
}
.swagger-container .swagger-ui .opblock.opblock-post .opblock-summary-method {
    background: #0d4429 !important;
    color: #3fb950 !important;
}

/* PUT */
.swagger-container .swagger-ui .opblock.opblock-put {
    background: rgba(74, 59, 13, 0.2) !important;
    border-color: rgba(210, 153, 34, 0.15) !important;
}
.swagger-container .swagger-ui .opblock.opblock-put .opblock-summary-method {
    background: #4a3b0d !important;
    color: #d29922 !important;
}

/* DELETE */
.swagger-container .swagger-ui .opblock.opblock-delete {
    background: rgba(73, 13, 13, 0.2) !important;
    border-color: rgba(248, 81, 73, 0.15) !important;
}
.swagger-container .swagger-ui .opblock.opblock-delete .opblock-summary-method {
    background: #490d0d !important;
    color: #f85149 !important;
}

/* PATCH */
.swagger-container .swagger-ui .opblock.opblock-patch {
    background: rgba(45, 26, 78, 0.2) !important;
    border-color: rgba(163, 113, 247, 0.15) !important;
}
.swagger-container .swagger-ui .opblock.opblock-patch .opblock-summary-method {
    background: #2d1a4e !important;
    color: #a371f7 !important;
}

/* OPTIONS / HEAD */
.swagger-container .swagger-ui .opblock.opblock-options,
.swagger-container .swagger-ui .opblock.opblock-head {
    background: rgba(33, 38, 45, 0.2) !important;
    border-color: #21262d !important;
}
.swagger-container .swagger-ui .opblock.opblock-options .opblock-summary-method,
.swagger-container .swagger-ui .opblock.opblock-head .opblock-summary-method {
    background: #21262d !important;
    color: #8b949e !important;
}

/* deprecated */
.swagger-container .swagger-ui .opblock.opblock-deprecated {
    opacity: 0.6;
    background: rgba(33, 38, 45, 0.2) !important;
    border-color: #21262d !important;
}
.swagger-container .swagger-ui .opblock.opblock-deprecated .opblock-summary-method {
    background: #21262d !important;
    color: #8b949e !important;
}

/* ── Expanded operation body ───────────────────────────────── */

.swagger-container .swagger-ui .opblock-section-header {
    box-shadow: none;
}

.swagger-container .swagger-ui .opblock-section-header h4 {
    color: #e1e4e8;
    font-size: 13px;
    font-weight: 600;
}

.swagger-container .swagger-ui .opblock-section-header label {
    color: #8b949e;
}

.swagger-container .swagger-ui .opblock-description-wrapper p,
.swagger-container .swagger-ui .opblock-external-docs-wrapper p {
    color: #8b949e;
}

/* ── Code blocks (need explicit dark bg — NOT transparent) ─── */

.swagger-container .swagger-ui pre,
.swagger-container .swagger-ui pre.microlight,
.swagger-container .swagger-ui .highlight-code .microlight,
.swagger-container .swagger-ui .microlight {
    background: #0d1117 !important;
    color: #e1e4e8 !important;
    border: 1px solid #21262d !important;
    border-radius: 6px;
    padding: 12px;
    font-family: 'SF Mono', SFMono-Regular, Consolas, 'Liberation Mono', Menlo, monospace;
    font-size: 12px;
}

/* request URL in live response */
.swagger-container .swagger-ui .request-url pre {
    background: #0d1117 !important;
    color: #e1e4e8 !important;
}

/* ── Parameters ────────────────────────────────────────────── */

.swagger-container .swagger-ui .parameters-col_description p {
    color: #8b949e;
}

.swagger-container .swagger-ui table thead tr td,
.swagger-container .swagger-ui table thead tr th {
    color: #8b949e;
}

.swagger-container .swagger-ui .parameter__name {
    color: #e1e4e8;
    font-family: 'SF Mono', SFMono-Regular, Consolas, 'Liberation Mono', Menlo, monospace;
    font-size: 13px;
}

.swagger-container .swagger-ui .parameter__name.required::after {
    color: #f85149;
}

.swagger-container .swagger-ui .parameter__type,
.swagger-container .swagger-ui .parameter__deprecated,
.swagger-container .swagger-ui .parameter__in {
    color: #484f58;
    font-size: 12px;
}

/* ── Form controls (need explicit bg) ──────────────────────── */

.swagger-container .swagger-ui input[type='text'],
.swagger-container .swagger-ui input[type='search'],
.swagger-container .swagger-ui input[type='email'],
.swagger-container .swagger-ui input[type='file'],
.swagger-container .swagger-ui input[type='password'],
.swagger-container .swagger-ui textarea {
    background: #0d1117 !important;
    border: 1px solid #30363d !important;
    color: #e1e4e8 !important;
    border-radius: 6px;
    font-family: 'SF Mono', SFMono-Regular, Consolas, 'Liberation Mono', Menlo, monospace;
    font-size: 13px;
}

.swagger-container .swagger-ui input:focus,
.swagger-container .swagger-ui textarea:focus {
    border-color: #58a6ff !important;
    outline: none;
    box-shadow: 0 0 0 2px rgba(88, 166, 255, 0.2);
}

.swagger-container .swagger-ui select {
    background: #161b22 !important;
    border: 1px solid #30363d !important;
    color: #e1e4e8 !important;
    border-radius: 6px;
    font-size: 13px;
}

/* ── Buttons (need explicit bg) ────────────────────────────── */

.swagger-container .swagger-ui .btn {
    border-radius: 6px;
    font-size: 13px;
    font-weight: 600;
}

.swagger-container .swagger-ui .btn.execute {
    background: #1f6feb !important;
    border-color: #1f6feb !important;
    color: #fff !important;
}

.swagger-container .swagger-ui .btn.cancel {
    background: transparent !important;
    border: 1px solid #f85149 !important;
    color: #f85149 !important;
}

.swagger-container .swagger-ui .btn.authorize {
    border-color: #3fb950 !important;
    color: #3fb950 !important;
}

.swagger-container .swagger-ui .btn.authorize svg {
    fill: #3fb950;
}

.swagger-container .swagger-ui .try-out__btn {
    border-color: #30363d !important;
    color: #8b949e !important;
}

.swagger-container .swagger-ui .try-out__btn:hover {
    color: #e1e4e8 !important;
    border-color: #8b949e !important;
}

/* ── Responses ─────────────────────────────────────────────── */

.swagger-container .swagger-ui .responses-inner h4,
.swagger-container .swagger-ui .responses-inner h5 {
    color: #e1e4e8;
    font-size: 13px;
}

.swagger-container .swagger-ui .response-col_status {
    color: #e1e4e8;
    font-family: 'SF Mono', SFMono-Regular, Consolas, 'Liberation Mono', Menlo, monospace;
    font-size: 13px;
}

.swagger-container .swagger-ui .response-col_description,
.swagger-container .swagger-ui .response-col_description__inner p {
    color: #8b949e;
}

.swagger-container .swagger-ui .response-col_links {
    color: #8b949e;
}

/* ── Tab headers ───────────────────────────────────────────── */

.swagger-container .swagger-ui .tab li {
    color: #484f58;
}

.swagger-container .swagger-ui .tab li:hover {
    color: #8b949e;
}

.swagger-container .swagger-ui .tab li.active {
    color: #e1e4e8;
}

/* ── Models section (needs card bg) ────────────────────────── */

.swagger-container .swagger-ui section.models {
    border: 1px solid #21262d !important;
    border-radius: 8px;
    background: #161b22 !important;
    margin-top: 16px;
}

.swagger-container .swagger-ui section.models h4 {
    color: #e1e4e8;
    font-size: 14px;
    font-weight: 600;
}

.swagger-container .swagger-ui section.models h4 svg {
    fill: #484f58;
}

.swagger-container .swagger-ui section.models .model-container {
    margin: 0;
}

.swagger-container .swagger-ui .model {
    color: #8b949e;
}

.swagger-container .swagger-ui .model-title,
.swagger-container .swagger-ui span.model-title__text {
    color: #e1e4e8;
    font-family: 'SF Mono', SFMono-Regular, Consolas, 'Liberation Mono', Menlo, monospace;
    font-size: 13px;
}

.swagger-container .swagger-ui .model .property {
    color: #e1e4e8;
}

.swagger-container .swagger-ui .model .property.primitive {
    color: #58a6ff;
}

.swagger-container .swagger-ui .model-toggle::after {
    filter: invert(0.6);
}

/* ── Markdown ──────────────────────────────────────────────── */

.swagger-container .swagger-ui .markdown p,
.swagger-container .swagger-ui .markdown li,
.swagger-container .swagger-ui .renderedMarkdown p {
    color: #8b949e;
}

.swagger-container .swagger-ui .markdown code,
.swagger-container .swagger-ui .renderedMarkdown code {
    background: #0d1117 !important;
    color: #e1e4e8;
    border-radius: 4px;
    padding: 2px 6px;
    font-size: 12px;
    font-family: 'SF Mono', SFMono-Regular, Consolas, 'Liberation Mono', Menlo, monospace;
}

/* ── Modal / dialog ────────────────────────────────────────── */

.swagger-container .swagger-ui .dialog-ux .modal-ux {
    background: #161b22 !important;
    border: 1px solid #30363d !important;
    border-radius: 8px;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.4);
}

.swagger-container .swagger-ui .dialog-ux .modal-ux-header h3 {
    color: #e1e4e8;
}

.swagger-container .swagger-ui .dialog-ux .modal-ux-content p,
.swagger-container .swagger-ui .dialog-ux .modal-ux-content label {
    color: #8b949e;
}

.swagger-container .swagger-ui .dialog-ux .modal-ux-content h4 {
    color: #e1e4e8;
}

.swagger-container .swagger-ui .dialog-ux .backdrop-ux {
    background: rgba(0, 0, 0, 0.6) !important;
}

/* ── Copy-to-clipboard ─────────────────────────────────────── */

.swagger-container .swagger-ui .copy-to-clipboard {
    background: #21262d !important;
    border-radius: 6px;
}

/* ── Misc catch-alls ───────────────────────────────────────── */

.swagger-container .swagger-ui .opblock-body p,
.swagger-container .swagger-ui .opblock-body small,
.swagger-container .swagger-ui .opblock-body label {
    color: #8b949e;
}

.swagger-container .swagger-ui .loading-container .loading::after {
    color: #8b949e;
}

.swagger-container .swagger-ui svg.arrow {
    fill: #484f58;
}

/* ── Scrollbar ─────────────────────────────────────────────── */

.openapi-view::-webkit-scrollbar {
    width: 8px;
}

.openapi-view::-webkit-scrollbar-track {
    background: transparent;
}

.openapi-view::-webkit-scrollbar-thumb {
    background: #30363d;
    border-radius: 4px;
}

.openapi-view::-webkit-scrollbar-thumb:hover {
    background: #484f58;
}
</style>
