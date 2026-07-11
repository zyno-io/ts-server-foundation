export class UniqueConstraintError extends Error {
    constructor(
        message = 'Unique constraint violation',
        readonly cause?: unknown
    ) {
        super(message);
        this.name = 'UniqueConstraintError';
    }
}

export function isUniqueConstraintError(error: unknown): boolean {
    if (error instanceof UniqueConstraintError) return true;
    if (typeof error !== 'object' || error === null) return false;
    const candidate = error as { code?: unknown; errno?: unknown; name?: unknown };
    return (
        candidate.name === 'UniqueConstraintFailure' || candidate.code === 'ER_DUP_ENTRY' || candidate.code === '23505' || candidate.errno === 1062
    );
}

export function normalizeDatabaseError(error: unknown): unknown {
    if (isUniqueConstraintError(error)) {
        const message = error instanceof Error && error.message ? error.message : 'Unique constraint violation';
        return new UniqueConstraintError(message, error);
    }
    return error;
}
