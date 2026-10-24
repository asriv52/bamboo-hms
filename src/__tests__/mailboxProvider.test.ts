import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../core/config';
import { sendEmail } from '../transport/email/sender';
import * as mailbox from '../transport/email/mailbox';

/**
 * Integration: with EMAIL_PROVIDER=mailbox the single provider boundary
 * (sender.ts) captures outbound email into the in-memory mailbox store.
 */
describe('mailbox email provider', () => {
  const original = config.emailProvider;

  beforeEach(() => {
    mailbox.clear();
    config.emailProvider = 'mailbox';
  });

  afterEach(() => {
    config.emailProvider = original;
  });

  it('captures a sent email into the mailbox store', async () => {
    await sendEmail({
      to: 'Patient@Example.com',
      subject: 'Your clinic registration is confirmed',
      html: '<p>Welcome</p>',
      text: 'Welcome',
    });

    const captured = mailbox.list();
    expect(captured).toHaveLength(1);
    expect(captured[0].to).toBe('patient@example.com'); // normalized
    expect(captured[0].subject).toBe('Your clinic registration is confirmed');
    expect(captured[0].html).toBe('<p>Welcome</p>');
    expect(mailbox.recipients()).toEqual(['patient@example.com']);
  });
});
