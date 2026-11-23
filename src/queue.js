import { q, getSetting } from './db.js';
import { now, parseJSON, withTimeout } from './util.js';
import { currentTenantId, runInTenant } from './tenancy.js';
import { allTenantIds } from './platform.js';
import * as logger from './logger.js';

/**
 * طابور شغل دائم (جوه قاعدة كل عميل): بيحمي من ضياع الرسائل لو السيرفر وقع أو الضغط زاد.
 * - كل محادثة بتتعالج واحدة واحدة (مفيش رديّن متداخلين لنفس العميل).
 * - إعادة محاولة تلقائية مع تأخير متزايد.
 * - رسائل العميل المتتابعة بتتجمّع في رد واحد (debounce).
 * - بيمرّ بس على العملاء اللي عندهم شغل فعلًا ("hot")، فعدد العملاء الكبير ما بيبطّئش.
 */
const handlers = new Map();
const busy = new Set();            // `${tenant}:${conversation}`
const hot = new Set();             // عملاء عندهم مهام معلّقة
let active = 0;
const MAX_CONCURRENT = 8;
let timer = null;

export function registerHandler(kind, fn, { onFail, timeoutMs = 120000 } = {}) { handlers.set(kind, { fn, onFail, timeoutMs }); }

export function enqueue({ kind, payload = {}, conversationId = null, delayMs = 0 }) {
  const r = q.run('INSERT INTO jobs(kind, conversation_id, payload, run_at, created_at) VALUES(?,?,?,?,?)',
    kind, conversationId, JSON.stringify(payload), now() + delayMs, now());
  hot.add(currentTenantId());
  return Number(r.lastInsertRowid);
}

/** يجدول رد على المحادثة. لو فيه رد مستني بالفعل، بيأجّله (عشان نجمع رسائل العميل) */
export function enqueueReply(conversationId, delayMs = getSetting('bot.debounce_ms', 2500)) {
  const existing = q.get(`SELECT id FROM jobs WHERE kind='reply' AND conversation_id=? AND status='pending'`, conversationId);
  if (existing) { q.run('UPDATE jobs SET run_at=? WHERE id=?', now() + delayMs, existing.id); hot.add(currentTenantId()); return existing.id; }
  return enqueue({ kind: 'reply', conversationId, delayMs });
}

export function queueStats() {
  const rows = q.all('SELECT status, COUNT(*) AS n FROM jobs GROUP BY status');
  const out = { pending: 0, running: 0, failed: 0, done: 0 };
  for (const r of rows) out[r.status] = r.n;
  out.oldest_pending_ms = (() => { const r = q.get(`SELECT MIN(run_at) AS t FROM jobs WHERE status='pending'`); return r?.t ? Math.max(0, now() - r.t) : 0; })();
  return out;
}

async function runJob(tid, job) {
  const h = handlers.get(job.kind);
  const payload = parseJSON(job.payload, {});
  try {
    await runInTenant(tid, async () => {
      try {
        if (!h) throw new Error(`no handler for job kind ${job.kind}`);
        await withTimeout(Promise.resolve(h.fn(payload, job)), h.timeoutMs, `job ${job.kind}`);
        q.run(`UPDATE jobs SET status='done' WHERE id=?`, job.id);
      } catch (e) {
        const attempts = job.attempts + 1;
        const max = getSetting('bot.max_attempts', 3);
        logger.error('queue', `job ${job.id} (${job.kind}) failed attempt ${attempts}/${max}: ${e.message}`);
        if (attempts >= max) {
          q.run(`UPDATE jobs SET status='failed', attempts=?, last_error=? WHERE id=?`, attempts, String(e.message).slice(0, 500), job.id);
          try { await h?.onFail?.(payload, job, e); } catch (e2) { logger.error('queue', `onFail ${job.kind}: ${e2.message}`); }
        } else {
          q.run(`UPDATE jobs SET status='pending', attempts=?, last_error=?, run_at=? WHERE id=?`, attempts, String(e.message).slice(0, 500), now() + 2000 * 2 ** attempts, job.id);
        }
      }
    });
  } finally {
    if (job.conversation_id) busy.delete(`${tid}:${job.conversation_id}`);
    active--;
    hot.add(tid); // قد يكون فيه شغل تاني أو إعادة محاولة
  }
}

async function tickTenant(tid) {
  const due = runInTenant(tid, () => q.all(`SELECT * FROM jobs WHERE status='pending' AND run_at<=? ORDER BY run_at, id LIMIT 30`, now()));
  for (const job of due) {
    if (active >= MAX_CONCURRENT) break;
    if (job.conversation_id && busy.has(`${tid}:${job.conversation_id}`)) continue;
    runInTenant(tid, () => q.run(`UPDATE jobs SET status='running' WHERE id=? AND status='pending'`, job.id));
    if (job.conversation_id) busy.add(`${tid}:${job.conversation_id}`);
    active++;
    runJob(tid, job);
  }
  const left = runInTenant(tid, () => q.get(`SELECT COUNT(*) AS n FROM jobs WHERE status IN ('pending','running')`).n);
  if (!left) hot.delete(tid);
}

export async function tick() {
  if (active >= MAX_CONCURRENT) return;
  for (const tid of [...hot]) { try { await tickTenant(tid); } catch (e) { logger.error('queue', `tick t${tid}: ${e.message}`); hot.delete(tid); } }
}

export function startWorker() {
  // رجّع الشغل اللي وقف بسبب إعادة تشغيل، وحدّد العملاء اللي عندهم شغل
  for (const tid of allTenantIds()) {
    try {
      runInTenant(tid, () => {
        q.run(`UPDATE jobs SET status='pending' WHERE status='running'`);
        if (q.get(`SELECT COUNT(*) AS n FROM jobs WHERE status='pending'`).n) hot.add(tid);
      });
    } catch (e) { logger.error('queue', `recover t${tid}: ${e.message}`); }
  }
  timer = setInterval(() => { tick().catch((e) => logger.error('queue', e.message)); }, 400);
  timer.unref?.();
  const gc = setInterval(() => {
    for (const tid of allTenantIds()) { try { runInTenant(tid, () => q.run(`DELETE FROM jobs WHERE status='done' AND created_at<?`, now() - 24 * 3600 * 1000)); } catch { /* */ } }
  }, 3600 * 1000);
  gc.unref();
}
export function stopWorker() { if (timer) clearInterval(timer); timer = null; }
export async function drain(timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await tick();
    let pending = 0;
    for (const tid of hot) pending += runInTenant(tid, () => q.get(`SELECT COUNT(*) AS n FROM jobs WHERE status IN ('pending','running')`).n);
    if (!pending && active === 0) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}
