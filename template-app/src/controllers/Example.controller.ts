import { ApiResponse, http, HttpBody } from '@zyno-io/ts-server-foundation';

import { ExampleEntity } from '../entities/Example.entity';
import { ExampleService } from '../services/Example.service';

@http.controller('/examples')
export class ExampleController {
    constructor(private readonly examples: ExampleService) {}

    @http.GET()
    list() {
        return this.examples.findAll();
    }

    @http.POST()
    async create(body: HttpBody<{ name: string }>): ApiResponse<ExampleEntity, 201> {
        return this.examples.create(body.name);
    }
}
