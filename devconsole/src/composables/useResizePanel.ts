import { ref, onUnmounted } from 'vue';

export function useResizePanel(storageKey: string, defaultHeight = 0.45, minHeight = 150) {
    const stored = localStorage.getItem(storageKey);
    const panelHeight = ref(stored ? Number(stored) : 0);

    let dragging = false;
    let containerEl: HTMLElement | null = null;

    function startResize(e: MouseEvent) {
        e.preventDefault();
        dragging = true;
        containerEl = (e.target as HTMLElement).closest('[data-resize-container]') as HTMLElement;
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', stopResize);
        document.body.style.cursor = 'row-resize';
        document.body.style.userSelect = 'none';
    }

    function onMouseMove(e: MouseEvent) {
        if (!dragging || !containerEl) return;
        const containerRect = containerEl.getBoundingClientRect();
        const newHeight = containerRect.bottom - e.clientY;
        panelHeight.value = Math.max(minHeight, Math.min(newHeight, containerRect.height - minHeight));
    }

    function stopResize() {
        dragging = false;
        containerEl = null;
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', stopResize);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        localStorage.setItem(storageKey, String(panelHeight.value));
    }

    function initHeight(container: HTMLElement) {
        if (!panelHeight.value) {
            panelHeight.value = container.getBoundingClientRect().height * defaultHeight;
        }
    }

    onUnmounted(() => {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', stopResize);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
    });

    return { panelHeight, startResize, initHeight };
}
