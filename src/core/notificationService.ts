import { db, nowUtc } from './db';
import { render, TemplateName } from './templates';
import { sendEmail } from '../transport/email/sender';
import { NotificationJob } from './types';

/**
 * The single notification service. No module sends email directly — they call
 * enqueue(). The triggering action (registration, visit finalize) must never
 * fail because email failed: we persist a job first, then attempt to send. A
 * send failure leaves a queued/failed job for retry; it does not throw to the
 * caller.
 */

const MAX_ATTEMPTS = 5;

export function enqueueEmail(
  template: TemplateName,
  toEmail: string,
  payload: Record<string, any>
): number {
  const info = db
    .prepare(
      `INSERT INTO notification_jobs (template, to_email, payload, status, attempts, created_at)
       VALUES (?, ?, ?, 'queued', 0, ?)`
    )
    .run(template, toEmail, JSON.stringify(payload), nowUtc());
  const id = Number(info.lastInsertRowid);
  // Fire-and-forget: attempt immediately but never block or throw to caller.
  void attemptSend(id);
  return id;
}

async function attemptSend(jobId: number): Promise<void> {
  const row = db.prepare('SELECT * FROM notification_jobs WHERE id = ?').get(jobId) as any;
  if (!row || row.status === 'sent') return;
  const payload = JSON.parse(row.payload);
  try {
    const rendered = render(row.template as TemplateName, row.to_email, payload);
    await sendEmail({
      to: row.to_email,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });
    db.prepare('UPDATE notification_jobs SET status = ?, attempts = attempts + 1 WHERE id = ?').run(
      'sent',
      jobId
    );
  } catch (err: any) {
    const attempts = row.attempts + 1;
    const status = attempts >= MAX_ATTEMPTS ? 'failed' : 'queued';
    db.prepare(
      'UPDATE notification_jobs SET status = ?, attempts = ?, last_error = ? WHERE id = ?'
    ).run(status, attempts, String(err?.message ?? err), jobId);
  }
}

/** Retry all still-queued jobs (e.g. call on a timer or when transport recovers). */
export async function retryQueued(): Promise<void> {
  const rows = db
    .prepare("SELECT id FROM notification_jobs WHERE status = 'queued'")
    .all() as any[];
  for (const r of rows) {
    await attemptSend(r.id);
  }
}

export function listJobs(limit = 50): NotificationJob[] {
  return db
    .prepare(
      `SELECT id, template, to_email as toEmail, payload, status, attempts,
              last_error as lastError, created_at as createdAt
       FROM notification_jobs ORDER BY id DESC LIMIT ?`
    )
    .all(limit) as NotificationJob[];
}
