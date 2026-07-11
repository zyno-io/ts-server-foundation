import { BaseAppConfig } from '../../app/config';
import { toError } from '../../helpers';
import type { ClassType } from '../../types';
import { ScopedLogger } from '../logger';
import { PostmarkProvider } from './postmark';
import { SmtpProvider } from './smtp';

export abstract class MailTemplate<T> {
    constructor(protected data: T) {}
    abstract subject: string;
    abstract generateHtml(): string;
    generateText(): string | void {
        /** */
    }
}

export interface MessageProperties {
    from?: {
        name?: string;
        address: string;
    };
    to: {
        name?: string;
        address: string;
    };
    replyTo?: {
        name?: string;
        address: string;
    };
    subject: string;
    message: string;
    plainMessage?: string;
    attachments?: {
        name: string;
        content: Buffer;
        contentType: string;
        cid?: string;
    }[];
}

export interface TemplateMessageProperties<T> extends Omit<MessageProperties, 'subject' | 'message' | 'plainMessage'> {
    template: ClassType<MailTemplate<T>>;
    data: T;
}

export interface PreparedMessageProperties extends Omit<MessageProperties, 'to' | 'from' | 'replyTo'> {
    to: string;
    from: string;
    replyTo?: string;
}

export interface MailProvider {
    send(message: PreparedMessageProperties): Promise<string>;
}

export class MailService {
    provider: MailProvider;

    constructor(
        private config: BaseAppConfig,
        private logger: ScopedLogger
    ) {
        if (this.config.MAIL_PROVIDER === 'postmark') {
            this.provider = new PostmarkProvider(this.config, logger);
        } else if (this.config.MAIL_PROVIDER === 'smtp') {
            this.provider = new SmtpProvider(this.config, logger);
        } else {
            throw new Error('Unsupported mail provider');
        }
    }

    async send(params: MessageProperties) {
        const preparedParams = this.prepare(params);
        await this.sendPrepared(preparedParams);
    }

    async sendFromTemplate<T>(params: TemplateMessageProperties<T>) {
        const preparedParams = this.prepareFromTemplate(params);
        await this.sendPrepared(preparedParams);
    }

    prepare(params: MessageProperties): PreparedMessageProperties {
        const fromName = params.from?.name || this.config.MAIL_FROM_NAME;
        const fromAddressPrefix = fromName ? `"${fromName}${getSenderSuffix(this.config.APP_ENV)}" ` : '';
        const fromAddress = params.from?.address || this.config.MAIL_FROM;
        const replyToPrefix = params.replyTo?.name ? `"${params.replyTo.name}" ` : '';
        const toAddressPrefix = params.to.name ? `"${params.to.name}" ` : '';
        return {
            ...params,
            from: `${fromAddressPrefix}<${fromAddress}>`,
            to: `${toAddressPrefix}<${params.to.address}>`,
            replyTo: params.replyTo ? `${replyToPrefix}<${params.replyTo.address}>` : undefined,
            subject: `${getSubjectPrefix(this.config.APP_ENV)}${params.subject}`
        };
    }

    prepareFromTemplate<T>(params: TemplateMessageProperties<T>): PreparedMessageProperties {
        const tpl = new params.template(params.data);
        const message = tpl.generateHtml();
        const plainMessage = tpl.generateText() ?? undefined;
        return this.prepare({ ...params, message, plainMessage, subject: tpl.subject });
    }

    async sendPrepared(message: PreparedMessageProperties) {
        try {
            const messageId = await this.provider.send(message);
            this.logger.info('Email sent', { to: message.to, subject: message.subject, messageId });
        } catch (err) {
            this.logger.error('Failed to send email', err, { to: message.to, subject: message.subject });
            throw toError('Failed to send email', err);
        }
    }
}

function getSenderSuffix(appEnv: string): string {
    return appEnv !== 'production' ? ` (${appEnv}) ` : '';
}

function getSubjectPrefix(appEnv: string): string {
    return appEnv !== 'production' ? `[${appEnv}] ` : '';
}
