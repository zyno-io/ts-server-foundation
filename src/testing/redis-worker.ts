import { randomUUID } from 'node:crypto';

import { Env } from '../env';

// Node preloads this module in both the test coordinator and each worker. Only
// workers choose a namespace; helper processes inherit it from their owning test.
if (Env.NODE_TEST_CONTEXT) Env.TSF_TEST_REDIS_NAMESPACE ??= randomUUID();
