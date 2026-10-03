import { repos } from '../repositories/index.js';

const DIM = 1024;

/**
 * Deterministic feature-hashing embedding (no external dependency). Interface-compatible with a
 * provider embedding: swap embed() and create an Atlas Vector Search index on `chunks.embedding`
 * to move retrieval server-side. Until then cosine similarity is computed in-process.
 */
export function embed(text) {
  const v = new Array(DIM).fill(0);
  for (const raw of String(text).toLowerCase().match(/[a-z0-9₹]+/g) ?? []) {
    const tok = raw.length > 3 ? raw.replace(/(ing|ed|es|s)$/, '') : raw;
    let h = 2166136261;
    for (let i = 0; i < tok.length; i += 1) { h ^= tok.charCodeAt(i); h = Math.imul(h, 16777619); }
    v[Math.abs(h) % DIM] += h & 1 ? 1 : -1;
  }
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
}
const cos = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);

const chunk = (body, size = 600) => {
  const out = [];
  for (let i = 0; i < body.length; i += size) out.push(body.slice(i, i + size));
  return out.length ? out : [''];
};

export async function addDocument(tenantId, { title, kind, body }, actor) {
  const chunks = chunk(body).map((text, i) => ({ i, text, embedding: embed(`${title} ${text}`) }));
  return repos.knowledge.insert(tenantId, { title, kind, body, chunks, createdBy: actor });
}

export async function searchKnowledge(tenantId, q, limit = 5) {
  const qv = embed(q);
  const docs = await repos.knowledge.find(tenantId, {}, { limit: 200 });
  return docs
    .flatMap((d) => d.chunks.map((c) => ({ docId: d._id, title: d.title, kind: d.kind, text: c.text, score: Math.round(cos(qv, c.embedding) * 1000) / 1000 })))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
