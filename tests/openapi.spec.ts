import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { MaxLength, MinLength, type DatabaseField } from '../src';

import {
    BaseAppConfig,
    DateString,
    deserialize,
    dumpOpenApiSchema,
    EmailAddress,
    EmptyResponse,
    emptyResponse,
    EmptyResponseResult,
    Env,
    FileUpload,
    http,
    ApiName,
    ApiResponse,
    ApiType,
    AnyResponse,
    HttpBody,
    HttpPath,
    HttpQueries,
    HttpQuery,
    HttpRequest,
    type GreaterThan,
    type LessThan,
    jsonResponse,
    JsonResponseResult,
    OkResponse,
    ParsedJwt,
    rawResponse,
    RawResponseResult,
    redirectResponse,
    RedirectResponseResult,
    ReflectionKind,
    serializeOpenApiSchema,
    shouldDumpOpenApiSchema,
    shouldExposeOpenApi,
    TestingHelpers,
    UuidString,
    validate
} from '../src';
import { createApp } from '../src/app';
import type { OpenApiReferenceObject, OpenApiSchemaObject } from '../src/openapi';
import { OpenApiImportedReportSource } from './openapi-imported-utility-fixtures';
import type {
    OpenApiReexportedBindingNode,
    OpenApiReexportedOption,
    OpenApiReexportedSourceConfig,
    OpenApiReexportedStrategy,
    OpenApiReexportedRule,
    OpenApiReexportedStep
} from './openapi-reexported-types-barrel';

class OpenApiUserDto {
    id!: UuidString;
    name!: string;
    active!: boolean;
    status!: 'active' | 'disabled';
    createdAt!: Date;
}

type OpenApiWebhookDeliveryStatus = 'pending' | 'delivering' | 'succeeded';

class OpenApiWebhookDeliveryDto {
    status!: OpenApiWebhookDeliveryStatus & DatabaseField<{ type: 'VARCHAR(16)' }>;
}

class OpenApiCreateUserBody {
    name!: string & MinLength<2> & MaxLength<40>;
    email?: EmailAddress;
    birthday?: DateString;
    score?: number & GreaterThan<0>;
    ratio?: number & LessThan<100>;
    roles!: Array<'admin' | 'user'>;
}

class OpenApiUploadBody {
    caption?: string & MaxLength<120>;
}

class OpenApiNestedUploadBody {
    file!: FileUpload<{ maxSize: '1MB'; allowedTypes: 'image/png' }>;
    caption?: string;
}

class OpenApiNestedUploadPart {
    file!: FileUpload<{ allowedTypes: 'image/png' }>;
}

class OpenApiDeepRequiredUploadBody {
    nested!: OpenApiNestedUploadPart;
}

class OpenApiDeepOptionalUploadBody {
    nested?: OpenApiNestedUploadPart;
}

class OpenApiDraftAttachmentFields {
    title!: string;
    attachment!: FileUpload<{ maxSize: '2MB'; allowedTypes: 'application/pdf' }> | null;
}

type OpenApiDraftAttachmentBody = Partial<OpenApiDraftAttachmentFields>;

class OpenApiNativeClassBody {
    endpoint!: URL;
}

class OpenApiListUsersQuery {
    includePosts?: boolean;
    limit!: number;
}

interface OpenApiInterfaceBody {
    title: string & MinLength<3>;
    count?: number;
    'quoted.name'?: boolean;
    nullableText?: string | null;
    nullableStatus?: 'active' | 'inactive' | null;
    /**
     * Comment with braces should not be parsed as a field: `{ old, new }`.
     */
    payload?: Record<string, unknown> | null;
}

interface OpenApiInterfaceNested {
    enabled: boolean;
}

interface OpenApiInterfaceResponse {
    id: UuidString;
    nested: OpenApiInterfaceNested;
}

interface OpenApiGenericContainer<T> {
    items?: T[];
    alternatives?: T[];
}

type OpenApiGenericVariant = { kind: 'alpha' } | { kind: 'beta'; mode: 'first' | 'second' };

interface OpenApiGenericInterfaceBody {
    selection?: OpenApiGenericContainer<OpenApiGenericVariant>;
}

class OpenApiNamedDto {
    value!: string;
}

type ExplicitOpenApiDto = ApiName<'ExplicitOpenApiDto'> & OpenApiNamedDto;

class OpenApiAliasTarget {
    value!: string;
}

type ExplicitAliasTargetDto = ApiName<'ExplicitAliasTargetDto'> & OpenApiAliasTarget;

class OpenApiPickSource {
    id!: string;
    email!: string;
    name!: string;
}

class OpenApiPickItemSource {
    id!: string;
    relatedId!: string;
    startsAt!: Date;
    skipChecks!: boolean;
}

class OpenApiRuntimeUtilitySource {
    id!: string;
    email!: string;
    name!: string;
}

interface OpenApiIndexedAccessItem {
    option: 'optionA' | 'optionB';
    label: string;
    duration: number | null;
    guaranteed: boolean;
    amount: number;
    margin: number;
    internalCode: string;
}

class OpenApiIndexedAccessSource {
    entries!: OpenApiIndexedAccessItem[];
    groups!: OpenApiIndexedAccessItem[] | null;
    status!: 'pending' | 'complete' | null;
}

class OpenApiChannelSource {
    id!: string;
    kind!: 'primary' | 'secondary' | null;
    customKind!: string | null;
    value!: string;
    suffix!: string | null;
    note!: string | null;
    createdAt!: Date;
}

type OpenApiPickId = Pick<OpenApiPickSource, 'id'>;
type OpenApiPickEmail = Pick<OpenApiPickSource, 'email'>;
interface OpenApiInterfaceExtendsAlias extends OpenApiPickId {
    enabled: boolean;
}
type OpenApiExtendsIntersectionBase = Pick<OpenApiPickSource, 'id' | 'email'> & {
    inheritedFlag: boolean;
    inheritedNullable?: string | null;
};
interface OpenApiInterfaceExtendsIntersectionAlias extends OpenApiExtendsIntersectionBase {
    enabled: boolean;
}
interface OpenApiInterfaceBaseListItem {
    operationId: string;
    submittedByActorId: string;
    createdAtMs: number;
    groups: string[]; // exercising inherited body composition after line comments
}
interface OpenApiInterfaceMetrics {
    totalA: number;
    totalB: number;
}
interface OpenApiInterfaceDetail extends OpenApiInterfaceBaseListItem {
    metrics: OpenApiInterfaceMetrics;
}
interface ITaskListItem {
    operationId: string;
    submittedByActorId: string;
    createdAtMs: number;
    groups: string[]; // exercising inherited body composition after line comments
}
interface ITaskMetrics {
    countA: number;
    count_b: number;
    countC: number;
    countD: number;
    countE: number;
    countF: number;
}
interface ITaskDetail extends ITaskListItem {
    metrics: ITaskMetrics;
}
type OpenApiNestedPickResponse = Pick<OpenApiPickSource, 'id' | 'email'> & {
    items: Array<
        Pick<OpenApiPickItemSource, 'id' | 'relatedId' | 'startsAt' | 'skipChecks'> & {
            itemId: string | null;
            allowOverride: boolean;
        }
    >;
    profile: Pick<OpenApiPickSource, 'id' | 'email' | 'name'> & ApiName<'OpenApiNestedPickProfile'>;
};
type OpenApiIndexedAccessResponse = {
    entries?: OpenApiIndexedAccessSource['entries'];
    group?: Pick<NonNullable<OpenApiIndexedAccessSource['groups']>[number], 'option' | 'label' | 'duration' | 'guaranteed' | 'amount' | 'margin'>;
    status?: NonNullable<OpenApiIndexedAccessSource['status']>;
};
type OpenApiChannelListResponse = Pick<OpenApiPickSource, 'id'> & {
    channels: Pick<OpenApiChannelSource, 'id' | 'kind' | 'customKind' | 'value' | 'suffix' | 'note' | 'createdAt'>[];
};
type OpenApiChannelUpdateInput = Partial<Omit<OpenApiChannelListResponse['channels'][number], 'createdAt'>> & {
    value: string;
};
type OpenApiImportedReportDetailResponse = Pick<
    OpenApiImportedReportSource,
    'id' | 'scopeId' | 'groupId' | 'totalAmount' | 'categoryBreakdown' | 'detailBreakdown' | 'customEntries'
> & {
    sourceBreakdown: Array<{
        label: string | null;
        baseAmount: number;
        extraAmount: number;
    }>;
};
type OpenApiImportedReportSummaryResponse = Omit<OpenApiImportedReportDetailResponse, 'id' | 'scopeId' | 'groupId'>;
type OpenApiReexportedSteps = {
    [key: string]: OpenApiReexportedStep;
};
interface OpenApiReexportedBindingRequest {
    nodes: Record<string, OpenApiReexportedBindingNode>;
}
interface OpenApiReexportedRuleSetCreateRequest {
    name: string;
    strategy?: OpenApiReexportedStrategy;
    zone: string;
    rules?: OpenApiReexportedRule[];
}
interface OpenApiReexportedOptionConfig {
    enabledOptions?: OpenApiReexportedOption[];
}
type OpenApiReexportedOptionConfigUpdate = Partial<OpenApiReexportedOptionConfig>;
type OpenApiReexportedVariantConfig =
    | OpenApiReexportedSourceConfig
    | {
          type: 'reference';
          referenceId: string;
      }
    | {
          type: 'empty';
      };
type OpenApiReexportedVariantConfigUpdateRequest = Extract<OpenApiReexportedVariantConfig, { type: 'alpha' | 'gamma' | 'reference' | 'empty' }>;
interface OpenApiReexportedContainerUpdateRequest {
    selectedConfig?: OpenApiReexportedVariantConfigUpdateRequest | null;
}
type OpenApiSettingKey = 'settingA' | 'settingB' | 'settingC';
type OpenApiChildSettingKey = 'settingA' | 'settingB';
type OpenApiSettingsRequest = Partial<Record<OpenApiSettingKey, string | null>>;
interface OpenApiSettingsUpdateRequest {
    settings?: OpenApiSettingsRequest;
    'settings.children'?: ApiType<'OpenApiChildSettingsRequest', Partial<Record<OpenApiChildSettingKey, string>>>;
}
type OpenApiPartialIntersectionCreateRequest = Pick<OpenApiPickSource, 'name' | 'email'> & {
    steps: OpenApiReexportedSteps;
};
type OpenApiPartialIntersectionUpdateRequest = Partial<OpenApiPartialIntersectionCreateRequest>;
interface OpenApiWrappedNamedQuery {
    valueStart: string;
    valueEnd: string;
    mode?: 'alpha' | 'beta';
    source?: OpenApiWrappedNamedSourceName;
}
type OpenApiWrappedNamedSourceName = 'sourceA' | 'sourceB';
interface OpenApiWrappedNamedBody {
    value: string;
}
interface OpenApiWrappedNamedPromiseResponse {
    id: string;
}
interface OpenApiWrappedNamedApiResponse {
    accepted: boolean;
}

interface OpenApiTaggedUnionResponse {
    value: DateString | UuidString;
}

interface OpenApiRecursiveNode {
    name: string;
    child?: OpenApiRecursiveNode;
}

@http.controller('/users')
class OpenApiUsersController {
    @http.GET()
    async listUsers(_query: HttpQueries<OpenApiListUsersQuery>): Promise<OpenApiUserDto[]> {
        return [];
    }

    /** List users using the documented summary. */
    @http.GET('/summarized')
    async listUsersSummarized(): Promise<OpenApiUserDto[]> {
        return [];
    }

    @http.GET('/webhook-delivery')
    async webhookDelivery(): Promise<OpenApiWebhookDeliveryDto> {
        return new OpenApiWebhookDeliveryDto();
    }

    @http.GET('/optional-queries')
    async listUsersOptional(_query?: HttpQueries<OpenApiListUsersQuery>): Promise<OpenApiUserDto[]> {
        return [];
    }

    @http.GET('/:id')
    async getUser(_id: HttpPath<UuidString>, _includePosts?: HttpQuery<boolean>, _search?: HttpQuery<'q'>): Promise<OpenApiUserDto> {
        return new OpenApiUserDto();
    }

    @http.POST()
    async createUser(_body: HttpBody<OpenApiCreateUserBody>): Promise<OpenApiUserDto> {
        return new OpenApiUserDto();
    }

    @http.POST('/created')
    async createUserCreated(_body: HttpBody<OpenApiCreateUserBody>): ApiResponse<OpenApiUserDto, 201> {
        return new OpenApiUserDto();
    }

    @http.POST('/secure')
    async createSecure(_jwt: ParsedJwt, _body: HttpBody<OpenApiCreateUserBody>): Promise<OpenApiUserDto> {
        return new OpenApiUserDto();
    }

    @http.GET('/optional-auth')
    async optionalAuth(_jwt?: ParsedJwt): Promise<OpenApiUserDto> {
        return new OpenApiUserDto();
    }

    @http.POST('/:id/avatar')
    async uploadAvatar(
        _id: HttpPath<string>,
        _file: FileUpload<{ maxSize: '40MB'; allowedTypes: ['image/jpeg', 'image/png'] }>,
        _body: HttpBody<OpenApiUploadBody>
    ): OkResponse {
        return { ok: true };
    }

    @http.POST('/optional-direct-upload')
    async uploadDirectOptional(_file?: FileUpload): Promise<OpenApiUserDto> {
        return new OpenApiUserDto();
    }

    @http.POST('/nested-upload')
    async uploadNested(_body: HttpBody<OpenApiNestedUploadBody>): Promise<OpenApiUserDto> {
        return new OpenApiUserDto();
    }

    @http.POST('/deep-required-upload')
    async uploadDeepRequired(_body: HttpBody<OpenApiDeepRequiredUploadBody>): Promise<OpenApiUserDto> {
        return new OpenApiUserDto();
    }

    @http.POST('/deep-optional-upload')
    async uploadDeepOptional(_body: HttpBody<OpenApiDeepOptionalUploadBody>): Promise<OpenApiUserDto> {
        return new OpenApiUserDto();
    }

    @http.POST('/optional-upload')
    async uploadOptional(_body: HttpBody<OpenApiDraftAttachmentBody>): Promise<OpenApiUserDto> {
        return new OpenApiUserDto();
    }

    @http.POST('/nullable-body')
    async nullableBody(_body: HttpBody<OpenApiCreateUserBody | null>): Promise<OpenApiUserDto> {
        return new OpenApiUserDto();
    }

    @http.POST('/native-class-body')
    async nativeClassBody(_body: HttpBody<OpenApiNativeClassBody>): OkResponse {
        return { ok: true };
    }

    @http.GET('/nullable')
    async nullableUser(): Promise<OpenApiUserDto | null> {
        return null;
    }

    @http.POST('/setup-id-primary-action')
    async setupIDPrimaryAction(): Promise<OkResponse> {
        return { ok: true };
    }

    @http.POST('/setup-id-secondary-action')
    async setupIDSecondaryAction(): Promise<OkResponse> {
        return { ok: true };
    }

    @http.GET('/named')
    async named(): Promise<ExplicitOpenApiDto> {
        return new OpenApiNamedDto() as ExplicitOpenApiDto;
    }

    @http.GET('/nested-pick')
    async nestedPick(): Promise<OpenApiNestedPickResponse> {
        return {
            id: 'id',
            email: 'test@example.com',
            items: [],
            profile: { id: 'id', email: 'test@example.com', name: 'Test' }
        };
    }

    @http.GET('/indexed-access')
    async indexedAccess(): Promise<OpenApiIndexedAccessResponse> {
        return {};
    }

    @http.POST('/channel-input')
    async channelInput(_body: HttpBody<OpenApiChannelUpdateInput>): Promise<OkResponse> {
        return { ok: true };
    }

    @http.GET('/imported-report-summary')
    async importedReportSummary(): Promise<OpenApiImportedReportSummaryResponse> {
        return {
            totalAmount: 0,
            categoryBreakdown: [],
            detailBreakdown: [],
            customEntries: [],
            sourceBreakdown: []
        };
    }

    @http.POST('/reexported-rule-set')
    async reexportedRuleSet(_body: HttpBody<OpenApiReexportedRuleSetCreateRequest>): Promise<OkResponse> {
        return { ok: true };
    }

    @http.POST('/reexported-steps')
    async reexportedSteps(_body: HttpBody<OpenApiReexportedSteps>): Promise<OkResponse> {
        return { ok: true };
    }

    @http.POST('/reexported-distributed-bindings')
    async reexportedDistributedBindings(_body: HttpBody<OpenApiReexportedBindingRequest>): Promise<OkResponse> {
        return { ok: true };
    }

    @http.POST('/reexported-option-config')
    async reexportedOptionConfig(_body: HttpBody<OpenApiReexportedOptionConfig>): Promise<OkResponse> {
        return { ok: true };
    }

    @http.POST('/reexported-option-config-update')
    async reexportedOptionConfigUpdate(_body: HttpBody<OpenApiReexportedOptionConfigUpdate>): Promise<OkResponse> {
        return { ok: true };
    }

    @http.POST('/reexported-container-update')
    async reexportedContainerUpdate(_body: HttpBody<OpenApiReexportedContainerUpdateRequest>): Promise<OkResponse> {
        return { ok: true };
    }

    @http.POST('/settings-update')
    async settingsUpdate(_body: HttpBody<OpenApiSettingsUpdateRequest>): Promise<OkResponse> {
        return { ok: true };
    }

    @http.POST('/partial-intersection-update')
    async partialIntersectionUpdate(_body: HttpBody<OpenApiPartialIntersectionUpdateRequest>): Promise<OkResponse> {
        return { ok: true };
    }

    @http.GET('/wrapped-named-query')
    async wrappedNamedQuery(query: HttpQueries<OpenApiWrappedNamedQuery>): Promise<OpenApiWrappedNamedPromiseResponse> {
        return { id: query.valueStart };
    }

    @http.POST('/wrapped-named-body')
    async wrappedNamedBody(body: HttpBody<OpenApiWrappedNamedBody>): ApiResponse<OpenApiWrappedNamedApiResponse, 202> {
        return Promise.resolve({ accepted: body.value.length > 0 });
    }

    @http.GET('/tagged-union')
    async taggedUnion(): Promise<OpenApiTaggedUnionResponse> {
        return { value: '2024-01-01' as DateString };
    }

    @http.GET('/interfaces')
    async listInterfaces(): Promise<OpenApiInterfaceResponse[]> {
        return [];
    }

    @http.GET('/interface-extends-alias')
    async interfaceExtendsAlias(): Promise<OpenApiInterfaceExtendsAlias> {
        return { id: '', enabled: true };
    }

    @http.GET('/interface-extends-intersection-alias')
    async interfaceExtendsIntersectionAlias(): Promise<OpenApiInterfaceExtendsIntersectionAlias> {
        return { id: '', email: '', inheritedFlag: true, enabled: true };
    }

    @http.GET('/interface-extends-interface')
    async interfaceExtendsInterface(): Promise<OpenApiInterfaceDetail> {
        return {
            operationId: '',
            submittedByActorId: '',
            createdAtMs: 0,
            groups: [],
            metrics: { totalA: 0, totalB: 0 }
        };
    }

    @http.GET('/i-task-detail')
    async iTaskDetail(): Promise<ITaskDetail> {
        return {
            operationId: '',
            submittedByActorId: '',
            createdAtMs: 0,
            groups: [],
            metrics: {
                countA: 0,
                count_b: 0,
                countC: 0,
                countD: 0,
                countE: 0,
                countF: 0
            }
        };
    }

    @http.POST('/interfaces')
    async createInterface(_body: HttpBody<OpenApiInterfaceBody>): Promise<OpenApiInterfaceResponse> {
        return { id: '' as UuidString, nested: { enabled: true } };
    }

    @http.POST('/generic-interface')
    async genericInterface(_body: HttpBody<OpenApiGenericInterfaceBody>): Promise<OkResponse> {
        return { ok: true };
    }

    @http.GET('/recursive')
    async recursive(): Promise<OpenApiRecursiveNode> {
        return { name: 'root' };
    }

    @http.GET('/helpers/json')
    helperJson(): JsonResponseResult {
        return jsonResponse({ ok: true }, 201);
    }

    @http.GET('/helpers/default-response')
    async helperDefaultResponse(): ApiResponse<OpenApiUserDto> {
        return new OpenApiUserDto();
    }

    @http.GET('/helpers/any')
    async helperAnyResponse(): AnyResponse {
        return { dynamic: true };
    }

    @http.GET('/helpers/raw')
    helperRaw(): RawResponseResult {
        return rawResponse('ok', { contentType: 'text/plain' });
    }

    @http.GET('/helpers/redirect')
    helperRedirect(): RedirectResponseResult {
        return redirectResponse('/users');
    }

    @http.GET('/helpers/empty')
    helperEmpty(): EmptyResponseResult {
        return emptyResponse();
    }

    @http.DELETE('/void-result')
    async deleteVoid(): Promise<void> {}

    @http.DELETE('/:id')
    async deleteUser(_id: string): EmptyResponse {
        return undefined;
    }
}

function createOpenApiConflictAController() {
    class OpenApiConflictDto {
        alpha!: string;
    }

    @http.controller('/conflict-a')
    class OpenApiConflictAController {
        @http.GET()
        async getConflictA(): Promise<OpenApiConflictDto> {
            return new OpenApiConflictDto();
        }
    }

    return OpenApiConflictAController;
}

function createOpenApiConflictBController() {
    class OpenApiConflictDto {
        beta!: number;
    }

    @http.controller('/conflict-b')
    class OpenApiConflictBController {
        @http.GET()
        async getConflictB(): Promise<OpenApiConflictDto> {
            return new OpenApiConflictDto();
        }
    }

    return OpenApiConflictBController;
}

const OpenApiConflictAController = createOpenApiConflictAController();
const OpenApiConflictBController = createOpenApiConflictBController();

function createOpenApiInterfaceConflictAController() {
    interface OpenApiSameNameInterface {
        alpha: string;
    }

    @http.controller('/interface-conflict-a')
    class OpenApiInterfaceConflictAController {
        @http.GET()
        async getConflictA(): Promise<OpenApiSameNameInterface> {
            return { alpha: '' };
        }
    }

    return OpenApiInterfaceConflictAController;
}

function createOpenApiInterfaceConflictBController() {
    interface OpenApiSameNameInterface {
        beta: number;
    }

    @http.controller('/interface-conflict-b')
    class OpenApiInterfaceConflictBController {
        @http.GET()
        async getConflictB(): Promise<OpenApiSameNameInterface> {
            return { beta: 1 };
        }
    }

    return OpenApiInterfaceConflictBController;
}

const OpenApiInterfaceConflictAController = createOpenApiInterfaceConflictAController();
const OpenApiInterfaceConflictBController = createOpenApiInterfaceConflictBController();

@http.controller('/naming')
class OpenApiNamingController {
    @http.GET('/alias')
    async alias(): Promise<ExplicitAliasTargetDto> {
        return new OpenApiAliasTarget() as ExplicitAliasTargetDto;
    }

    @http.GET('/plain')
    async plain(): Promise<OpenApiAliasTarget> {
        return new OpenApiAliasTarget();
    }

    @http.GET('/pick-id')
    async pickId(): Promise<OpenApiPickId> {
        return { id: '' };
    }

    @http.GET('/pick-email')
    async pickEmail(): Promise<OpenApiPickEmail> {
        return { email: '' };
    }
}

@http.controller('/runtime-utility')
class OpenApiRuntimeUtilityController {
    @http.GET('/pick')
    async pick(): Promise<unknown> {
        return {};
    }
}

const runtimeUtilityController = OpenApiRuntimeUtilityController as typeof OpenApiRuntimeUtilityController & {
    __tsfType: { methods: Array<{ name: string; returnType: unknown }> };
};
runtimeUtilityController.__tsfType.methods.find(method => method.name === 'pick')!.returnType = {
    kind: ReflectionKind.promise,
    type: {
        kind: ReflectionKind.objectLiteral,
        typeName: 'OpenApiRuntimePickResponse',
        utilityType: 'Pick',
        typeArguments: [
            {
                kind: ReflectionKind.class,
                typeName: 'OpenApiRuntimeUtilitySource',
                classType: () => OpenApiRuntimeUtilitySource
            }
        ],
        utilityKeys: ['id', 'email'],
        types: []
    }
};

@http.controller('/other')
class OpenApiOtherController {
    @http.GET()
    async other(): Promise<{ ok: true }> {
        return { ok: true };
    }
}

class ProductionConfig extends BaseAppConfig {
    APP_ENV = 'production';
    ENABLE_OPENAPI_SCHEMA = false;
}

class ProductionOpenApiRouteConfig extends BaseAppConfig {
    APP_ENV = 'production';
    ENABLE_OPENAPI_SCHEMA = false;
    ENABLE_OPENAPI_ROUTE = true;
}

class OpenApiDumpConfig extends BaseAppConfig {
    APP_ENV = 'test';
    ENABLE_OPENAPI_SCHEMA = true;
}

const tempDirs: string[] = [];
const originalCwd = process.cwd();

afterEach(async () => {
    process.chdir(originalCwd);
    await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('openapi', () => {
    it('serializes reflected routes, parameters, bodies, responses, and security', () => {
        const app = createApp({
            controllers: [OpenApiUsersController],
            enableHealthcheck: false
        });

        const doc = serializeOpenApiSchema(app);

        assert.equal(doc.openapi, '3.1.0');
        assert.equal(doc.jsonSchemaDialect, 'https://spec.openapis.org/oas/3.1/dialect/base');
        assert.deepStrictEqual(doc.info, { title: '@zyno-io/ts-server-foundation', version: '0.0.0-dev' });
        assert.deepStrictEqual(serializeOpenApiSchema(app, { title: 'Users API', version: '2.1.0' }).info, {
            title: 'Users API',
            version: '2.1.0'
        });
        assert.equal(doc.paths['/users/{id}'].get?.operationId, 'getOpenApiUsersGetUser');
        assert.equal(doc.paths['/users/setup-id-primary-action'].post?.operationId, 'postOpenApiUsersSetupIdPrimaryAction');
        assert.equal(doc.paths['/users/setup-id-secondary-action'].post?.operationId, 'postOpenApiUsersSetupIdSecondaryAction');
        assert.deepStrictEqual(doc.paths['/users/{id}'].get?.tags, ['openApiUsers']);
        assert.equal(doc.paths['/openapi.json'], undefined);
        assert.equal(doc.paths['/openapi.yaml'], undefined);
        const internalDoc = serializeOpenApiSchema(createApp({}));
        assert.equal(internalDoc.paths['/healthz'], undefined);
        assert.equal(internalDoc.paths['/openapi.json'], undefined);
        assert.equal(internalDoc.paths['/openapi.yaml'], undefined);
        const includedInternalDoc = serializeOpenApiSchema(createApp({}), { includeInternal: true });
        assert.ok(includedInternalDoc.paths['/healthz']);
        assert.ok(includedInternalDoc.paths['/openapi.json']);
        assert.ok(includedInternalDoc.paths['/openapi.yaml']);

        const getParams = doc.paths['/users/{id}'].get?.parameters ?? [];
        assert.deepStrictEqual(
            getParams.map(parameter => [parameter.in, parameter.name, parameter.required]),
            [
                ['path', 'id', true],
                ['query', 'includePosts', false],
                ['query', 'q', false]
            ]
        );
        assert.equal(schemaObject(getParams[0].schema).format, 'uuid');
        assert.equal(schemaObject(getParams[1].schema).type, 'boolean');
        assert.equal(schemaObject(getParams[2].schema).type, 'string');

        const listParams = doc.paths['/users'].get?.parameters ?? [];
        assert.deepStrictEqual(
            listParams.map(parameter => [parameter.in, parameter.name, parameter.required, schemaObject(parameter.schema).type]),
            [
                ['query', 'includePosts', false, 'boolean'],
                ['query', 'limit', true, 'number']
            ]
        );

        const optionalListParams = doc.paths['/users/optional-queries'].get?.parameters ?? [];
        assert.deepStrictEqual(
            optionalListParams.map(parameter => [parameter.in, parameter.name, parameter.required, schemaObject(parameter.schema).type]),
            [
                ['query', 'includePosts', false, 'boolean'],
                ['query', 'limit', false, 'number']
            ]
        );
        assert.equal(doc.paths['/users/summarized'].get?.summary, 'List users using the documented summary.');

        const createRequestSchema = doc.paths['/users'].post?.requestBody?.content['application/json'].schema;
        assert.deepStrictEqual(createRequestSchema, {
            $ref: '#/components/schemas/OpenApiCreateUserBody'
        });
        assert.equal(
            referenceObject(doc.paths['/users'].post?.responses['200'].content?.['application/json'].schema).$ref,
            '#/components/schemas/OpenApiUserDto'
        );
        assert.equal(
            referenceObject(doc.paths['/users/created'].post?.responses['201'].content?.['application/json'].schema).$ref,
            '#/components/schemas/OpenApiUserDto'
        );
        assert.equal(doc.paths['/users/created'].post?.responses['200'], undefined);
        const createBody = doc.components?.schemas?.OpenApiCreateUserBody;
        assert.deepStrictEqual(createBody?.required, ['name', 'roles']);
        assert.equal(schemaObject(createBody?.properties?.name).maxLength, 40);
        assert.equal(schemaObject(createBody?.properties?.name).minLength, 2);
        assert.equal(schemaObject(createBody?.properties?.email).pattern, '^[a-zA-Z0-9_+.-]+@[a-zA-Z0-9-.]+\\.[a-zA-Z]+$');
        assert.equal(schemaObject(createBody?.properties?.birthday).format, 'date');
        assert.equal(schemaObject(createBody?.properties?.score).exclusiveMinimum, 0);
        assert.equal(schemaObject(createBody?.properties?.ratio).exclusiveMaximum, 100);
        assert.deepStrictEqual(schemaObject(schemaObject(createBody?.properties?.roles).items).enum, ['admin', 'user']);

        const userDto = doc.components?.schemas?.OpenApiUserDto;
        assert.equal(schemaObject(userDto?.properties?.id).format, 'uuid');
        assert.deepStrictEqual(schemaObject(userDto?.properties?.status).enum, ['active', 'disabled']);
        assert.equal(schemaObject(userDto?.properties?.createdAt).format, 'date-time');

        assert.equal(
            referenceObject(doc.paths['/users/webhook-delivery'].get?.responses['200'].content?.['application/json'].schema).$ref,
            '#/components/schemas/OpenApiWebhookDeliveryDto'
        );
        const webhookDelivery = doc.components?.schemas?.OpenApiWebhookDeliveryDto;
        assert.equal(referenceObject(webhookDelivery?.properties?.status).$ref, '#/components/schemas/OpenApiWebhookDeliveryStatus');
        assert.deepStrictEqual(doc.components?.schemas?.OpenApiWebhookDeliveryStatus, {
            enum: ['pending', 'delivering', 'succeeded'],
            type: 'string'
        });

        const upload = doc.paths['/users/{id}/avatar'].post?.requestBody?.content['multipart/form-data'];
        const uploadSchema = schemaObject(upload?.schema);
        assert.equal(schemaObject(uploadSchema.properties?.file).format, 'binary');
        assert.equal(schemaObject(uploadSchema.properties?.file)['x-maxSizeBytes'], 40 * 1024 * 1024);
        assert.deepStrictEqual(schemaObject(uploadSchema.properties?.file)['x-allowedTypes'], ['image/jpeg', 'image/png']);
        assert.deepStrictEqual(uploadSchema.required, ['file', '_payload']);
        assert.equal(upload?.encoding?.file?.contentType, 'image/jpeg, image/png');
        assert.equal(upload?.encoding?._payload.contentType, 'application/json');
        assert.equal(referenceObject(uploadSchema.properties?._payload).$ref, '#/components/schemas/OpenApiUploadBody');

        const optionalDirectUpload = doc.paths['/users/optional-direct-upload'].post?.requestBody;
        const optionalDirectUploadSchema = schemaObject(optionalDirectUpload?.content['multipart/form-data'].schema);
        assert.equal(optionalDirectUpload?.required, false);
        assert.equal(schemaObject(optionalDirectUploadSchema.properties?.file).format, 'binary');
        assert.equal(optionalDirectUploadSchema.required, undefined);

        const deepRequiredContent = doc.paths['/users/deep-required-upload'].post?.requestBody?.content;
        assert.equal(deepRequiredContent?.['application/json'], undefined);
        assert.equal(referenceObject(deepRequiredContent?.['multipart/form-data'].schema).$ref, '#/components/schemas/OpenApiDeepRequiredUploadBody');
        assert.deepStrictEqual(doc.components?.schemas?.OpenApiDeepRequiredUploadBody?.required, ['nested']);
        assert.deepStrictEqual(doc.components?.schemas?.OpenApiNestedUploadPart?.required, ['file']);

        const deepOptionalContent = doc.paths['/users/deep-optional-upload'].post?.requestBody?.content;
        assert.ok(deepOptionalContent?.['application/json']);
        assert.ok(deepOptionalContent?.['multipart/form-data']);
        assert.deepStrictEqual(deepOptionalContent?.['application/json'].schema, deepOptionalContent?.['multipart/form-data'].schema);

        const nestedUploadContent = doc.paths['/users/nested-upload'].post?.requestBody?.content;
        assert.equal(nestedUploadContent?.['application/json'], undefined);
        assert.equal(referenceObject(nestedUploadContent?.['multipart/form-data'].schema).$ref, '#/components/schemas/OpenApiNestedUploadBody');
        const nestedUploadBody = doc.components?.schemas?.OpenApiNestedUploadBody;
        assert.deepStrictEqual(nestedUploadBody?.required, ['file']);
        assert.equal(schemaObject(nestedUploadBody?.properties?.file).format, 'binary');
        assert.equal(schemaObject(nestedUploadBody?.properties?.file)['x-maxSizeBytes'], 1024 * 1024);
        assert.deepStrictEqual(schemaObject(nestedUploadBody?.properties?.file)['x-allowedTypes'], ['image/png']);
        assert.equal(nestedUploadContent?.['multipart/form-data'].encoding?.file?.contentType, 'image/png');

        const optionalUploadContent = doc.paths['/users/optional-upload'].post?.requestBody?.content;
        assert.ok(optionalUploadContent?.['application/json']);
        assert.ok(optionalUploadContent['multipart/form-data']);
        assert.deepStrictEqual(optionalUploadContent?.['application/json'].schema, optionalUploadContent?.['multipart/form-data'].schema);
        assert.equal(optionalUploadContent?.['multipart/form-data'].encoding?.attachment?.contentType, 'application/pdf');

        const nativeClassBodyContent = doc.paths['/users/native-class-body'].post?.requestBody?.content;
        assert.equal(nativeClassBodyContent?.['multipart/form-data'], undefined);
        assert.equal(referenceObject(nativeClassBodyContent?.['application/json'].schema).$ref, '#/components/schemas/OpenApiNativeClassBody');
        assert.equal(referenceObject(doc.components?.schemas?.OpenApiNativeClassBody?.properties?.endpoint).$ref, '#/components/schemas/URL');

        const nullableBodySchema = schemaObject(doc.paths['/users/nullable-body'].post?.requestBody?.content['application/json'].schema);
        assert.equal(referenceObject(nullableBodySchema.anyOf?.[0]).$ref, '#/components/schemas/OpenApiCreateUserBody');
        assert.deepStrictEqual(nullableBodySchema.anyOf?.[1], { type: 'null' });
        const nullableResponseSchema = schemaObject(doc.paths['/users/nullable'].get?.responses['200'].content?.['application/json'].schema);
        assert.equal(referenceObject(nullableResponseSchema.anyOf?.[0]).$ref, '#/components/schemas/OpenApiUserDto');
        assert.deepStrictEqual(nullableResponseSchema.anyOf?.[1], { type: 'null' });

        assert.equal(
            referenceObject(doc.paths['/users/named'].get?.responses['200'].content?.['application/json'].schema).$ref,
            '#/components/schemas/ExplicitOpenApiDto'
        );
        assert.equal(schemaObject(doc.components?.schemas?.ExplicitOpenApiDto?.properties?.value).type, 'string');
        assert.equal(
            referenceObject(doc.paths['/users/nested-pick'].get?.responses['200'].content?.['application/json'].schema).$ref,
            '#/components/schemas/OpenApiNestedPickResponse'
        );
        const nestedPickResponse = schemaObject(doc.components?.schemas?.OpenApiNestedPickResponse);
        assert.equal(schemaObject(nestedPickResponse.properties?.id).type, 'string');
        assert.equal(schemaObject(nestedPickResponse.properties?.email).type, 'string');
        assert.equal(nestedPickResponse.properties?.name, undefined);
        assert.equal(referenceObject(nestedPickResponse.properties?.profile).$ref, '#/components/schemas/OpenApiNestedPickProfile');
        assert.equal(schemaObject(doc.components?.schemas?.OpenApiNestedPickProfile?.properties?.name).type, 'string');
        const nestedPickItem = schemaObject(schemaObject(nestedPickResponse.properties?.items).items);
        assert.equal(schemaObject(nestedPickItem.properties?.relatedId).type, 'string');
        assert.equal(schemaObject(nestedPickItem.properties?.startsAt).format, 'date-time');
        assert.equal(schemaObject(nestedPickItem.properties?.allowOverride).type, 'boolean');
        const indexedAccessResponse = schemaObject(doc.components?.schemas?.OpenApiIndexedAccessResponse);
        const indexedEntries = schemaObject(indexedAccessResponse.properties?.entries);
        assert.equal(indexedEntries.type, 'array');
        assert.equal(resolveSchemaObject(doc, indexedEntries.items).properties?.option !== undefined, true);
        const indexedGroup = resolveSchemaObject(doc, indexedAccessResponse.properties?.group);
        assert.deepStrictEqual(Object.keys(indexedGroup.properties ?? {}).sort(), ['amount', 'duration', 'guaranteed', 'label', 'margin', 'option']);
        assert.deepStrictEqual(schemaObject(indexedGroup.properties?.duration).type, ['number', 'null']);
        assert.deepStrictEqual(schemaObject(indexedAccessResponse.properties?.status).enum, ['pending', 'complete']);
        assert.equal(schemaObject(indexedAccessResponse.properties?.status).type, 'string');
        assert.equal(
            referenceObject(doc.paths['/users/channel-input'].post?.requestBody?.content['application/json'].schema).$ref,
            '#/components/schemas/OpenApiChannelUpdateInput'
        );
        const channelInput = schemaObject(doc.components?.schemas?.OpenApiChannelUpdateInput);
        assert.deepStrictEqual(Object.keys(channelInput.properties ?? {}).sort(), ['customKind', 'id', 'kind', 'note', 'suffix', 'value']);
        assert.equal(channelInput.properties?.createdAt, undefined);
        assert.deepStrictEqual(channelInput.required, ['value']);
        assert.deepStrictEqual(schemaObject(channelInput.properties?.kind).type, ['string', 'null']);
        assert.deepStrictEqual(schemaObject(channelInput.properties?.kind).enum, ['primary', 'secondary', null]);
        assert.deepStrictEqual(schemaObject(channelInput.properties?.customKind).type, ['string', 'null']);
        assert.deepStrictEqual(schemaObject(channelInput.properties?.suffix).type, ['string', 'null']);
        assert.deepStrictEqual(schemaObject(channelInput.properties?.note).type, ['string', 'null']);
        assert.equal(
            referenceObject(doc.paths['/users/imported-report-summary'].get?.responses['200'].content?.['application/json'].schema).$ref,
            '#/components/schemas/OpenApiImportedReportSummaryResponse'
        );
        const reportSummary = schemaObject(doc.components?.schemas?.OpenApiImportedReportSummaryResponse);
        assert.deepStrictEqual(Object.keys(reportSummary.properties ?? {}).sort(), [
            'categoryBreakdown',
            'customEntries',
            'detailBreakdown',
            'sourceBreakdown',
            'totalAmount'
        ]);
        assert.equal(reportSummary.properties?.id, undefined);
        assert.equal(reportSummary.properties?.scopeId, undefined);
        assert.equal(reportSummary.properties?.groupId, undefined);
        assert.deepStrictEqual(
            Object.keys(resolveSchemaObject(doc, schemaObject(reportSummary.properties?.categoryBreakdown).items).properties ?? {}).sort(),
            ['categoryId', 'total']
        );
        assert.deepStrictEqual(
            Object.keys(resolveSchemaObject(doc, schemaObject(reportSummary.properties?.detailBreakdown).items).properties ?? {}).sort(),
            ['detailTypeId', 'itemCount', 'total']
        );
        assert.deepStrictEqual(
            Object.keys(resolveSchemaObject(doc, schemaObject(reportSummary.properties?.customEntries).items).properties ?? {}).sort(),
            ['customEntryId', 'total']
        );
        const ruleSetRequest = schemaObject(doc.components?.schemas?.OpenApiReexportedRuleSetCreateRequest);
        assert.deepStrictEqual(resolveSchemaObject(doc, ruleSetRequest.properties?.strategy).enum, ['alpha', 'beta', 'gamma']);
        const ruleSetRule = resolveSchemaObject(doc, schemaObject(ruleSetRequest.properties?.rules).items);
        const ruleVariants = schemaAlternatives(doc, ruleSetRule);
        assert.equal(
            ruleVariants.some(schema => schema.properties?.indexes !== undefined),
            true
        );
        assert.equal(
            ruleVariants.some(schema => schema.properties?.keys !== undefined),
            true
        );

        const optionConfig = schemaObject(doc.components?.schemas?.OpenApiReexportedOptionConfig);
        assert.deepStrictEqual(resolveSchemaObject(doc, schemaObject(optionConfig.properties?.enabledOptions).items).enum, [
            'optionA',
            'optionB',
            'optionC'
        ]);
        const optionConfigUpdate = schemaObject(doc.components?.schemas?.OpenApiReexportedOptionConfigUpdate);
        assert.deepStrictEqual(resolveSchemaObject(doc, schemaObject(optionConfigUpdate.properties?.enabledOptions).items).enum, [
            'optionA',
            'optionB',
            'optionC'
        ]);
        assert.equal(doc.components?.schemas?.OpenApiReexportedOption_2, undefined);

        const reexportedSteps = schemaObject(doc.components?.schemas?.OpenApiReexportedSteps);
        assert.equal(reexportedSteps.type, 'object');
        assert.ok(reexportedSteps.additionalProperties && reexportedSteps.additionalProperties !== true);
        const stepVariants = schemaAlternatives(doc, reexportedSteps.additionalProperties);
        assert.equal(
            stepVariants.some(schema => schema.properties?.timeout !== undefined),
            true
        );
        assert.equal(
            stepVariants.some(schema => schema.properties?.options !== undefined),
            true
        );

        const bindingRequest = schemaObject(doc.components?.schemas?.OpenApiReexportedBindingRequest);
        const bindingNodes = resolveSchemaObject(doc, bindingRequest.properties?.nodes);
        assert.ok(bindingNodes.additionalProperties && bindingNodes.additionalProperties !== true);
        const bindingNode = resolveSchemaObject(doc, bindingNodes.additionalProperties);
        const bindingVariants = schemaAlternatives(doc, bindingNode);
        assert.deepStrictEqual(
            bindingVariants.map(schema => schema.required),
            [
                ['id', 'type', 'matchNext', 'noMatchNext', 'timeConditionId'],
                ['id', 'type', 'matchNext', 'noMatchNext', 'locationId']
            ]
        );
        assert.deepStrictEqual(bindingVariants[0].properties?.locationId, { not: {} });
        assert.deepStrictEqual(bindingVariants[1].properties?.timeConditionId, { not: {} });

        const containerUpdate = schemaObject(doc.components?.schemas?.OpenApiReexportedContainerUpdateRequest);
        const containerConfigTypes = collectDiscriminatorValues(doc, containerUpdate.properties?.selectedConfig, 'type');
        assert.deepStrictEqual([...containerConfigTypes].sort(), ['alpha', 'empty', 'gamma', 'reference']);
        assert.equal(containerConfigTypes.has('beta'), false);

        const settingsRequest = schemaObject(doc.components?.schemas?.OpenApiSettingsRequest);
        assert.deepStrictEqual(Object.keys(settingsRequest.properties ?? {}).sort(), ['settingA', 'settingB', 'settingC']);
        assert.deepStrictEqual(schemaObject(settingsRequest.properties?.settingA).type, ['string', 'null']);
        assert.deepStrictEqual(schemaObject(settingsRequest.properties?.settingC).type, ['string', 'null']);
        assert.equal(settingsRequest.required, undefined);
        assert.equal(
            referenceObject(doc.components?.schemas?.OpenApiSettingsUpdateRequest?.properties?.settings).$ref,
            '#/components/schemas/OpenApiSettingsRequest'
        );
        assert.equal(
            referenceObject(doc.components?.schemas?.OpenApiSettingsUpdateRequest?.properties?.['settings.children']).$ref,
            '#/components/schemas/OpenApiChildSettingsRequest'
        );
        const childSettingsRequest = schemaObject(doc.components?.schemas?.OpenApiChildSettingsRequest);
        assert.deepStrictEqual(Object.keys(childSettingsRequest.properties ?? {}).sort(), ['settingA', 'settingB']);
        assert.equal(schemaObject(childSettingsRequest.properties?.settingA).type, 'string');
        assert.equal(childSettingsRequest.required, undefined);

        const partialIntersectionUpdate = schemaObject(doc.components?.schemas?.OpenApiPartialIntersectionUpdateRequest);
        assert.deepStrictEqual(Object.keys(partialIntersectionUpdate.properties ?? {}).sort(), ['email', 'name', 'steps']);
        assert.equal(partialIntersectionUpdate.required, undefined);
        assert.equal(referenceObject(partialIntersectionUpdate.properties?.steps).$ref, '#/components/schemas/OpenApiReexportedSteps');

        const wrappedQueryParameters = doc.paths['/users/wrapped-named-query'].get?.parameters ?? [];
        assert.deepStrictEqual(
            wrappedQueryParameters.map(parameter => parameter.name),
            ['valueStart', 'valueEnd', 'mode', 'source']
        );
        assert.deepStrictEqual(resolveSchemaObject(doc, wrappedQueryParameters.find(parameter => parameter.name === 'source')?.schema).enum, [
            'sourceA',
            'sourceB'
        ]);
        assert.deepStrictEqual(resolveSchemaObject(doc, doc.components?.schemas?.OpenApiWrappedNamedQuery?.properties?.source).enum, [
            'sourceA',
            'sourceB'
        ]);
        assert.equal(schemaObject(doc.components?.schemas?.OpenApiWrappedNamedQuery?.properties?.valueStart).type, 'string');
        assert.equal(
            referenceObject(doc.paths['/users/wrapped-named-query'].get?.responses['200'].content?.['application/json'].schema).$ref,
            '#/components/schemas/OpenApiWrappedNamedPromiseResponse'
        );
        assert.equal(
            referenceObject(doc.paths['/users/wrapped-named-body'].post?.requestBody?.content['application/json'].schema).$ref,
            '#/components/schemas/OpenApiWrappedNamedBody'
        );
        assert.equal(
            referenceObject(doc.paths['/users/wrapped-named-body'].post?.responses['202'].content?.['application/json'].schema).$ref,
            '#/components/schemas/OpenApiWrappedNamedApiResponse'
        );
        assert.equal(
            referenceObject(doc.paths['/users/tagged-union'].get?.responses['200'].content?.['application/json'].schema).$ref,
            '#/components/schemas/OpenApiTaggedUnionResponse'
        );
        const taggedUnion = schemaObject(doc.components?.schemas?.OpenApiTaggedUnionResponse);
        const taggedUnionValue = schemaObject(taggedUnion.properties?.value);
        assert.deepStrictEqual(taggedUnionValue.oneOf, [
            { type: 'string', format: 'date', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            {
                type: 'string',
                format: 'uuid',
                pattern: '^(?:urn:uuid:)?[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$'
            }
        ]);

        const interfaceListResponse = schemaObject(doc.paths['/users/interfaces'].get?.responses['200'].content?.['application/json'].schema);
        assert.equal(referenceObject(interfaceListResponse.items).$ref, '#/components/schemas/OpenApiInterfaceResponse');
        assert.equal(
            referenceObject(doc.paths['/users/interfaces'].post?.requestBody?.content['application/json'].schema).$ref,
            '#/components/schemas/OpenApiInterfaceBody'
        );
        assert.equal(
            referenceObject(doc.paths['/users/interfaces'].post?.responses['200'].content?.['application/json'].schema).$ref,
            '#/components/schemas/OpenApiInterfaceResponse'
        );
        assert.equal(schemaObject(doc.components?.schemas?.OpenApiInterfaceBody?.properties?.title).minLength, 3);
        assert.equal(schemaObject(doc.components?.schemas?.OpenApiInterfaceBody?.properties?.['quoted.name']).type, 'boolean');
        assert.equal(doc.components?.schemas?.OpenApiInterfaceBody?.properties?.[`'quoted.name'`], undefined);
        assert.deepStrictEqual(schemaObject(doc.components?.schemas?.OpenApiInterfaceBody?.properties?.nullableText).type, ['string', 'null']);
        assert.deepStrictEqual(schemaObject(doc.components?.schemas?.OpenApiInterfaceBody?.properties?.nullableStatus).type, ['string', 'null']);
        assert.deepStrictEqual(schemaObject(doc.components?.schemas?.OpenApiInterfaceBody?.properties?.nullableStatus).enum, [
            'active',
            'inactive',
            null
        ]);
        assert.ok(doc.components?.schemas?.OpenApiInterfaceBody?.properties?.payload);
        assert.equal(doc.components?.schemas?.OpenApiInterfaceBody?.properties?.['* Comment with braces should not be parsed as a field'], undefined);
        const genericInterfaceBody = schemaObject(doc.components?.schemas?.OpenApiGenericInterfaceBody);
        const genericContainer = resolveSchemaObject(doc, genericInterfaceBody.properties?.selection);
        assert.deepStrictEqual(Object.keys(genericContainer.properties ?? {}), ['items', 'alternatives']);
        const genericVariant = resolveSchemaObject(doc, schemaObject(genericContainer.properties?.items).items);
        assert.equal(genericVariant.oneOf?.length, 2);
        assert.deepStrictEqual(
            genericVariant.oneOf?.map(item => schemaObject(item).properties?.kind),
            [
                { type: 'string', enum: ['alpha'] },
                { type: 'string', enum: ['beta'] }
            ]
        );
        assert.equal(
            referenceObject(doc.paths['/users/interface-extends-alias'].get?.responses['200'].content?.['application/json'].schema).$ref,
            '#/components/schemas/OpenApiInterfaceExtendsAlias'
        );
        assert.equal(schemaObject(doc.components?.schemas?.OpenApiInterfaceExtendsAlias?.properties?.id).type, 'string');
        assert.equal(schemaObject(doc.components?.schemas?.OpenApiInterfaceExtendsAlias?.properties?.enabled).type, 'boolean');
        assert.equal(doc.components?.schemas?.OpenApiInterfaceExtendsAlias?.properties?.email, undefined);
        const extendsIntersection = schemaObject(doc.components?.schemas?.OpenApiInterfaceExtendsIntersectionAlias);
        assert.equal(schemaObject(extendsIntersection.properties?.id).type, 'string');
        assert.equal(schemaObject(extendsIntersection.properties?.email).type, 'string');
        assert.equal(schemaObject(extendsIntersection.properties?.inheritedFlag).type, 'boolean');
        assert.deepStrictEqual(schemaObject(extendsIntersection.properties?.inheritedNullable).type, ['string', 'null']);
        assert.equal(schemaObject(extendsIntersection.properties?.enabled).type, 'boolean');
        assert.deepStrictEqual(extendsIntersection.required, ['id', 'email', 'inheritedFlag', 'enabled']);
        const extendsInterface = schemaObject(doc.components?.schemas?.OpenApiInterfaceDetail);
        assert.equal(schemaObject(extendsInterface.properties?.operationId).type, 'string');
        assert.equal(schemaObject(extendsInterface.properties?.submittedByActorId).type, 'string');
        assert.equal(schemaObject(extendsInterface.properties?.createdAtMs).type, 'number');
        assert.equal(referenceObject(extendsInterface.properties?.metrics).$ref, '#/components/schemas/OpenApiInterfaceMetrics');
        assert.deepStrictEqual(extendsInterface.required, ['operationId', 'submittedByActorId', 'createdAtMs', 'groups', 'metrics']);
        const taskDetail = schemaObject(doc.components?.schemas?.ITaskDetail);
        assert.equal(schemaObject(taskDetail.properties?.operationId).type, 'string');
        assert.equal(referenceObject(taskDetail.properties?.metrics).$ref, '#/components/schemas/ITaskMetrics');
        assert.deepStrictEqual(taskDetail.required, ['operationId', 'submittedByActorId', 'createdAtMs', 'groups', 'metrics']);
        assert.equal(
            referenceObject(doc.components?.schemas?.OpenApiInterfaceResponse?.properties?.nested).$ref,
            '#/components/schemas/OpenApiInterfaceNested'
        );
        assert.equal(schemaObject(doc.components?.schemas?.OpenApiInterfaceNested?.properties?.enabled).type, 'boolean');
        assert.equal(
            referenceObject(doc.paths['/users/recursive'].get?.responses['200'].content?.['application/json'].schema).$ref,
            '#/components/schemas/OpenApiRecursiveNode'
        );
        assert.equal(
            referenceObject(doc.components?.schemas?.OpenApiRecursiveNode?.properties?.child).$ref,
            '#/components/schemas/OpenApiRecursiveNode'
        );

        const secure = doc.paths['/users/secure'].post;
        assert.deepStrictEqual(secure?.security, [{ bearerAuth: [] }]);
        assert.equal(doc.paths['/users/optional-auth'].get?.security, undefined);
        assert.equal((doc.components?.securitySchemes?.bearerAuth as { type?: string } | undefined)?.type, 'http');

        assert.equal(doc.paths['/users/{id}'].delete?.responses['204'].description, 'No Content');
        assert.equal(doc.paths['/users/void-result'].delete?.responses['200'].description, 'OK');
        assert.equal(doc.paths['/users/void-result'].delete?.responses['204'], undefined);
        assert.equal(doc.paths['/users/void-result'].delete?.responses['200'].content, undefined);
        const okResponseSchema = schemaObject(doc.paths['/users/{id}/avatar'].post?.responses['200'].content?.['application/json'].schema);
        assert.deepStrictEqual(okResponseSchema, {});
        assert.deepStrictEqual(
            schemaObject(doc.paths['/users/setup-id-primary-action'].post?.responses['200'].content?.['application/json'].schema),
            {}
        );
        assert.equal(
            referenceObject(doc.paths['/users/helpers/default-response'].get?.responses['200'].content?.['application/json'].schema).$ref,
            '#/components/schemas/OpenApiUserDto'
        );
        assert.deepStrictEqual(schemaObject(doc.paths['/users/helpers/any'].get?.responses['200'].content?.['application/json'].schema), {});
        assert.deepStrictEqual(schemaObject(doc.paths['/users/helpers/json'].get?.responses.default.content?.['application/json'].schema), {});
        assert.equal(doc.paths['/users/helpers/raw'].get?.responses.default.content, undefined);
        assert.equal(schemaObject(doc.paths['/users/helpers/redirect'].get?.responses.default.headers?.location.schema).type, 'string');
        assert.equal(doc.paths['/users/helpers/empty'].get?.responses.default.description, 'No Content');
    });

    it('keeps same-name component schemas distinct and supports explicit ApiName aliases', () => {
        const app = createApp({
            controllers: [
                OpenApiConflictAController,
                OpenApiConflictBController,
                OpenApiInterfaceConflictAController,
                OpenApiInterfaceConflictBController,
                OpenApiNamingController
            ],
            enableHealthcheck: false
        });

        const doc = serializeOpenApiSchema(app);
        const conflictARef = referenceObject(doc.paths['/conflict-a'].get?.responses['200'].content?.['application/json'].schema).$ref;
        const conflictBRef = referenceObject(doc.paths['/conflict-b'].get?.responses['200'].content?.['application/json'].schema).$ref;

        assert.notEqual(conflictARef, conflictBRef);
        assert.equal(schemaObject(schemaForRef(doc, conflictARef)?.properties?.alpha).type, 'string');
        assert.equal(schemaObject(schemaForRef(doc, conflictBRef)?.properties?.beta).type, 'number');

        const interfaceConflictARef = referenceObject(
            doc.paths['/interface-conflict-a'].get?.responses['200'].content?.['application/json'].schema
        ).$ref;
        const interfaceConflictBRef = referenceObject(
            doc.paths['/interface-conflict-b'].get?.responses['200'].content?.['application/json'].schema
        ).$ref;
        assert.notEqual(interfaceConflictARef, interfaceConflictBRef);
        assert.equal(schemaObject(schemaForRef(doc, interfaceConflictARef)?.properties?.alpha).type, 'string');
        assert.equal(schemaObject(schemaForRef(doc, interfaceConflictBRef)?.properties?.beta).type, 'number');

        assert.equal(
            referenceObject(doc.paths['/naming/alias'].get?.responses['200'].content?.['application/json'].schema).$ref,
            '#/components/schemas/ExplicitAliasTargetDto'
        );
        assert.equal(
            referenceObject(doc.paths['/naming/plain'].get?.responses['200'].content?.['application/json'].schema).$ref,
            '#/components/schemas/OpenApiAliasTarget'
        );

        const pickIdRef = referenceObject(doc.paths['/naming/pick-id'].get?.responses['200'].content?.['application/json'].schema).$ref;
        const pickEmailRef = referenceObject(doc.paths['/naming/pick-email'].get?.responses['200'].content?.['application/json'].schema).$ref;
        assert.notEqual(pickIdRef, pickEmailRef);
        assert.equal(schemaObject(schemaForRef(doc, pickIdRef)?.properties?.id).type, 'string');
        assert.equal(schemaObject(schemaForRef(doc, pickEmailRef)?.properties?.email).type, 'string');
        assert.equal(schemaForRef(doc, pickIdRef)?.properties?.email, undefined);
        assert.equal(schemaForRef(doc, pickEmailRef)?.properties?.id, undefined);
    });

    it('expands runtime utility metadata from reflected source class properties', () => {
        const app = createApp({
            controllers: [OpenApiRuntimeUtilityController],
            enableHealthcheck: false
        });

        const doc = serializeOpenApiSchema(app);
        assert.equal(
            referenceObject(doc.paths['/runtime-utility/pick'].get?.responses['200'].content?.['application/json'].schema).$ref,
            '#/components/schemas/OpenApiRuntimePickResponse'
        );
        const schema = schemaObject(doc.components?.schemas?.OpenApiRuntimePickResponse);
        assert.equal(schemaObject(schema.properties?.id).type, 'string');
        assert.equal(schemaObject(schema.properties?.email).type, 'string');
        assert.equal(schema.properties?.name, undefined);
    });

    it('uses indexed access utility metadata for validation and deserialization', () => {
        const deserialized = deserialize<OpenApiIndexedAccessResponse>({
            group: {
                option: 'optionA',
                label: 'basic',
                duration: '2',
                guaranteed: 'true',
                amount: '4.5',
                margin: '6.75',
                internalCode: 'hidden'
            },
            status: 'pending'
        });

        assert.deepStrictEqual(deserialized.group, {
            option: 'optionA',
            label: 'basic',
            duration: 2,
            guaranteed: true,
            amount: 4.5,
            margin: 6.75
        });
        assert.deepStrictEqual(
            validate<OpenApiIndexedAccessResponse>({
                group: { option: 'optionC' },
                status: 'pending'
            }).map(error => error.path),
            ['group.option', 'group.label', 'group.duration', 'group.guaranteed', 'group.amount', 'group.margin']
        );
    });

    it('uses indexed access through intersection alias metadata for validation and deserialization', () => {
        const deserialized = deserialize<OpenApiChannelUpdateInput>({
            id: 'channel-1',
            kind: null,
            customKind: null,
            value: 'value-1',
            suffix: null,
            note: 'Main value',
            createdAt: '2024-01-01T00:00:00.000Z'
        });

        assert.deepStrictEqual(deserialized, {
            id: 'channel-1',
            kind: null,
            customKind: null,
            value: 'value-1',
            suffix: null,
            note: 'Main value'
        });
        assert.deepStrictEqual(
            validate<OpenApiChannelUpdateInput>({ suffix: null, note: null }).map(error => error.path),
            ['value']
        );
    });

    it('uses imported utility intersection metadata for validation and deserialization', () => {
        const deserialized = deserialize<OpenApiImportedReportSummaryResponse>({
            id: 'hidden',
            scopeId: 'hidden',
            groupId: 'hidden',
            totalAmount: '10.5',
            categoryBreakdown: [{ categoryId: 'category-1', total: '8' }],
            detailBreakdown: [{ detailTypeId: 'detail-1', total: '2', itemCount: '1' }],
            customEntries: [{ customEntryId: 'custom-1', total: '3' }],
            sourceBreakdown: [{ label: null, baseAmount: '5', extraAmount: '1' }]
        });

        assert.deepStrictEqual(deserialized, {
            totalAmount: 10.5,
            categoryBreakdown: [{ categoryId: 'category-1', total: 8 }],
            detailBreakdown: [{ detailTypeId: 'detail-1', total: 2, itemCount: 1 }],
            customEntries: [{ customEntryId: 'custom-1', total: 3 }],
            sourceBreakdown: [{ label: null, baseAmount: 5, extraAmount: 1 }]
        });
        assert.deepStrictEqual(
            validate<OpenApiImportedReportSummaryResponse>({
                totalAmount: 10.5,
                categoryBreakdown: [{}],
                detailBreakdown: [{}],
                customEntries: [{}],
                sourceBreakdown: [{}]
            }).map(error => error.path),
            [
                'categoryBreakdown.0.categoryId',
                'categoryBreakdown.0.total',
                'detailBreakdown.0.detailTypeId',
                'detailBreakdown.0.total',
                'detailBreakdown.0.itemCount',
                'customEntries.0.customEntryId',
                'customEntries.0.total',
                'sourceBreakdown.0.label',
                'sourceBreakdown.0.baseAmount',
                'sourceBreakdown.0.extraAmount'
            ]
        );
    });

    it('uses reexported aliases, index signatures, and Extract metadata at runtime', async () => {
        const barrel = (await import('./openapi-reexported-types-barrel')) as {
            __tsfTypeAliases?: Record<string, unknown>;
        };
        assert.ok(barrel.__tsfTypeAliases?.OpenApiReexportedStrategy);
        assert.ok(barrel.__tsfTypeAliases?.OpenApiReexportedRule);

        const steps = deserialize<OpenApiReexportedSteps>({
            start: { type: 'terminal', timeout: '15' },
            branch: { type: 'branch', options: { alpha: 'alpha-step' } }
        });
        assert.deepStrictEqual(steps, {
            start: { type: 'terminal', timeout: 15 },
            branch: { type: 'branch', options: { alpha: 'alpha-step' } }
        });
        assert.deepStrictEqual(
            validate<OpenApiReexportedSteps>({ start: { type: 'terminal', timeout: 'bad' } }).map(error => error.path),
            ['start.timeout']
        );
        assert.deepStrictEqual(
            validate<OpenApiReexportedContainerUpdateRequest>({
                selectedConfig: { type: 'beta', rootKey: 'root' }
            }).map(error => error.path),
            ['selectedConfig.type']
        );
    });

    it('uses interface extends intersection alias metadata for validation and deserialization', () => {
        const deserialized = deserialize<OpenApiInterfaceExtendsIntersectionAlias>({
            id: '123',
            email: 'test@example.com',
            inheritedFlag: 'true',
            inheritedNullable: null,
            enabled: 'false'
        });

        assert.deepStrictEqual(deserialized, {
            id: '123',
            email: 'test@example.com',
            inheritedFlag: true,
            inheritedNullable: null,
            enabled: false
        });
        assert.deepStrictEqual(
            validate<OpenApiInterfaceExtendsIntersectionAlias>({ id: 'id', enabled: true }).map(error => error.path),
            ['email', 'inheritedFlag']
        );
    });

    it('uses direct interface extends metadata for validation', () => {
        assert.deepStrictEqual(
            validate<OpenApiInterfaceDetail>({
                operationId: 'operation',
                submittedByActorId: 'actor',
                createdAtMs: 1,
                groups: []
            }).map(error => error.path),
            ['metrics']
        );
        assert.deepStrictEqual(
            validate<ITaskDetail>({
                operationId: 'operation',
                submittedByActorId: 'actor',
                createdAtMs: 1,
                groups: []
            }).map(error => error.path),
            ['metrics']
        );
    });

    it('serves /openapi.json and /openapi.yaml in test apps', async () => {
        const tf = TestingHelpers.createTestingFacade({
            controllers: [OpenApiUsersController],
            enableHealthcheck: false
        });

        await tf.start();
        try {
            const response = await tf.request(new HttpRequest('GET', '/openapi.json'));
            assert.equal(response.statusCode, 200);
            assert.match(String(response.headers['content-type']), /application\/json/);
            assert.equal(response.json.openapi, '3.1.0');
            assert.equal(response.json.paths['/users/{id}'].get.operationId, 'getOpenApiUsersGetUser');
            assert.equal(response.json.paths['/openapi.json'], undefined);
            assert.equal(response.json.paths['/openapi.yaml'], undefined);
            assert.equal(response.json.paths['/healthz'], undefined);

            const yamlResponse = await tf.request(new HttpRequest('GET', '/openapi.yaml'));
            assert.equal(yamlResponse.statusCode, 200);
            assert.match(String(yamlResponse.headers['content-type']), /application\/yaml/);
            assert.match(yamlResponse.text, /openapi: 3\.1\.0/);
            assert.match(yamlResponse.text, /getOpenApiUsersGetUser/);
            assert.equal((await tf.request(HttpRequest.POST('/users/created', { name: 'Ada', roles: ['admin'] }))).statusCode, 201);
            assert.equal((await tf.request(HttpRequest.GET('/users/helpers/default-response'))).statusCode, 200);
            assert.equal((await tf.request(new HttpRequest('DELETE', '/users/void-result'))).statusCode, 200);
            assert.equal((await tf.request(new HttpRequest('DELETE', '/users/abc'))).statusCode, 204);
        } finally {
            await tf.stop();
        }
    });

    it('serves the schema for the app handling the OpenAPI request', async () => {
        const usersTf = TestingHelpers.createTestingFacade({
            controllers: [OpenApiUsersController],
            enableHealthcheck: false
        });
        const otherTf = TestingHelpers.createTestingFacade({
            controllers: [OpenApiOtherController],
            enableHealthcheck: false
        });

        await usersTf.start();
        await otherTf.start();
        try {
            const usersResponse = await usersTf.request(new HttpRequest('GET', '/openapi.json'));
            const otherResponse = await otherTf.request(new HttpRequest('GET', '/openapi.json'));

            assert.ok(usersResponse.json.paths['/users']);
            assert.equal(usersResponse.json.paths['/other'], undefined);
            assert.ok(otherResponse.json.paths['/other']);
            assert.equal(otherResponse.json.paths['/users'], undefined);
        } finally {
            await otherTf.stop();
            await usersTf.stop();
        }
    });

    it('does not serve /openapi.json for production apps unless enabled', async () => {
        const tf = TestingHelpers.createTestingFacade({
            config: ProductionConfig,
            controllers: [OpenApiUsersController],
            enableHealthcheck: false
        });

        await tf.start();
        try {
            assert.equal((await tf.request(new HttpRequest('GET', '/openapi.json'))).statusCode, 404);
            assert.equal((await tf.request(new HttpRequest('GET', '/openapi.yaml'))).statusCode, 404);
        } finally {
            await tf.stop();
        }
    });

    it('applies OpenAPI route flag precedence across environments', () => {
        assert.equal(shouldExposeOpenApi({ APP_ENV: 'development' } as BaseAppConfig), true);
        assert.equal(shouldExposeOpenApi({ APP_ENV: 'test' } as BaseAppConfig), true);
        assert.equal(shouldExposeOpenApi({ APP_ENV: 'production' } as BaseAppConfig), false);
        assert.equal(shouldExposeOpenApi({ APP_ENV: 'production', ENABLE_OPENAPI_ROUTE: true, ENABLE_OPENAPI_SCHEMA: false } as BaseAppConfig), true);
        assert.equal(
            shouldExposeOpenApi({ APP_ENV: 'development', ENABLE_OPENAPI_ROUTE: false, ENABLE_OPENAPI_SCHEMA: true } as BaseAppConfig),
            false
        );
        assert.equal(shouldExposeOpenApi({ APP_ENV: 'production', ENABLE_OPENAPI_SCHEMA: true } as BaseAppConfig), true);
        assert.equal(shouldExposeOpenApi({ APP_ENV: 'development', ENABLE_OPENAPI_SCHEMA: false } as BaseAppConfig), false);
        assert.equal(shouldExposeOpenApi({ APP_ENV: 'production', ENABLE_OPENAPI_ROUTE: '1' } as any), true);
        assert.equal(shouldExposeOpenApi({ APP_ENV: 'development', ENABLE_OPENAPI_ROUTE: '0' } as any), false);
    });

    it('serves OpenAPI routes in production with explicit route opt-in', async () => {
        const tf = TestingHelpers.createTestingFacade({
            config: ProductionOpenApiRouteConfig,
            controllers: [OpenApiUsersController],
            enableHealthcheck: false
        });

        await tf.start();
        try {
            assert.equal((await tf.request(HttpRequest.GET('/openapi.json'))).statusCode, 200);
            assert.equal((await tf.request(HttpRequest.GET('/openapi.yaml'))).statusCode, 200);
        } finally {
            await tf.stop();
        }
    });

    it('dumps OpenAPI YAML to disk', async () => {
        const app = createApp({
            controllers: [OpenApiUsersController],
            enableHealthcheck: false
        });
        const dir = await mkdtemp(join(tmpdir(), 'tsf-openapi-'));
        tempDirs.push(dir);
        const outputPath = join(dir, 'openapi.yaml');

        assert.equal(await dumpOpenApiSchema(app, { path: outputPath, title: 'Unit API', version: '1.2.3' }), outputPath);
        const yaml = await readFile(outputPath, 'utf8');

        assert.match(yaml, /openapi: 3\.1\.0/);
        assert.match(yaml, /title: Unit API/);
        assert.match(yaml, /OpenApiCreateUserBody/);
    });

    it('dumps openapi.yaml from startup without blocking startup when enabled', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'tsf-openapi-startup-'));
        tempDirs.push(dir);
        process.chdir(dir);

        const app = createApp({
            config: OpenApiDumpConfig,
            controllers: [OpenApiUsersController],
            enableHealthcheck: false
        });

        await app.start();
        await delay(350);
        try {
            const yaml = await readFile(join(dir, 'openapi.yaml'), 'utf8');
            assert.match(yaml, /openapi: 3\.1\.0/);
            assert.match(yaml, /OpenApiUserDto/);
        } finally {
            await app.stop();
        }
    });

    it('matches startup dump gating across NODE_TEST_CONTEXT and explicit schema flags', () => {
        const originalNodeTestContext = Env.NODE_TEST_CONTEXT;
        try {
            delete Env.NODE_TEST_CONTEXT;
            assert.equal(shouldDumpOpenApiSchema({ APP_ENV: 'development' } as BaseAppConfig), true);
            assert.equal(shouldDumpOpenApiSchema({ APP_ENV: 'test' } as BaseAppConfig), false);
            assert.equal(shouldDumpOpenApiSchema({ APP_ENV: 'production' } as BaseAppConfig), false);

            Env.NODE_TEST_CONTEXT = 'child-v8';
            assert.equal(shouldDumpOpenApiSchema({ APP_ENV: 'development' } as BaseAppConfig), false);
            assert.equal(shouldDumpOpenApiSchema({ APP_ENV: 'development', ENABLE_OPENAPI_SCHEMA: true } as BaseAppConfig), true);
            assert.equal(shouldDumpOpenApiSchema({ APP_ENV: 'development', ENABLE_OPENAPI_SCHEMA: false } as BaseAppConfig), false);
            assert.equal(shouldDumpOpenApiSchema({ APP_ENV: 'production', ENABLE_OPENAPI_SCHEMA: '1' } as any), true);
            assert.equal(shouldDumpOpenApiSchema({ APP_ENV: 'development', ENABLE_OPENAPI_SCHEMA: '0' } as any), false);
        } finally {
            Env.NODE_TEST_CONTEXT = originalNodeTestContext;
        }
    });
});

function schemaObject(value: OpenApiSchemaObject | OpenApiReferenceObject | undefined): OpenApiSchemaObject {
    assert.ok(value);
    assert.equal('$ref' in value, false);
    return value as OpenApiSchemaObject;
}

function referenceObject(value: OpenApiSchemaObject | OpenApiReferenceObject | undefined): OpenApiReferenceObject {
    assert.ok(value);
    assert.equal('$ref' in value, true);
    return value as OpenApiReferenceObject;
}

function resolveSchemaObject(
    doc: { components?: { schemas?: Record<string, OpenApiSchemaObject> } },
    value: OpenApiSchemaObject | OpenApiReferenceObject | undefined
): OpenApiSchemaObject {
    if (value && '$ref' in value) return schemaObject(schemaForRef(doc, value.$ref));
    return schemaObject(value);
}

function schemaForRef(doc: { components?: { schemas?: Record<string, OpenApiSchemaObject> } }, ref: string): OpenApiSchemaObject | undefined {
    return doc.components?.schemas?.[ref.split('/').at(-1) ?? ''];
}

function schemaAlternatives(
    doc: { components?: { schemas?: Record<string, OpenApiSchemaObject> } },
    value: OpenApiSchemaObject | OpenApiReferenceObject | boolean | undefined
): OpenApiSchemaObject[] {
    if (!value || typeof value === 'boolean') return [];
    const schema = resolveSchemaObject(doc, value);
    const composed = [...(schema.oneOf ?? []), ...(schema.anyOf ?? []), ...(schema.allOf ?? [])];
    if (composed.length === 0) return [schema];
    return composed.flatMap(item => schemaAlternatives(doc, item));
}

function collectDiscriminatorValues(
    doc: { components?: { schemas?: Record<string, OpenApiSchemaObject> } },
    value: OpenApiSchemaObject | OpenApiReferenceObject | undefined,
    propertyName: string
): Set<string> {
    const values = new Set<string>();
    for (const schema of schemaAlternatives(doc, value)) {
        for (const propertySchema of schemaAlternatives(doc, schema.properties?.[propertyName])) {
            for (const item of propertySchema.enum ?? []) {
                if (typeof item === 'string') values.add(item);
            }
        }
    }
    return values;
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
