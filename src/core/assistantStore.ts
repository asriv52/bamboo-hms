import { db, nowUtc } from './db';

/**
 * Core data access for the help assistant: the retrieval index (features,
 * role mapping, embedded chunks, word vectors) and the log of unanswered
 * requests. No authorization here; callers decide who may read what.
 */

export interface KbFeatureRow {
  key: string;
  kind: 'feature' | 'restriction';
  title: string;
  summary: string;
  path: string | null;
  steps: string[];
}

export interface KbChunkRow {
  featureKey: string;
  source: 'title' | 'summary' | 'example';
  text: string;
  vector: Buffer;
}

export interface KbIndexData {
  features: KbFeatureRow[];
  roles: Array<{ featureKey: string; role: string }>;
  chunks: KbChunkRow[];
  words: Array<{ word: string; freq: number; vector: Buffer }>;
}

export function getKbMeta(key: string): string | null {
  const row = db.prepare('SELECT value FROM kb_meta WHERE key = ?').get(key) as any;
  return row ? row.value : null;
}

/** Atomically replace the whole retrieval index. */
export function replaceKbIndex(data: KbIndexData, meta: Record<string, string>): void {
  const tx = db.transaction(() => {
    db.exec('DELETE FROM kb_chunks; DELETE FROM kb_feature_roles; DELETE FROM kb_features; DELETE FROM kb_word_vectors;');
    const f = db.prepare('INSERT INTO kb_features (key, kind, title, summary, path, steps) VALUES (?, ?, ?, ?, ?, ?)');
    for (const r of data.features) f.run(r.key, r.kind, r.title, r.summary, r.path, JSON.stringify(r.steps));
    const fr = db.prepare('INSERT INTO kb_feature_roles (feature_key, role) VALUES (?, ?)');
    for (const r of data.roles) fr.run(r.featureKey, r.role);
    const c = db.prepare('INSERT INTO kb_chunks (feature_key, source, text, vector) VALUES (?, ?, ?, ?)');
    for (const r of data.chunks) c.run(r.featureKey, r.source, r.text, r.vector);
    const w = db.prepare('INSERT INTO kb_word_vectors (word, freq, vector) VALUES (?, ?, ?)');
    for (const r of data.words) w.run(r.word, r.freq, r.vector);
    const m = db.prepare('INSERT INTO kb_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    for (const [k, v] of Object.entries(meta)) m.run(k, v);
  });
  tx();
}

export function loadKbIndex(): KbIndexData {
  const features = (db.prepare('SELECT * FROM kb_features').all() as any[]).map((r) => ({
    key: r.key,
    kind: r.kind,
    title: r.title,
    summary: r.summary,
    path: r.path,
    steps: JSON.parse(r.steps) as string[],
  }));
  const roles = (db.prepare('SELECT feature_key, role FROM kb_feature_roles').all() as any[]).map((r) => ({
    featureKey: r.feature_key,
    role: r.role,
  }));
  const chunks = (db.prepare('SELECT feature_key, source, text, vector FROM kb_chunks ORDER BY id').all() as any[]).map(
    (r) => ({ featureKey: r.feature_key, source: r.source, text: r.text, vector: r.vector as Buffer })
  );
  const words = (db.prepare('SELECT word, freq, vector FROM kb_word_vectors').all() as any[]).map((r) => ({
    word: r.word,
    freq: r.freq,
    vector: r.vector as Buffer,
  }));
  return { features, roles, chunks, words };
}

// ---- Unanswered-request log -------------------------------------------------

export type AssistantRequestOutcome = 'missing' | 'unclear' | 'other_role';

export interface AssistantRequestRow {
  id: number;
  role: string;
  query: string;
  outcome: AssistantRequestOutcome;
  bestFeatureKey: string | null;
  bestScore: number | null;
  createdAt: string;
}

export function insertAssistantRequest(input: {
  role: string;
  query: string;
  outcome: AssistantRequestOutcome;
  bestFeatureKey: string | null;
  bestScore: number | null;
}): void {
  db.prepare(
    `INSERT INTO assistant_requests (role, query, outcome, best_feature_key, best_score, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(input.role, input.query, input.outcome, input.bestFeatureKey, input.bestScore, nowUtc());
}

export function listAssistantRequests(limit = 200): AssistantRequestRow[] {
  return (
    db.prepare('SELECT * FROM assistant_requests ORDER BY id DESC LIMIT ?').all(limit) as any[]
  ).map((r) => ({
    id: r.id,
    role: r.role,
    query: r.query,
    outcome: r.outcome,
    bestFeatureKey: r.best_feature_key,
    bestScore: r.best_score,
    createdAt: r.created_at,
  }));
}

export function countAssistantRequestsByRole(): Array<{ role: string; outcome: string; count: number }> {
  return db
    .prepare('SELECT role, outcome, COUNT(*) AS count FROM assistant_requests GROUP BY role, outcome ORDER BY count DESC')
    .all() as any[];
}
