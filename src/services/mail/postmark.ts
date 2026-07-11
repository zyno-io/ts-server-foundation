import { ServerClient } from 'postmark';

import type { MailProvider, PreparedMessageProperties } from '.';

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
        this.postmarkClient = new ServerClient(this.config.POSTMARK_SECRET);
    }

    async send(message: PreparedMessageProperties): Promise<string> {
        const response = await this.postmarkClient.sendEmail({
            From: message.from,
            To: message.to,
            Subject: message.subject,
            HtmlBody: message.message,
            TextBody: message.plainMessage,
            ReplyTo: message.replyTo,
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
}
