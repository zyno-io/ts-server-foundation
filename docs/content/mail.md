# Mail

Email sending via Postmark or SMTP with a template system.

## Setup

`MailService` is automatically registered by `createApp()`. Configure via environment variables:

```bash
# Provider selection
MAIL_PROVIDER=smtp   # or 'postmark'
MAIL_FROM=noreply@example.com
MAIL_FROM_NAME="My App"

# SMTP
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=apikey
SMTP_PASSWORD_SECRET=secret
SMTP_TLS=true

# Postmark
POSTMARK_SECRET=your-api-token
```

## Sending Emails

### Direct Send

```typescript
import { MailService } from '@zyno-io/ts-server-foundation';

class NotificationService {
    constructor(private mail: MailService) {}

    async sendConfirmation(recipient: { id: string; email: string; name: string }) {
        await this.mail.send({
            to: { address: recipient.email, name: recipient.name },
            subject: 'Confirmation',
            message: `<h1>Your request #${recipient.id} has been received.</h1>`,
            plainMessage: `Your request #${recipient.id} has been received.`
        });
    }
}
```

### Template Send

```typescript
import { MailService } from '@zyno-io/ts-server-foundation';

async function sendWelcome(mail: MailService) {
    await mail.sendFromTemplate({
        to: { address: 'user@example.com' },
        template: WelcomeEmail,
        data: { name: 'Alice', loginUrl: 'https://app.example.com/login' }
    });
}
```

### Prepared Messages

Prepare a message without sending (useful for previews or queuing):

```typescript
import { MailService } from '@zyno-io/ts-server-foundation';

function preparePreviews(mail: MailService) {
    const prepared = mail.prepare({
        to: { address: 'user@example.com' },
        subject: 'Hello',
        message: '<h1>Hello</h1>'
    });

    const preparedFromTemplate = mail.prepareFromTemplate({
        to: { address: 'user@example.com' },
        template: WelcomeEmail,
        data: { name: 'Alice', loginUrl: 'https://app.example.com/login' }
    });

    return { prepared, preparedFromTemplate };
}
```

## Templates

Create email templates by extending `MailTemplate`:

```typescript
import { MailTemplate } from '@zyno-io/ts-server-foundation';

class WelcomeEmail extends MailTemplate<{ name: string; loginUrl: string }> {
    subject = 'Welcome to Our App!';

    generateHtml() {
        return `
            <h1>Welcome, ${this.data.name}!</h1>
            <p>Get started by <a href="${this.data.loginUrl}">logging in</a>.</p>
        `;
    }

    generateText() {
        return `Welcome, ${this.data.name}! Log in at: ${this.data.loginUrl}`;
    }
}
```

### `MailTemplate<T>`

| Property / Method | Type             | Description                          |
| ----------------- | ---------------- | ------------------------------------ |
| `subject`         | `string`         | Email subject line (abstract)        |
| `data`            | `T`              | Template data (set by the framework) |
| `generateHtml()`  | `string`         | HTML body (abstract)                 |
| `generateText()`  | `string \| void` | Plain text body (optional)           |

## Message Properties

### `MessageProperties`

| Property       | Type                                     | Required | Description                      |
| -------------- | ---------------------------------------- | -------- | -------------------------------- |
| `to`           | `{ address: string; name?: string }`     | Yes      | Recipient                        |
| `from`         | `{ address: string; name?: string }`     | No       | Sender (defaults to `MAIL_FROM`) |
| `replyTo`      | `{ address: string; name?: string }`     | No       | Reply-to address                 |
| `subject`      | `string`                                 | Yes      | Subject line                     |
| `message`      | `string`                                 | Yes      | HTML body                        |
| `plainMessage` | `string`                                 | No       | Plain text body                  |
| `attachments`  | `{ name, content, contentType, cid? }[]` | No       | File attachments                 |

### `TemplateMessageProperties<T>`

| Property   | Type                                 | Required | Description    |
| ---------- | ------------------------------------ | -------- | -------------- |
| `to`       | `{ address: string; name?: string }` | Yes      | Recipient      |
| `template` | `ClassType<MailTemplate<T>>`         | Yes      | Template class |
| `data`     | `T`                                  | Yes      | Template data  |

## Providers

### SMTP

Uses nodemailer. Configured via `SMTP_*` environment variables.

### Postmark

Uses the Postmark API. Configured via `POSTMARK_SECRET`.

Both providers implement the `MailProvider` interface:

```typescript
interface MailProvider {
    send(message: PreparedMessageProperties): Promise<string>;
}
```

The return value is a provider-specific message ID.

## Configuration

| Variable               | Type      | Default     | Description                    |
| ---------------------- | --------- | ----------- | ------------------------------ |
| `MAIL_PROVIDER`        | `string`  | `smtp`      | Provider: `smtp` or `postmark` |
| `MAIL_FROM`            | `string`  | —           | Default sender address         |
| `MAIL_FROM_NAME`       | `string`  | —           | Default sender name            |
| `SMTP_HOST`            | `string`  | `127.0.0.1` | SMTP host                      |
| `SMTP_PORT`            | `number`  | `1025`      | SMTP port                      |
| `SMTP_USER`            | `string`  | —           | SMTP username                  |
| `SMTP_PASSWORD_SECRET` | `string`  | —           | SMTP password                  |
| `SMTP_TLS`             | `boolean` | `false`     | Enable TLS                     |
| `POSTMARK_SECRET`      | `string`  | —           | Postmark API token             |
