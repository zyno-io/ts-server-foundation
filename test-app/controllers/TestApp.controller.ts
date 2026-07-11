import { readFileSync } from 'node:fs';

import { ApiResponse, createAuthMiddleware, FileUpload, http, HttpBody, HttpPath, HttpQuery, HttpRequest, ParsedJwt, ScopedLogger } from '../../src';
import { TestAppUser } from '../entities/TestAppUser.entity';
import { TestAppUserService } from '../services/TestAppUser.service';
import type { CreatedUserSummary } from '../services/TestAppUser.service';

interface CreateUserBody {
    name: string;
}

interface TestAppJwtPayload extends Record<string, unknown> {
    role?: string;
}

interface CreateUserResponse extends CreatedUserSummary {
    requestedBy: string;
    remoteAddress: string;
}

export const TestAppUserAuthMiddleware = createAuthMiddleware(TestAppUser);

export class ValidatingTestAppUserAuthMiddleware extends TestAppUserAuthMiddleware {
    validateEntity(_request: HttpRequest, _entity: TestAppUser): void {}
}

@http.controller('/test-app')
export class TestAppController {
    constructor(
        private readonly users: TestAppUserService,
        private readonly logger: ScopedLogger
    ) {}

    @http.GET('/status')
    status(source: HttpQuery<string>, request: HttpRequest) {
        return {
            ok: true,
            source,
            featureName: this.users.featureName,
            serviceLoggerScope: this.users.loggerScope,
            controllerLoggerScope: this.logger.scope,
            remoteAddress: request.getRemoteAddress()
        };
    }

    @http.POST('/users')
    async create(body: HttpBody<CreateUserBody>, jwt: ParsedJwt<TestAppJwtPayload>, request: HttpRequest): ApiResponse<CreateUserResponse, 201> {
        const created = await this.users.createUser(body.name, jwt.payload.role ?? 'guest');
        return {
            ...created,
            requestedBy: jwt.subject,
            remoteAddress: request.getRemoteAddress()
        };
    }

    @http.GET('/users/:id')
    async get(id: HttpPath<number>) {
        return this.users.getUser(id);
    }

    @(http.GET('/me').use(ValidatingTestAppUserAuthMiddleware))
    async me(jwt: ParsedJwt<TestAppJwtPayload>) {
        return {
            jwtSubject: jwt.subject,
            user: await this.users.getUser(Number(jwt.subject))
        };
    }

    @http.POST('/upload')
    upload(body: HttpBody<{ description: string; file: FileUpload }>) {
        return {
            description: body.description,
            file: {
                originalName: body.file.originalName,
                type: body.file.type,
                size: body.file.size,
                contents: readFileSync(body.file.path, 'utf8')
            }
        };
    }
}
