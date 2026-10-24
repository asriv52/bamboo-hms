import { beforeEach, describe, expect, it } from 'vitest';
import {
  capture,
  clear,
  list,
  listByRecipient,
  listFor,
  recipients,
} from '../transport/email/mailbox';

function make(to: string, subject: string) {
  return { to, subject, html: `<p>${subject}</p>`, text: subject };
}

describe('virtual mailbox store', () => {
  beforeEach(() => clear());

  it('assigns incrementing ids and a UTC timestamp on capture', () => {
    const a = capture(make('p@example.com', 'first'));
    const b = capture(make('p@example.com', 'second'));
    expect(a.id).toBe(1);
    expect(b.id).toBe(2);
    expect(a.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    // Preserves the rendered content verbatim.
    expect(a.subject).toBe('first');
    expect(a.html).toBe('<p>first</p>');
    expect(a.text).toBe('first');
  });

  it('normalizes recipient addresses to lowercase and trims them', () => {
    const c = capture(make('  Mixed.Case@Example.COM ', 'hi'));
    expect(c.to).toBe('mixed.case@example.com');
  });

  it('lists newest first', () => {
    capture(make('p@example.com', 'first'));
    capture(make('p@example.com', 'second'));
    capture(make('p@example.com', 'third'));
    expect(list().map((m) => m.subject)).toEqual(['third', 'second', 'first']);
  });

  it('buckets emails by lowercased recipient', () => {
    capture(make('patient@example.com', 'reg'));
    capture(make('PATIENT@example.com', 'visit')); // same recipient, different case
    capture(make('invitee@clinic.dev', 'invite'));

    const grouped = listByRecipient();
    expect(grouped.size).toBe(2);
    expect(grouped.get('patient@example.com')!.map((m) => m.subject)).toEqual([
      'visit',
      'reg',
    ]);
    expect(grouped.get('invitee@clinic.dev')!.map((m) => m.subject)).toEqual(['invite']);

    expect(recipients()).toEqual(['invitee@clinic.dev', 'patient@example.com']);
    expect(listFor('Patient@Example.com').map((m) => m.subject)).toEqual(['visit', 'reg']);
  });

  it('clear empties the store and resets ids', () => {
    capture(make('p@example.com', 'first'));
    clear();
    expect(list()).toEqual([]);
    expect(recipients()).toEqual([]);
    const after = capture(make('p@example.com', 'again'));
    expect(after.id).toBe(1);
  });
});
