import { HttpBadRequestError } from '../../http';

export function assertInput(value: unknown, field?: string): asserts value {
    if (value === undefined || value === null || value === '') {
        throw new HttpBadRequestError(field ? `${field} is required` : 'missing parameters');
    }
}

export function isValidEmail(value: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}
