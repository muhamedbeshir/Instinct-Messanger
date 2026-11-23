import { q } from './db.js';
import { normalizeAr, tokens, now } from './util.js';

export function searchKnowledge(query, limit = 4) {
  const toks = tokens(query);
  if (!toks.length) return [];
  const scored = [];
  for (const k of q.all(`SELECT * FROM knowledge WHERE status='approved'`)) {
    const hay = normalizeAr(`${k.question} ${k.answer}`);
    const qn = normalizeAr(k.question);
    let s = 0;
    for (const t of toks) { if (qn.includes(t)) s += 2; else if (hay.includes(t)) s += 1; }
    if (s >= Math.max(2, Math.ceil(toks.length * 0.5))) scored.push({ k, s });
  }
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, limit).map((x) => x.k);
}

export function addKnowledge({ question, answer, status = 'approved', source = 'manual' }) {
  const r = q.run('INSERT INTO knowledge(question,answer,status,source,created_at) VALUES(?,?,?,?,?)', String(question).trim(), String(answer).trim(), status, source, now());
  return Number(r.lastInsertRowid);
}

export function markUsed(ids) { for (const id of ids) q.run('UPDATE knowledge SET uses=uses+1 WHERE id=?', id); }

/** يحفظ معلومة جديدة من إجابة صاحب المتجر. explicit=true لما يجاوب مباشرة على سؤال معلّق */
export function learn(question, answer, { explicit = false } = {}) {
  const mode = q.get(`SELECT value FROM settings WHERE key='learning'`);
  const m = mode ? (JSON.parse(mode.value).mode || 'review') : 'review';
  if (m === 'off') return null;
  const status = explicit || m === 'auto' ? 'approved' : 'pending';
  return addKnowledge({ question, answer, status, source: 'learned' });
}
