import { http, rawResponse, type RawResponseResult } from '../http';
import { serializeOpenApiSchema, serializeOpenApiYaml } from './serializer';
import type { OpenApiSerializableApp } from './types';

@http.controller()
export class OpenApiController {
    constructor(private readonly app: OpenApiSerializableApp) {}

    @http.GET('/openapi.json')
    getOpenApiJson(): RawResponseResult {
        const schema = serializeOpenApiSchema(this.app);
        return rawResponse(JSON.stringify(schema, undefined, 2), {
            contentType: 'application/json; charset=utf-8'
        });
    }

    @http.GET('/openapi.yaml')
    getOpenApiYaml(): RawResponseResult {
        return rawResponse(serializeOpenApiYaml(this.app), {
            contentType: 'application/yaml; charset=utf-8'
        });
    }
}
