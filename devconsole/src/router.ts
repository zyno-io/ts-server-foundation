import { createRouter, createWebHashHistory } from 'vue-router';

import DashboardView from './views/DashboardView.vue';
import DatabaseLogView from './views/DatabaseLogView.vue';
import DatabaseView from './views/DatabaseView.vue';
import EnvView from './views/EnvView.vue';
import HealthView from './views/HealthView.vue';
import MutexView from './views/MutexView.vue';
import OpenApiView from './views/OpenApiView.vue';
import ReplView from './views/ReplView.vue';
import RequestsView from './views/RequestsView.vue';
import RoutesView from './views/RoutesView.vue';
import SrpcView from './views/SrpcView.vue';
import WorkersView from './views/WorkersView.vue';

export const router = createRouter({
    history: createWebHashHistory(),
    routes: [
        { path: '/', component: DashboardView },
        { path: '/database', component: DatabaseView },
        { path: '/database-log', component: DatabaseLogView },
        { path: '/env', component: EnvView },
        { path: '/health', component: HealthView },
        { path: '/mutex', component: MutexView },
        { path: '/openapi', component: OpenApiView },
        { path: '/repl', component: ReplView },
        { path: '/requests', component: RequestsView },
        { path: '/srpc', component: SrpcView },
        { path: '/routes', component: RoutesView },
        { path: '/workers', component: WorkersView }
    ]
});
