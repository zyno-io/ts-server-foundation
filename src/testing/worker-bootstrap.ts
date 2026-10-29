import { Env } from '../env';
import { initializeTestNamespace } from './namespace';

// Node preloads this module in both the test coordinator and each worker. Only
// workers choose a namespace; helper processes inherit it from their owning test.
if (Env.NODE_TEST_CONTEXT) initializeTestNamespace();
