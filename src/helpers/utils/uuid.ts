import { randomUUID } from 'node:crypto';
import { V7Generator, uuidv7 } from 'uuidv7';

export const uuid4 = randomUUID;
export const uuid7 = uuidv7;

const v7Generator = new V7Generator();

export function uuid7FromDate(date: Date): string {
    return v7Generator.generateOrResetCore(date.getTime(), 10_000).toString();
}
