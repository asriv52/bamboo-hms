import type { OutboundEmail } from './sender';

/**
 * In-memory virtual mailbox — a testing sink for outbound email.
 *
 * When EMAIL_PROVIDER=mailbox, sender.ts captures each email here instead of
 * printing it or sending it over SMTP. The dev-only /mailbox web page reads
 * from this store and groups messages per recipient so you can read the full
 * rendered emails the HMS flows produce (registration, visit summary,
 * prescription, staff invite, OTP) without any external provider.
 *
 * This module is deliberately dependency-free: no DB, no core imports. It holds
 * state in a module-level array, so the mailbox resets on every server restart.
 * It must never be used as a real transport in production — captured emails
 * contain PII and the store has no persistence or access control.
 */

export interface CapturedEmail {
  id: number;
  to: string;
  subject: string;
  html: string;
  text: string;
  capturedAt: string; // ISO-8601 UTC
}

let nextId = 1;
const messages: CapturedEmail[] = [];

/** Capture an outbound email into the in-memory store. */
export function capture(email: OutboundEmail): CapturedEmail {
  const captured: CapturedEmail = {
    id: nextId++,
    to: (email.to || '').trim().toLowerCase(),
    subject: email.subject,
    html: email.html,
    text: email.text,
    capturedAt: new Date().toISOString(),
  };
  messages.push(captured);
  return captured;
}

/** All captured emails, newest first. */
export function list(): CapturedEmail[] {
  return messages.slice().reverse();
}

/** Distinct recipient addresses, ordered by most recently captured. */
export function recipients(): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const msg of list()) {
    if (!seen.has(msg.to)) {
      seen.add(msg.to);
      ordered.push(msg.to);
    }
  }
  return ordered;
}

/** Captured emails grouped by recipient address (each bucket newest first). */
export function listByRecipient(): Map<string, CapturedEmail[]> {
  const grouped = new Map<string, CapturedEmail[]>();
  for (const msg of list()) {
    const bucket = grouped.get(msg.to);
    if (bucket) {
      bucket.push(msg);
    } else {
      grouped.set(msg.to, [msg]);
    }
  }
  return grouped;
}

/** Captured emails for a single recipient address, newest first. */
export function listFor(to: string): CapturedEmail[] {
  const key = (to || '').trim().toLowerCase();
  return list().filter((m) => m.to === key);
}

/** Empty the store (used by the dev /mailbox/clear action and tests). */
export function clear(): void {
  messages.length = 0;
  nextId = 1;
}
