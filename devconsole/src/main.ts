import { createApp } from 'vue';

import { api } from './api';
import App from './App.vue';
import { router } from './router';
import { ws } from './ws';

createApp(App).use(router).mount('#app');
ws.connect();

api.overview().then(data => {
    document.title = `DevConsole: ${data.name}`;
});
