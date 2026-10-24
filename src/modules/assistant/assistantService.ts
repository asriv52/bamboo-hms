import { requireFeature } from '../../core/accessControl';
import {
  AssistantRequestOutcome,
  countAssistantRequestsByRole,
  getKbMeta,
  insertAssistantRequest,
  KbFeatureRow,
  listAssistantRequests,
  loadKbIndex,
  replaceKbIndex,
} from '../../core/assistantStore';
import { sha256Hex } from '../../core/crypto';
import { Actor } from '../../core/types';
import { ValidationError } from '../../core/validation';
import { ASSISTANT_ROLES, AssistantRole, DOMAIN_CORPUS, KNOWLEDGE_BASE } from './knowledgeBase';
import {
  commonDirection,
  cosine,
  DEFAULT_W2V_PARAMS,
  finalizeVector,
  fromBlob,
  rawSentenceVector,
  toBlob,
  tokenize,
  trainWord2Vec,
  WordVectors,
} from './word2vec';

/**
 * Help assistant: retrieval over a role-scoped knowledge base using locally
 * trained word2vec embeddings (no LLM).
 *
 *   index build:  knowledge base + synonym corpus -> word2vec -> SIF chunk
 *                 vectors -> SQLite (kb_* tables)
 *   query:        embed the question the same way -> cosine similarity against
 *                 the chunks of the features the user's class may use -> best
 *                 feature -> its stored instruction path
 *
 * When nothing in the user's class matches, the (redacted) question is logged
 * to assistant_requests so the team can see which features are missing.
 */

// Chunk score = W_EMBED * cosine * coverage + W_LEXICAL * idf-weighted overlap.
//   cosine:   word2vec sentence similarity (handles synonyms / paraphrases)
//   coverage: share of the question's words the model knows; unknown words
//             would otherwise be dropped silently and inflate the score
//   overlap:  exact (stemmed) word matches, weighted by rarity
const W_EMBED = 0.6;
const W_LEXICAL = 0.4;
// Thresholds on that score, tuned on held-out example questions.
const ANSWER_AT = 0.45;
const SUGGEST_AT = 0.32;
// Saying "another role handles that" on a weak match would mislead, so the
// cross-role match must be clearly stronger.
const OTHER_ROLE_AT = 0.6;
const RELATED_WITHIN = 0.06;
const MAX_QUERY_CHARS = 300;
const INDEX_FORMAT = 2;

// ---- Index build / load -----------------------------------------------------

function indexFingerprint(): string {
  return sha256Hex(JSON.stringify({ INDEX_FORMAT, KNOWLEDGE_BASE, DOMAIN_CORPUS, DEFAULT_W2V_PARAMS }));
}

interface LoadedIndex {
  version: string;
  wv: WordVectors;
  common: Float32Array;
  features: Map<string, KbFeatureRow>;
  roleFeatures: Map<string, Set<string>>;
  featureRoles: Map<string, string[]>;
  chunks: Array<{ featureKey: string; vector: Float32Array; tokens: Set<string> }>;
  /** Inverse document frequency of each stem across chunks. */
  idf: Map<string, number>;
  /** IDF used for words never seen in any chunk. */
  unknownIdf: number;
}

let cache: LoadedIndex | null = null;

/** Train word vectors and (re)write the whole retrieval index. */
export function buildAssistantIndex(): { features: number; chunks: number; vocabulary: number; ms: number } {
  const started = Date.now();
  const sentences: string[][] = [];
  for (const e of KNOWLEDGE_BASE) {
    for (const text of [e.title, e.summary, ...e.examples, ...e.steps]) {
      const t = tokenize(text);
      if (t.length) sentences.push(t);
    }
  }
  for (const line of DOMAIN_CORPUS) sentences.push(tokenize(line));
  const wv = trainWord2Vec(sentences, DEFAULT_W2V_PARAMS);

  const raw: Array<{ featureKey: string; source: 'title' | 'summary' | 'example'; text: string; v: Float32Array }> = [];
  for (const e of KNOWLEDGE_BASE) {
    const parts: Array<['title' | 'summary' | 'example', string]> = [
      ['title', e.title],
      ['summary', e.summary],
      ...e.examples.map((x) => ['example', x] as ['example', string]),
    ];
    for (const [source, text] of parts) {
      const v = rawSentenceVector(tokenize(text), wv);
      if (v) raw.push({ featureKey: e.key, source, text, v });
    }
  }
  const common = commonDirection(raw.map((r) => r.v), wv.dim);

  replaceKbIndex(
    {
      features: KNOWLEDGE_BASE.map((e) => ({
        key: e.key, kind: e.kind, title: e.title, summary: e.summary, path: e.path, steps: e.steps,
      })),
      roles: KNOWLEDGE_BASE.flatMap((e) => e.roles.map((role) => ({ featureKey: e.key, role }))),
      chunks: raw.map((r) => ({
        featureKey: r.featureKey, source: r.source, text: r.text, vector: toBlob(finalizeVector(r.v, common)),
      })),
      words: [...wv.vectors.entries()].map(([word, v]) => ({ word, freq: wv.freq.get(word) ?? 0, vector: toBlob(v) })),
    },
    {
      index_version: indexFingerprint(),
      common_vector: toBlob(common).toString('base64'),
      dim: String(wv.dim),
      built_at: new Date().toISOString(),
    }
  );
  cache = null;
  return { features: KNOWLEDGE_BASE.length, chunks: raw.length, vocabulary: wv.vectors.size, ms: Date.now() - started };
}

/** Build the index if it is missing or out of date (knowledge base changed). */
export function ensureAssistantIndex(): boolean {
  if (getKbMeta('index_version') === indexFingerprint()) return false;
  buildAssistantIndex();
  return true;
}

function loadIndex(): LoadedIndex {
  const version = indexFingerprint();
  if (cache && cache.version === version) return cache;
  ensureAssistantIndex();
  const data = loadKbIndex();
  const dim = Number(getKbMeta('dim'));
  const vectors = new Map<string, Float32Array>();
  const freq = new Map<string, number>();
  for (const w of data.words) {
    vectors.set(w.word, fromBlob(w.vector));
    freq.set(w.word, w.freq);
  }
  const roleFeatures = new Map<string, Set<string>>();
  const featureRoles = new Map<string, string[]>();
  for (const r of data.roles) {
    if (!roleFeatures.has(r.role)) roleFeatures.set(r.role, new Set());
    roleFeatures.get(r.role)!.add(r.featureKey);
    featureRoles.set(r.featureKey, [...(featureRoles.get(r.featureKey) ?? []), r.role]);
  }
  const chunks = data.chunks.map((c) => ({
    featureKey: c.featureKey,
    vector: fromBlob(c.vector),
    tokens: new Set(tokenize(c.text)),
  }));
  const df = new Map<string, number>();
  for (const c of chunks) for (const t of c.tokens) df.set(t, (df.get(t) ?? 0) + 1);
  const n = chunks.length;
  const idf = new Map<string, number>();
  for (const [t, d] of df) idf.set(t, Math.log(1 + n / d));
  cache = {
    version,
    wv: { dim, vectors, freq },
    common: fromBlob(Buffer.from(getKbMeta('common_vector') ?? '', 'base64')),
    features: new Map(data.features.map((f) => [f.key, f])),
    roleFeatures,
    featureRoles,
    chunks,
    idf,
    unknownIdf: Math.log(1 + n),
  };
  return cache;
}

// ---- Retrieval ---------------------------------------------------------------

export interface Ranked {
  key: string;
  score: number;
}

/**
 * Rank features for a query: score every chunk (embedding similarity scaled
 * by vocabulary coverage, plus IDF-weighted word overlap) and keep each
 * feature's best chunk.
 */
export function rankFeatures(query: string, allowed?: Set<string>): Ranked[] {
  const idx = loadIndex();
  const qTokens = [...new Set(tokenize(query))];
  if (!qTokens.length) return [];
  const raw = rawSentenceVector(qTokens, idx.wv);
  if (!raw) return [];
  const q = finalizeVector(raw, idx.common);
  // Unknown words soften the score instead of zeroing it: "move my appointment
  // to friday" should still find appointments, but a question made mostly of
  // unknown words ("weather today") should not.
  const coverage = 0.25 + 0.75 * (qTokens.filter((t) => idx.wv.vectors.has(t)).length / qTokens.length);
  // Unknown words keep full (maximum) weight in the overlap denominator, so a
  // question about something the knowledge base never mentions scores low.
  const weight = (t: string) => idx.idf.get(t) ?? idx.unknownIdf;
  const qWeight = qTokens.reduce((s, t) => s + weight(t), 0);

  const best = new Map<string, number>();
  for (const c of idx.chunks) {
    if (allowed && !allowed.has(c.featureKey)) continue;
    const overlap = qTokens.reduce((s, t) => s + (c.tokens.has(t) ? weight(t) : 0), 0) / qWeight;
    const s = W_EMBED * Math.max(0, cosine(q, c.vector)) * coverage + W_LEXICAL * overlap;
    if (s > (best.get(c.featureKey) ?? -Infinity)) best.set(c.featureKey, s);
  }
  return [...best.entries()].map(([key, score]) => ({ key, score })).sort((a, b) => b.score - a.score);
}

// ---- Answering -----------------------------------------------------------------

export type AssistantOutcome =
  | 'answered'
  | 'restricted'
  | 'sign_in'
  | 'other_role'
  | 'unclear'
  | 'missing'
  | 'greeting'
  | 'emergency';

export interface AssistantReply {
  outcome: AssistantOutcome;
  role: AssistantRole;
  title: string | null;
  message: string;
  steps: string[];
  link: { href: string; label: string } | null;
  suggestions: Array<{ key: string; title: string }>;
  score: number | null;
}

const EMERGENCY_RE =
  /\b(emergency|chest pain|can'?t breathe|cannot breathe|not breathing|unconscious|heavy bleeding|bleeding heavily|stroke|heart attack|overdose|suicid\w*|kill myself|seizure)\b/i;
const GREETING_RE = /^\s*(hi|hello|hey|help|menu|start|what can you do|what can i do|options)\W*$/i;

const ROLE_LABEL: Record<AssistantRole, string> = {
  Visitor: 'visitor',
  Patient: 'patient',
  Receptionist: 'receptionist',
  Doctor: 'doctor',
  Admin: 'admin',
  Pharmacy: 'pharmacy',
  Technician: 'technician',
};

/** Strip things that identify people before a question is stored. */
export function redactQuery(q: string): string {
  return q
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, '[email]')
    .replace(/\bRCPT-[A-Z0-9]{3,}\b/gi, '[code]')
    .replace(/\bWR-[0-9A-F]{6,}\b/gi, '[code]')
    .replace(/\+?\d[\d\s().-]{6,}\d/g, '[number]')
    .replace(/\d{4,}/g, '[number]')
    .slice(0, MAX_QUERY_CHARS);
}

function featureFor(role: AssistantRole, key: string): KbFeatureRow | null {
  const idx = loadIndex();
  return idx.roleFeatures.get(role)?.has(key) ? idx.features.get(key) ?? null : null;
}

function suggestionsFor(role: AssistantRole, keys: string[]): Array<{ key: string; title: string }> {
  return keys
    .map((k) => featureFor(role, k))
    .filter((f): f is KbFeatureRow => !!f)
    .map((f) => ({ key: f.key, title: f.title }));
}

/** The first few real features of a role, for the greeting / fallback menu. */
function starterKeys(role: AssistantRole, n = 6): string[] {
  const allowed = loadIndex().roleFeatures.get(role) ?? new Set<string>();
  return KNOWLEDGE_BASE.filter((e) => e.kind === 'feature' && allowed.has(e.key)).slice(0, n).map((e) => e.key);
}

function answer(role: AssistantRole, f: KbFeatureRow, score: number | null, related: string[]): AssistantReply {
  return {
    outcome: f.kind === 'restriction' ? 'restricted' : 'answered',
    role,
    title: f.title,
    message: f.summary,
    steps: f.steps,
    link: f.path ? { href: f.path, label: `Go to ${f.title}` } : null,
    suggestions: suggestionsFor(role, related),
    score: score === null ? null : Math.round(score * 100) / 100,
  };
}

function log(role: AssistantRole, query: string, outcome: AssistantRequestOutcome, best: Ranked | undefined): void {
  insertAssistantRequest({
    role,
    query: redactQuery(query),
    outcome,
    bestFeatureKey: best?.key ?? null,
    bestScore: best ? Math.round(best.score * 1000) / 1000 : null,
  });
}

/**
 * Answer a question for a user class. `role` must come from the server-side
 * session, never from the client. Passing `featureKey` (a clicked suggestion)
 * returns that feature directly, if the class may use it.
 */
export function askAssistant(role: AssistantRole, input: { q?: unknown; featureKey?: unknown }): AssistantReply {
  if (!ASSISTANT_ROLES.includes(role)) throw new ValidationError('Unknown user type.');
  const idx = loadIndex();
  const allowed = idx.roleFeatures.get(role) ?? new Set<string>();

  if (typeof input.featureKey === 'string' && input.featureKey) {
    const f = featureFor(role, input.featureKey);
    if (!f) throw new ValidationError('That topic is not available for your account.');
    return answer(role, f, null, []);
  }

  const q = typeof input.q === 'string' ? input.q.trim() : '';
  if (!q) throw new ValidationError('Please type a question.');
  if (q.length > MAX_QUERY_CHARS) throw new ValidationError(`Please keep questions under ${MAX_QUERY_CHARS} characters.`);

  if (EMERGENCY_RE.test(q)) {
    return {
      outcome: 'emergency', role, title: 'This may be an emergency',
      message: 'If someone is in danger, call your local emergency number now or go straight to the Emergency ward. This assistant cannot help with medical emergencies.',
      steps: [], link: null, suggestions: [], score: null,
    };
  }

  const greet = (message: string, outcome: AssistantOutcome = 'greeting'): AssistantReply => ({
    outcome, role, title: null, message, steps: [], link: null,
    suggestions: suggestionsFor(role, starterKeys(role)), score: null,
  });
  if (GREETING_RE.test(q)) {
    return greet(`Hi! I can guide you to anything your ${ROLE_LABEL[role]} account can do. Ask a question, or pick a topic:`);
  }

  const ranked = rankFeatures(q, allowed);
  const best = ranked[0];
  if (!best) {
    // Nothing recognizable (only stopwords / unknown words).
    log(role, q, 'missing', undefined);
    return greet("Sorry, I didn't understand that. I've noted the question for the team. Try different words, or pick a topic:", 'missing');
  }

  if (best.score >= ANSWER_AT) {
    const related = ranked
      .slice(1, 4)
      .filter((r) => r.score >= Math.max(SUGGEST_AT, best.score - RELATED_WITHIN))
      .slice(0, 2)
      .map((r) => r.key);
    return answer(role, idx.features.get(best.key)!, best.score, related);
  }

  // Not in this class. Is it something another class can do?
  const other = rankFeatures(q).find((r) => !allowed.has(r.key) && idx.features.get(r.key)?.kind === 'feature');
  if (other && other.score >= OTHER_ROLE_AT && other.score > best.score) {
    const owners = (idx.featureRoles.get(other.key) ?? []) as AssistantRole[];
    const feature = idx.features.get(other.key)!;
    if (role === 'Visitor') {
      const forPatients = owners.includes('Patient');
      return {
        outcome: 'sign_in', role, title: feature.title,
        message: forPatients
          ? `"${feature.title}" is available to patients after signing in to the patient portal.`
          : `"${feature.title}" is available to clinic staff after signing in.`,
        steps: forPatients
          ? ['Open the patient portal.', 'Enter your email and the one-time code we email you.', `Then ask me again about "${feature.title}".`]
          : ['Open the staff sign-in page.', 'Sign in with your work email and password.'],
        link: forPatients ? { href: '/portal', label: 'Patient sign-in' } : { href: '/login', label: 'Staff sign-in' },
        suggestions: [], score: Math.round(other.score * 100) / 100,
      };
    }
    log(role, q, 'other_role', other);
    const ownerText = owners.map((r) => ROLE_LABEL[r]).join(' / ');
    return {
      outcome: 'other_role', role, title: feature.title,
      message: `"${feature.title}" is handled by the ${ownerText} role and is not part of your ${ROLE_LABEL[role]} access. I've noted your request for the team.`,
      steps: [], link: null,
      suggestions: suggestionsFor(role, ranked.slice(0, 3).filter((r) => r.score >= SUGGEST_AT).map((r) => r.key)),
      score: Math.round(other.score * 100) / 100,
    };
  }

  if (best.score >= SUGGEST_AT) {
    log(role, q, 'unclear', best);
    return {
      outcome: 'unclear', role, title: null,
      message: "I'm not sure I found the right thing. Did you mean one of these?",
      steps: [], link: null,
      suggestions: suggestionsFor(role, ranked.slice(0, 3).map((r) => r.key)),
      score: Math.round(best.score * 100) / 100,
    };
  }

  log(role, q, 'missing', best);
  return greet(
    `I couldn't find a feature for that in your ${ROLE_LABEL[role]} access. I've logged the request so the team can consider adding it. Here is what I can help with:`,
    'missing'
  );
}

// ---- Admin: improvement log ----------------------------------------------------

export function getAssistantRequestLog(actor: Actor) {
  requireFeature(actor, 'assistant.requests');
  return { summary: countAssistantRequestsByRole(), rows: listAssistantRequests(200) };
}
