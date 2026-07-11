import type { IncomingMessage, ServerResponse } from 'node:http';

import type { PrometheusExporter } from '@opentelemetry/exporter-prometheus';

import { http, HttpRequest, rawResponse, type RawResponseResult } from '../../http';
import { OtelState } from './helpers';

@http.controller('/metrics')
export class MetricsController {
    @http.GET()
    async getMetrics(request: HttpRequest): Promise<RawResponseResult> {
        // Authorization must use the transport peer, not optionally trusted
        // forwarding headers that an external caller can spoof.
        const ip = request.socket.remoteAddress ?? request.remoteAddress;
        if (!isPrivateLanIp(ip)) {
            return rawResponse('Forbidden', { statusCode: 403, contentType: 'text/plain' });
        }

        if (!OtelState.prometheusExporter) {
            return rawResponse('Metrics not available', { statusCode: 503, contentType: 'text/plain' });
        }

        const metrics = await collectPrometheusMetrics(OtelState.prometheusExporter);
        return rawResponse(metrics.body, { statusCode: metrics.statusCode, headers: metrics.headers });
    }
}

function isPrivateLanIp(ip: string): boolean {
    if (ip.startsWith('::ffff:')) ip = ip.slice(7);

    if (ip.startsWith('10.')) return true;
    if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(ip)) return true;
    if (ip.startsWith('192.168.')) return true;
    if (ip.startsWith('127.')) return true;

    if (ip === '::1') return true;
    if (/^f[cd][0-9a-f]{2}:/i.test(ip)) return true;
    if (/^fe[89ab][0-9a-f]:/i.test(ip)) return true;

    return false;
}

function collectPrometheusMetrics(exporter: PrometheusExporter): Promise<{
    statusCode: number;
    headers: Record<string, string | number | string[]>;
    body: Buffer;
}> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        const headers: Record<string, string | number | string[]> = {};
        const response = {
            statusCode: 200,
            setHeader(name: string, value: string | number | string[]) {
                headers[name.toLowerCase()] = value;
            },
            end(chunk?: string | Uint8Array) {
                if (chunk !== undefined) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                resolve({
                    statusCode: this.statusCode,
                    headers,
                    body: Buffer.concat(chunks)
                });
            }
        };

        try {
            exporter.getMetricsRequestHandler({ url: '/metrics' } as IncomingMessage, response as unknown as ServerResponse);
        } catch (error) {
            reject(error);
        }
    });
}
