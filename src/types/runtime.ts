import { uuid7 } from '../helpers/utils/uuid';
export { getClassName, isClass } from '@zyno-io/ts-reflection';

export function uuid(): string {
    return uuid7();
}
