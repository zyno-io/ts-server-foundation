import { ServerClient } from 'postmark';

import type { MailPriority, MailProvider, PreparedMessageProperties } from '.';

import { BaseAppConfig } from '../../app/config';
import type { ScopedLogger } from '../logger';

export class PostmarkProvider implements MailProvider {
    private postmarkClient: ServerClient;

    constructor(
        private config: BaseAppConfig,
        private logger: ScopedLogger
    ) {
        if (!this.config.POSTMARK_SECRET) {
            throw new Error('POSTMARK_SECRET is not set');
        }
        const requestHost = this.config.POSTMARK_REQUEST_HOST;
        const options = requestHost ? { requestHost, useHttps: true } : undefined;
        this.postmarkClient = new ServerClient(this.config.POSTMARK_SECRET, options);
    }

    async send(message: PreparedMessageProperties): Promise<string> {
        const response = await this.postmarkClient.sendEmail({
            From: message.from,
            To: message.to,
            Subject: message.subject,
            HtmlBody: message.message,
            TextBody: message.plainMessage,
            ReplyTo: message.replyTo,
            Headers: this.priorityHeaders(message.priority),
            Attachments: message.attachments?.map(attachment => ({
                Name: attachment.name,
                Content: attachment.content.toString('base64'),
                ContentType: attachment.contentType,
                ContentID: attachment.cid ?? null,
                ContentLength: attachment.content.length
            }))
        });
        return response.MessageID;
    }

    private priorityHeaders(priority: MailPriority | undefined): Array<{ Name: string; Value: string }> | undefined {
        if (!priority || priority === 'normal') return undefined;

        const high = priority === 'high';
        return [
            { Name: 'Importance', Value: high ? 'High' : 'Low' },
            { Name: 'X-Priority', Value: high ? '1' : '5' },
            { Name: 'X-MSMail-Priority', Value: high ? 'High' : 'Low' }
        ];
    }
}
