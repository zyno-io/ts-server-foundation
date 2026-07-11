import type { TypeAnnotation } from '../reflection';

export type HttpBody<T> = T & TypeAnnotation<'httpBody', { type: T }>;
export type HttpQueries<T> = T & TypeAnnotation<'httpQueries', { type: T }>;
export type HttpQuery<T, Options extends { name?: string } = {}> = T & TypeAnnotation<'httpQuery', Options & { type: T }>;
export type HttpPath<T, Options extends { name?: string } = {}> = T & TypeAnnotation<'httpPath', Options & { type: T }>;
export type HttpHeader<T, Options extends { name?: string } = {}> = T & TypeAnnotation<'httpHeader', Options & { type: T }>;
