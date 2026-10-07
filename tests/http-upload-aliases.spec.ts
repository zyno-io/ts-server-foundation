import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FileUpload, HttpBody, HttpRequest, ReflectionKind, createApp, http, serializeOpenApiSchema, typeOf } from '../src';
import type { GenericImageUpload, ImportedImageUpload } from './http-upload-alias.types';

type LocalImageUpload = FileUpload<{ maxSize: '128B'; allowedTypes: ['image/png'] }>;
type ChainedImageUpload = LocalImageUpload;
interface AliasedUploadBody {
    caption?: string;
    local?: LocalImageUpload[];
    imported?: ImportedImageUpload[];
    chained?: ChainedImageUpload[];
    generic?: GenericImageUpload<['image/png']>[];
}

@http.controller('/aliased-uploads')
class AliasedUploadController {
    @http.POST()
    upload(body: HttpBody<AliasedUploadBody>) {
        return {
            caption: body.caption ?? '',
            uploads: [body.local, body.imported, body.chained, body.generic].flatMap(files =>
                (files ?? []).map(file => ({ isUpload: file instanceof FileUpload, size: file.size, type: file.detectedType }))
            )
        };
    }

    @http.POST('/direct')
    direct(file: LocalImageUpload) {
        return { isUpload: file instanceof FileUpload, size: file.size, type: file.detectedType };
    }
}

const png = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
    'hex'
);
function uploadRequest(name: string, file = png, contentType = 'image/png') {
    return HttpRequest.POST('/aliased-uploads').multiPart([
        { name: '_payload', value: JSON.stringify({ caption: 'Picture' }) },
        { name, fileName: 'image.png', contentType, file }
    ]);
}

describe('FileUpload alias metadata', () => {
    it('keeps the actual constructor and generic upload policy through aliases', () => {
        for (const type of [
            typeOf<LocalImageUpload>(),
            typeOf<ImportedImageUpload>(),
            typeOf<ChainedImageUpload>(),
            typeOf<GenericImageUpload<['image/png']>>()
        ]) {
            assert.ok(type.kind === ReflectionKind.class);
            assert.equal(type.classType, FileUpload);
            assert.ok('typeArguments' in type && Array.isArray(type.typeArguments) && type.typeArguments.length === 1);
        }
    });

    it('binds a direct alias parameter as a FileUpload', async () => {
        const app = createApp({ controllers: [AliasedUploadController] });
        const request = HttpRequest.POST('/aliased-uploads/direct').multiPart([
            { name: 'file', fileName: 'image.png', contentType: 'image/png', file: png }
        ]);
        const response = await app.request(request);
        assert.equal(response.statusCode, 200);
        assert.deepEqual(response.json, { isUpload: true, size: png.length, type: 'image/png' });
    });

    for (const field of ['local', 'imported', 'chained', 'generic']) {
        it(`binds one and repeated ${field} alias uploads and accepts omitted optional arrays`, async () => {
            const app = createApp({ controllers: [AliasedUploadController] });
            const request = uploadRequest(field);
            const response = await app.request(request);
            assert.equal(response.statusCode, 200);
            assert.deepEqual(response.json, { caption: 'Picture', uploads: [{ isUpload: true, size: png.length, type: 'image/png' }] });
            const repeated = HttpRequest.POST('/aliased-uploads').multiPart(
                [1, 2].map(() => ({ name: field, fileName: 'image.png', contentType: 'image/png', file: png }))
            );
            const repeatedResponse = await app.request(repeated);
            assert.equal(repeatedResponse.statusCode, 200);
            assert.equal(repeatedResponse.json.uploads.length, 2);
            const omitted = await app.request(HttpRequest.POST('/aliased-uploads', { caption: 'Text' }));
            assert.equal(omitted.statusCode, 200);
            assert.deepEqual(omitted.json, { caption: 'Text', uploads: [] });
        });

        it(`enforces size and actual MIME for ${field} aliases`, async () => {
            const app = createApp({ controllers: [AliasedUploadController] });
            const oversized = await app.request(uploadRequest(field, Buffer.concat([png, Buffer.alloc(129)])));
            assert.equal(oversized.statusCode, 413);
            const disguised = await app.request(uploadRequest(field, Buffer.from('not an image')));
            assert.equal(disguised.statusCode, 415);
            const jpeg = await app.request(uploadRequest(field, Buffer.from('ffd8ffe000104a46494600010101006000600000ffdb004300', 'hex')));
            assert.equal(jpeg.statusCode, 415);
        });
    }

    it('describes aliases as binary file arrays with the same policy in OpenAPI', () => {
        const schema = serializeOpenApiSchema(createApp({ controllers: [AliasedUploadController] }));
        const content = schema.paths['/aliased-uploads'].post?.requestBody?.content;
        assert.ok(content?.['multipart/form-data']);
        const body = schema.components?.schemas?.AliasedUploadBody;
        assert.ok(body);
        for (const field of ['local', 'imported', 'chained', 'generic']) {
            assert.equal(content['multipart/form-data'].encoding?.[field].contentType, 'image/png');
            assert.deepEqual(body.properties?.[field], {
                type: 'array',
                items: { type: 'string', format: 'binary', 'x-maxSizeBytes': 128, 'x-allowedTypes': ['image/png'] }
            });
        }
    });
});
