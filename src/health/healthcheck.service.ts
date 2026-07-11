export type HealthcheckFn = () => Promise<void> | void;

export interface HealthcheckResult {
    name: string;
    status: 'ok' | 'error';
    error?: string;
}

export class HealthcheckService {
    private readonly checks: { name: string; fn: HealthcheckFn }[] = [];

    register(name: string, fn: HealthcheckFn): void {
        this.checks.push({ name, fn });
    }

    async check(): Promise<void> {
        for (const check of this.checks) await check.fn();
    }

    async checkIndividual(): Promise<HealthcheckResult[]> {
        const results: HealthcheckResult[] = [];
        for (const check of this.checks) {
            try {
                await check.fn();
                results.push({ name: check.name, status: 'ok' });
            } catch (error) {
                results.push({
                    name: check.name,
                    status: 'error',
                    error: error instanceof Error ? error.message : String(error)
                });
            }
        }
        return results;
    }
}
