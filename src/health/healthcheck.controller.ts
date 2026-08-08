import { http } from '../http/decorators';
import { getPackageVersion } from '../helpers/io/package';
import { HealthcheckService } from './healthcheck.service';

@http.controller()
export class HealthcheckController {
    constructor(private readonly healthcheckService: HealthcheckService) {}

    @http.GET('/healthz')
    async index(): Promise<{ version: string }> {
        await this.healthcheckService.check();
        return { version: getPackageVersion() ?? 'unknown' };
    }

    @http.GET('/readyz')
    async ready(): Promise<{ ok: true }> {
        await this.healthcheckService.checkReady();
        return { ok: true };
    }

    @http.GET('/livez')
    async live(): Promise<{ ok: true }> {
        await this.healthcheckService.checkLiveness();
        return { ok: true };
    }
}
