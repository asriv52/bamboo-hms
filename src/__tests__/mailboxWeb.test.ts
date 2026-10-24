import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

/**
 * The /mailbox routes are gated at module-load time by NODE_ENV. We use
 * resetModules + dynamic import so each case imports a fresh router/app that
 * sees the NODE_ENV we set for that case.
 */
async function freshApp() {
  vi.resetModules();
  const { createApp } = await import('../transport/web/app');
  const mailbox = await import('../transport/email/mailbox');
  return { app: createApp(), mailbox };
}

describe('dev-only virtual mailbox web page', () => {
  const originalEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
    vi.resetModules();
  });

  it('serves /mailbox outside production with a tab and subject for a captured recipient', async () => {
    process.env.NODE_ENV = 'development';
    const { app, mailbox } = await freshApp();
    mailbox.clear();
    mailbox.capture({
      to: 'patient@example.com',
      subject: 'Your clinic registration is confirmed',
      html: '<p>Welcome</p>',
      text: 'Welcome',
    });

    const res = await request(app).get('/mailbox');
    expect(res.status).toBe(200);
    expect(res.text).toContain('patient@example.com'); // tab for the recipient
    expect(res.text).toContain('Your clinic registration is confirmed'); // subject shown
  });

  it('does not mount /mailbox in production (404)', async () => {
    process.env.NODE_ENV = 'production';
    const { app } = await freshApp();
    const res = await request(app).get('/mailbox');
    expect(res.status).toBe(404);
  });
});
