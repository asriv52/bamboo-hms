import { config } from '../../core/config';
import * as mailbox from './mailbox';

/**
 * Concrete email transport. This is the ONLY place that talks to an email
 * provider, and it is invoked only by the core notification service.
 *
 * Default provider is 'console' — it prints the email to the server log so the
 * demo runs with zero external setup. Set EMAIL_PROVIDER=smtp to send for real
 * (SMTP wiring intentionally left minimal; plug in nodemailer here).
 */
export interface OutboundEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export async function sendEmail(email: OutboundEmail): Promise<void> {
  if (config.emailProvider === 'console') {
    // eslint-disable-next-line no-console
    console.log(
      `\n[email] to=${email.to}\n[email] subject=${email.subject}\n[email] ${email.text}\n`
    );
    return;
  }

  // Mailbox path: capture the email into the in-memory virtual mailbox so the
  // dev-only /mailbox page can display it. A testing sink, never a real
  // transport — it holds PII with no persistence or access control.
  if (config.emailProvider === 'mailbox') {
    mailbox.capture(email);
    return;
  }

  // SMTP path: wire a real transport here (e.g. nodemailer). Kept as an
  // explicit failure so a misconfigured demo doesn't silently drop mail.
  if (!config.smtp.host) {
    throw new Error('SMTP selected but SMTP_HOST is not configured.');
  }
  throw new Error(
    'SMTP transport is not wired in this prototype. Use EMAIL_PROVIDER=console for the demo.'
  );
}
