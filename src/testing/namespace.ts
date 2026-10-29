import { randomUUID } from 'node:crypto';

import { Env } from '../env';

export function initializeTestNamespace(): string {
    return (Env.TSF_TEST_NAMESPACE ??= randomUUID().replaceAll('-', ''));
}
