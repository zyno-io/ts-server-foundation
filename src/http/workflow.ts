import { EventToken } from '../events';
import type { HttpRoutePlan } from './router';
import type { HttpRequest } from './request';
import type { HttpResponse } from './response';

export class HttpWorkflowToken<TEvent> extends EventToken<TEvent> {
    declare readonly event: TEvent;
}

export interface HttpWorkflowEvent {
    request: HttpRequest;
    response: HttpResponse;
    sent: boolean;
    hasNext(): boolean;
    send(response: Response | string | Buffer): Promise<void>;
}

export interface HttpRouteWorkflowEvent extends HttpWorkflowEvent {
    route?: HttpRoutePlan;
}

export interface HttpControllerWorkflowEvent extends HttpRouteWorkflowEvent {}
export interface HttpResponseWorkflowEvent extends HttpRouteWorkflowEvent {}
export interface HttpRouteNotFoundWorkflowEvent extends HttpWorkflowEvent {}

export const httpWorkflow = {
    onRoute: new HttpWorkflowToken<HttpRouteWorkflowEvent>('http.route'),
    onController: new HttpWorkflowToken<HttpControllerWorkflowEvent>('http.controller'),
    onResponse: new HttpWorkflowToken<HttpResponseWorkflowEvent>('http.response'),
    onRouteNotFound: new HttpWorkflowToken<HttpRouteNotFoundWorkflowEvent>('http.route-not-found')
};

export function createHttpWorkflowEvent(
    request: HttpRequest,
    response: HttpResponse,
    options: { route?: HttpRoutePlan; hasNext?: () => boolean } = {}
): HttpWorkflowEvent {
    return {
        request,
        response,
        get sent() {
            return response.writableEnded;
        },
        hasNext: options.hasNext ?? (() => false),
        send: async value => {
            if (value instanceof Response) {
                response.statusCode = value.status;
                value.headers.forEach((headerValue, headerName) => response.setHeader(headerName, headerValue));
                response.end(Buffer.from(await value.arrayBuffer()));
                return;
            }
            response.end(value);
        },
        ...(options.route ? { route: options.route } : {})
    };
}
