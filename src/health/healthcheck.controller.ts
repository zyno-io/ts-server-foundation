import { http } from '../http/decorators';
import { getPackageVersion } from '../helpers/io/package';
import { HealthcheckService } from './healthcheck.service';

@http.controller('/healthz')
export class HealthcheckController {
    constructor(private readonly healthcheckService: HealthcheckService) {}

    @http.GET()
    async index(): Promise<{ version: string }> {
        await this.healthcheckService.check();
        return { version: getPackageVersion() ?? 'unknown' };
    }
}
