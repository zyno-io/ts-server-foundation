import { createTransport } from 'nodemailer';

import type { MailProvider, PreparedMessageProperties } from '.';

import { BaseAppConfig } from '../../app/config';
import type { ScopedLogger } from '../logger';

export class SmtpProvider implements MailProvider {
    private transporter: ReturnType<typeof createTransport>;

    constructor(
        private config: BaseAppConfig,
        private logger: ScopedLogger
    ) {
        if (!this.config.SMTP_HOST) {
            throw new Error('SMTP_HOST is not set');
        }
        this.transporter = createTransport({
            host: this.config.SMTP_HOST,
            port: this.config.SMTP_PORT,
            secure: this.config.SMTP_TLS,
            auth: this.config.SMTP_USER
                ? {
                      user: this.config.SMTP_USER,
                      pass: this.config.SMTP_PASSWORD_SECRET
                  }
                : undefined
        });
    }

    async send(message: PreparedMessageProperties): Promise<string> {
        const response = await this.transporter.sendMail({
            from: message.from,
            to: message.to,
            subject: message.subject,
            html: message.message,
            text: message.plainMessage,
            replyTo: message.replyTo,
            attachments: message.attachments?.map(attachment => ({
                filename: attachment.name,
                content: attachment.content,
                contentType: attachment.contentType,
                cid: attachment.cid
            }))
        });
        return response.messageId;
    }
}
