import type { HttpRequest } from './request';

export * from './decorators';
export * from './cors';
export * from './errors';
export * from './middleware';
export * from './request';
export * from './response';
export * from './router';
export * from './store';
export * from './types';
export * from './auth';
export * from './base';
export * from './context';
export * from './uploads';
export * from './request-logging';
export * from './parameter-resolvers';
export * from './startup-logging';
export * from './static-files';
export * from './upgrade';
export * from './workflow';

export const OkResponse = { ok: true };
export type OkResponse = Promise<{ ok: true }>;
export type RedirectResponse = Promise<void>;
export type EmptyResponse = Promise<void>;
export type AnyResponse = Promise<any>;
export type RequestBuilder = HttpRequest;
