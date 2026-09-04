import { Injectable, Logger } from '@nestjs/common';

/**
 * Outbound message delivery (email / SMS).
 *
 * A provider seam, not a vendor integration. Password reset is unusable without
 * *some* delivery, and gating the whole flow behind an SMTP account nobody has
 * in development means the flow never gets exercised until production.
 *
 * Three providers, chosen by environment:
 *   SMTP_URL / SMS_PROVIDER set → real delivery (wire your vendor in `send`)
 *   NODE_ENV=test               → in-memory outbox the suite asserts against
 *   otherwise                   → logged to stdout, clearly marked as not sent
 *
 * The dev provider deliberately does NOT print the code itself. A reset code in
 * a log file is a reset code in whatever aggregates that log — the operator can
 * read it from the test endpoint instead, which only exists under NODE_ENV=test.
 */

export interface OutboundMessage {
  to: string;
  channel: 'email' | 'sms';
  subject?: string;
  body: string;
  /** Never logged, never included in the dev output. */
  sensitive?: Record<string, string>;
}

export interface DeliveryResult {
  delivered: boolean;
  provider: string;
  id?: string;
  error?: string;
}

@Injectable()
export class DeliveryService {
  private readonly log = new Logger('Delivery');
  /** Test transport only. Cleared between tests via the test endpoint. */
  readonly outbox: (OutboundMessage & { at: string })[] = [];

  get provider(): 'smtp' | 'test' | 'dev' {
    if (process.env.NODE_ENV === 'test') return 'test';
    if (process.env.SMTP_URL || process.env.SMS_PROVIDER) return 'smtp';
    return 'dev';
  }

  async send(msg: OutboundMessage): Promise<DeliveryResult> {
    switch (this.provider) {
      case 'test':
        this.outbox.push({ ...msg, at: new Date().toISOString() });
        return { delivered: true, provider: 'test', id: `test-${this.outbox.length}` };

      case 'smtp':
        try {
          // Real delivery. nodemailer for email; wire an SMS vendor here.
          const nodemailer = await import('nodemailer');
          const transport = nodemailer.createTransport(process.env.SMTP_URL!);
          const info = await transport.sendMail({
            from: process.env.MAIL_FROM ?? 'SNAPX <no-reply@snapx.local>',
            to: msg.to,
            subject: msg.subject ?? 'SNAPX',
            text: msg.body,
          });
          return { delivered: true, provider: 'smtp', id: info.messageId };
        } catch (err) {
          // Surfaced to the caller, which decides whether to fail the request.
          // A reset that reports success while the email bounced is worse than
          // an honest error.
          this.log.error(`delivery failed: ${(err as Error).message}`);
          return { delivered: false, provider: 'smtp', error: (err as Error).message };
        }

      default:
        // Recipient and subject only — never the code.
        this.log.log(
          `[not-sent] ${msg.channel} to ${redact(msg.to)}: "${msg.subject ?? msg.body.slice(0, 40)}" ` +
          `(set SMTP_URL to deliver for real)`);
        return { delivered: true, provider: 'dev' };
    }
  }

  clearOutbox() { this.outbox.length = 0; }
}

/** a***a@example.com — enough to identify the row, not enough to harvest. */
function redact(to: string): string {
  const [name, domain] = to.split('@');
  if (!domain) return to.slice(0, 2) + '***';
  return `${name[0]}***${name.at(-1) ?? ''}@${domain}`;
}
