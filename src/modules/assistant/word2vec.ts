/**
 * A small, dependency-free word2vec (skip-gram with negative sampling) plus the
 * text utilities the help assistant needs. No LLM and no network calls: the
 * vectors are trained locally on the knowledge base and a domain synonym
 * corpus, so the whole thing is deterministic and runs in about a second.
 *
 * Sentence / chunk embeddings use SIF weighting (smooth inverse frequency,
 * Arora et al. 2017): a weighted average of word vectors where frequent words
 * count less, followed by removing the shared "common" direction so chunks are
 * not all similar to each other.
 */

export interface Word2VecParams {
  dim: number;
  window: number;
  negatives: number;
  epochs: number;
  learningRate: number;
  seed: number;
}

export const DEFAULT_W2V_PARAMS: Word2VecParams = {
  dim: 48,
  window: 4,
  negatives: 5,
  epochs: 60,
  learningRate: 0.03,
  seed: 1337,
};

// ---- Text processing --------------------------------------------------------

const STOPWORDS = new Set(
  (
    'a an the and or but if then of to in on at by for with from as is are was were be been being am ' +
    'i me my mine we us our you your yours he she it they them their this that these those there here ' +
    'do does did doing done can could would should will shall may might must have has had having ' +
    'what which who whom whose when where why how please want need like get got go going able ' +
    'some any all just so too very also not no yes ok okay hi hello hey thanks thank about into up ' +
    'way find show see let tell know help'
  ).split(' ')
);

/** Light suffix stripping so "appointments"/"booking"/"booked" share a stem. */
export function stem(word: string): string {
  let w = word;
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed') && !w.endsWith('eed')) w = w.slice(0, -2);
  else if (w.length > 4 && /(ches|shes|xes|sses)$/.test(w)) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !/(ss|us|is)$/.test(w)) w = w.slice(0, -1);
  // Drop a trailing silent "e" so share/shared/sharing all become "shar".
  if (w.length > 4 && w.endsWith('e') && !w.endsWith('ee')) w = w.slice(0, -1);
  return w;
}

/** Lowercase, split on non-alphanumerics, drop stopwords, stem. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/x-ray/g, 'xray')
    .replace(/e-mail/g, 'email')
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t) && !/^\d+$/.test(t))
    .map(stem);
}

// ---- Deterministic RNG ------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- Training ---------------------------------------------------------------

export interface WordVectors {
  dim: number;
  vectors: Map<string, Float32Array>;
  /** Unigram probability of each word in the training corpus (for SIF). */
  freq: Map<string, number>;
}

const sigmoid = (x: number) => (x > 8 ? 1 : x < -8 ? 0 : 1 / (1 + Math.exp(-x)));

/** Train skip-gram negative-sampling word vectors on tokenized sentences. */
export function trainWord2Vec(sentences: string[][], params: Word2VecParams = DEFAULT_W2V_PARAMS): WordVectors {
  const rand = mulberry32(params.seed);
  const counts = new Map<string, number>();
  let total = 0;
  for (const s of sentences) for (const w of s) { counts.set(w, (counts.get(w) ?? 0) + 1); total++; }
  const vocab = [...counts.keys()].sort();
  const index = new Map(vocab.map((w, i) => [w, i]));
  const V = vocab.length;
  const D = params.dim;

  const inVec = new Float32Array(V * D);
  const outVec = new Float32Array(V * D);
  for (let i = 0; i < inVec.length; i++) inVec[i] = (rand() - 0.5) / D;

  // Negative-sampling table: unigram distribution raised to 3/4.
  const TABLE = 100_000;
  const table = new Int32Array(TABLE);
  const pow = vocab.map((w) => Math.pow(counts.get(w)!, 0.75));
  const powSum = pow.reduce((a, b) => a + b, 0);
  let cum = pow[0] / powSum;
  for (let t = 0, i = 0; t < TABLE; t++) {
    table[t] = i;
    if (t / TABLE > cum && i < V - 1) { i++; cum += pow[i] / powSum; }
  }

  const ids = sentences.map((s) => s.map((w) => index.get(w)!));
  const grad = new Float32Array(D);
  const steps = params.epochs * ids.length;
  let step = 0;

  for (let epoch = 0; epoch < params.epochs; epoch++) {
    for (const sent of ids) {
      const lr = Math.max(params.learningRate * (1 - step++ / steps), params.learningRate * 0.0001);
      for (let pos = 0; pos < sent.length; pos++) {
        const center = sent[pos];
        const win = 1 + Math.floor(rand() * params.window);
        for (let c = Math.max(0, pos - win); c <= Math.min(sent.length - 1, pos + win); c++) {
          if (c === pos) continue;
          const context = sent[c];
          const ci = context * D;
          grad.fill(0);
          for (let n = 0; n <= params.negatives; n++) {
            let target: number;
            let label: number;
            if (n === 0) { target = center; label = 1; }
            else { target = table[Math.floor(rand() * TABLE)]; if (target === center) continue; label = 0; }
            const ti = target * D;
            let dot = 0;
            for (let d = 0; d < D; d++) dot += inVec[ci + d] * outVec[ti + d];
            const g = (label - sigmoid(dot)) * lr;
            for (let d = 0; d < D; d++) {
              grad[d] += g * outVec[ti + d];
              outVec[ti + d] += g * inVec[ci + d];
            }
          }
          for (let d = 0; d < D; d++) inVec[ci + d] += grad[d];
        }
      }
    }
  }

  const vectors = new Map<string, Float32Array>();
  const freq = new Map<string, number>();
  vocab.forEach((w, i) => {
    vectors.set(w, inVec.slice(i * D, (i + 1) * D));
    freq.set(w, counts.get(w)! / total);
  });
  return { dim: D, vectors, freq };
}

// ---- Sentence embeddings ----------------------------------------------------

const SIF_A = 1e-3;

/** SIF-weighted average of the known word vectors (not yet centered). Null if no known words. */
export function rawSentenceVector(tokens: string[], wv: WordVectors): Float32Array | null {
  const out = new Float32Array(wv.dim);
  let used = 0;
  for (const t of tokens) {
    const v = wv.vectors.get(t);
    if (!v) continue;
    const weight = SIF_A / (SIF_A + (wv.freq.get(t) ?? 0));
    for (let d = 0; d < wv.dim; d++) out[d] += weight * v[d];
    used++;
  }
  if (!used) return null;
  for (let d = 0; d < wv.dim; d++) out[d] /= used;
  return out;
}

/** Remove the shared component, then L2-normalize. */
export function finalizeVector(v: Float32Array, common: Float32Array): Float32Array {
  const out = new Float32Array(v.length);
  let proj = 0;
  for (let d = 0; d < v.length; d++) proj += v[d] * common[d];
  let norm = 0;
  for (let d = 0; d < v.length; d++) { out[d] = v[d] - proj * common[d]; norm += out[d] * out[d]; }
  norm = Math.sqrt(norm) || 1;
  for (let d = 0; d < v.length; d++) out[d] /= norm;
  return out;
}

/** Unit vector of the mean of many vectors (the "common direction"). */
export function commonDirection(vectors: Float32Array[], dim: number): Float32Array {
  const mean = new Float32Array(dim);
  for (const v of vectors) for (let d = 0; d < dim; d++) mean[d] += v[d];
  let norm = 0;
  for (let d = 0; d < dim; d++) norm += mean[d] * mean[d];
  norm = Math.sqrt(norm) || 1;
  for (let d = 0; d < dim; d++) mean[d] /= norm;
  return mean;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let d = 0; d < a.length; d++) dot += a[d] * b[d];
  return dot; // both are unit vectors
}

export function toBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

export function fromBlob(b: Buffer): Float32Array {
  // Copy into fresh memory: a Buffer slice may not be 4-byte aligned.
  const out = new Float32Array(b.byteLength / 4);
  new Uint8Array(out.buffer).set(b);
  return out;
}
