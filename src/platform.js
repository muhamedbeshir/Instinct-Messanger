import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR } from './config.js';
import { currentTenantId, tenantDir } from './tenancy.js';
import { parseJSON, deepMerge, clone, isPlainObject, now } from './util.js';

/**
 * قاعدة بيانات المنصة: العملاء (tenants)، المستخدمين، الباقات، الاستهلاك، المدفوعات، التدقيق.
 * بيانات المتاجر نفسها (منتجات، محادثات، أوردرات) في قاعدة منفصلة لكل عميل (db.js).
 */
export const pdb = new DatabaseSync(path.join(DATA_DIR, 'platform.db'));
pdb.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
pdb.exec(`
CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  price REAL DEFAULT 0, currency TEXT DEFAULT 'EGP', trial_days INTEGER DEFAULT 0,
  limits TEXT DEFAULT '{}', features TEXT DEFAULT '{}', description TEXT DEFAULT '',
  public INTEGER DEFAULT 1, active INTEGER DEFAULT 1, sort INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS tenants (
  id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  status TEXT DEFAULT 'active', plan_id INTEGER REFERENCES plans(id),
  trial_ends INTEGER DEFAULT 0, paid_until INTEGER DEFAULT 0, notes TEXT DEFAULT '',
  created_at INTEGER NOT NULL, last_seen INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT DEFAULT '', role TEXT NOT NULL,
  password_hash TEXT NOT NULL, active INTEGER DEFAULT 1, created_at INTEGER NOT NULL, last_login INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, tenant_id INTEGER, role TEXT NOT NULL,
  impersonator_id INTEGER, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS usage (
  tenant_id INTEGER NOT NULL, period TEXT NOT NULL,
  ai_replies INTEGER DEFAULT 0, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
  orders INTEGER DEFAULT 0, messages_in INTEGER DEFAULT 0, PRIMARY KEY (tenant_id, period)
);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER NOT NULL, plan_id INTEGER, amount REAL DEFAULT 0,
  currency TEXT DEFAULT 'EGP', method TEXT DEFAULT '', reference TEXT DEFAULT '', note TEXT DEFAULT '',
  months INTEGER DEFAULT 1, recorded_by INTEGER, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS upgrade_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER NOT NULL, plan_id INTEGER, note TEXT DEFAULT '',
  status TEXT DEFAULT 'open', created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, actor TEXT DEFAULT '', tenant_id INTEGER, action TEXT NOT NULL, detail TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS plogs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER, level TEXT, scope TEXT, message TEXT, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS pset (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);

export const pq = {
  all: (sql, ...p) => pdb.prepare(sql).all(...p),
  get: (sql, ...p) => pdb.prepare(sql).get(...p),
  run: (sql, ...p) => pdb.prepare(sql).run(...p),
};

/* ---------------- إعدادات المنصة (للسوبر أدمن فقط) ---------------- */
export const PLATFORM_DEFAULTS = {
  brand: { name: 'Instinct Messenger' },
  ai: { provider: 'auto', model: 'claude-sonnet-5-5', api_key: '', max_tokens: 1024, timeout_ms: 45000, allow_mock: false },
  signup: { open: true, default_plan: 'trial' },
  public_url: '',
  support: { email: '', whatsapp: '' },
  payment_instructions: '',
  announcement: { text: '', level: 'info' },
};
let psCache = null;
export function getPlatformSettings() {
  if (!psCache) {
    const merged = clone(PLATFORM_DEFAULTS);
    for (const r of pq.all('SELECT key, value FROM pset')) {
      const v = parseJSON(r.value);
      merged[r.key] = isPlainObject(merged[r.key]) && isPlainObject(v) ? deepMerge(merged[r.key], v) : v;
    }
    psCache = merged;
  }
  return psCache;
}
export function setPlatformSettings(patch) {
  const cur = getPlatformSettings();
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in PLATFORM_DEFAULTS)) continue;
    const next = isPlainObject(cur[k]) && isPlainObject(v) ? deepMerge(cur[k], v) : v;
    pq.run('INSERT INTO pset(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', k, JSON.stringify(next));
  }
  psCache = null;
  return getPlatformSettings();
}

/* ---------------- الباقات ---------------- */
// -1 = بدون حد. الأسعار هنا أرقام مبدئية، السوبر أدمن بيعدّلها من لوحة الإدارة.
const SEED_PLANS = [
  { slug: 'trial', name: 'تجريبي', price: 0, trial_days: 14, sort: 1, description: '14 يوم تجربة مجانية',
    limits: { products: 50, ai_replies: 300, channels: 1, staff: 1 }, features: { auto_sync: false, byok: false, instagram: true, whatsapp: true } },
  { slug: 'starter', name: 'أساسي', price: 299, sort: 2, description: 'لمتجر صغير بيبدأ',
    limits: { products: 300, ai_replies: 1500, channels: 2, staff: 2 }, features: { auto_sync: true, byok: false, instagram: true, whatsapp: true } },
  { slug: 'pro', name: 'احترافي', price: 799, sort: 3, description: 'للمتاجر النشطة على القنوات التلاتة',
    limits: { products: 3000, ai_replies: 6000, channels: 3, staff: 5 }, features: { auto_sync: true, byok: false, instagram: true, whatsapp: true } },
  { slug: 'business', name: 'أعمال', price: 1999, sort: 4, description: 'حجم كبير وبدون حدود تقريبًا',
    limits: { products: -1, ai_replies: 25000, channels: 3, staff: 15 }, features: { auto_sync: true, byok: true, instagram: true, whatsapp: true } },
];
function seedPlans() {
  if (pq.get('SELECT COUNT(*) AS n FROM plans').n) return;
  for (const p of SEED_PLANS) {
    pq.run('INSERT INTO plans(slug,name,price,trial_days,limits,features,description,sort) VALUES(?,?,?,?,?,?,?,?)',
      p.slug, p.name, p.price, p.trial_days || 0, JSON.stringify(p.limits), JSON.stringify(p.features), p.description, p.sort);
  }
}
seedPlans();
const hydratePlan = (r) => r && ({ ...r, limits: parseJSON(r.limits, {}), features: parseJSON(r.features, {}) });
export const listPlans = ({ publicOnly = false } = {}) => pq.all(`SELECT * FROM plans ${publicOnly ? 'WHERE public=1 AND active=1' : ''} ORDER BY sort, id`).map(hydratePlan);
export const getPlan = (idOrSlug) => hydratePlan(typeof idOrSlug === 'number' ? pq.get('SELECT * FROM plans WHERE id=?', idOrSlug) : pq.get('SELECT * FROM plans WHERE slug=?', idOrSlug));
export function savePlan(b, id = null) {
  const vals = [b.slug, b.name, Number(b.price) || 0, b.currency || 'EGP', Number(b.trial_days) || 0, JSON.stringify(b.limits || {}), JSON.stringify(b.features || {}), b.description || '', b.public === false || b.public === 0 ? 0 : 1, b.active === false || b.active === 0 ? 0 : 1, Number(b.sort) || 0];
  if (!/^[a-z0-9_-]{2,30}$/.test(String(b.slug || ''))) throw new Error('slug الباقة: حروف إنجليزية صغيرة وأرقام فقط');
  if (id) { pq.run('UPDATE plans SET slug=?,name=?,price=?,currency=?,trial_days=?,limits=?,features=?,description=?,public=?,active=?,sort=? WHERE id=?', ...vals, id); return getPlan(Number(id)); }
  const r = pq.run('INSERT INTO plans(slug,name,price,currency,trial_days,limits,features,description,public,active,sort) VALUES(?,?,?,?,?,?,?,?,?,?,?)', ...vals);
  return getPlan(Number(r.lastInsertRowid));
}

/* ---------------- العملاء ---------------- */
const DAY = 86400000;
const GRACE_DAYS = 3;
export const tenantBySlug = (slug) => pq.get('SELECT * FROM tenants WHERE slug=?', String(slug || '').toLowerCase());
export const tenantById = (id) => pq.get('SELECT * FROM tenants WHERE id=?', id);

export function slugify(name) {
  const base = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'store';
  let slug = base; let i = 1;
  while (tenantBySlug(slug)) slug = `${base}-${++i}${crypto.randomBytes(1).toString('hex')}`;
  if (slug === base && base === 'store') slug = `store-${crypto.randomBytes(3).toString('hex')}`;
  return slug;
}

export function createTenant({ name, planSlug, notes = '' }) {
  const plan = getPlan(planSlug || getPlatformSettings().signup.default_plan) || listPlans()[0];
  const t = now();
  const slug = slugify(name);
  const r = pq.run('INSERT INTO tenants(slug,name,plan_id,trial_ends,paid_until,notes,created_at) VALUES(?,?,?,?,?,?,?)',
    slug, name, plan.id, plan.trial_days ? t + plan.trial_days * DAY : 0, 0, notes, t);
  return tenantById(Number(r.lastInsertRowid));
}

const infoCache = new Map();
export function invalidateTenant(id) { infoCache.delete(Number(id)); }

/** حالة العميل الفعلية + حدود باقته. بيتحدّث كل 15 ثانية. */
export function tenantInfo(id = currentTenantId()) {
  if (id == null) return null;
  const hit = infoCache.get(id);
  if (hit && Date.now() - hit.at < 15000) return hit.v;
  const t = tenantById(id);
  let v;
  if (!t) {
    // عميل افتراضي للاختبارات/الاستخدام المحلي بدون منصة: بدون حدود
    v = { id, name: 'default', slug: 'default', status: 'active', plan: { slug: 'dev', name: 'dev', price: 0, limits: {}, features: { byok: true, auto_sync: true, instagram: true, whatsapp: true } }, days_left: null, deadline: null };
  } else {
    const plan = getPlan(t.plan_id) || { slug: 'none', name: '—', price: 0, limits: {}, features: {}, trial_days: 0 };
    let status = 'active'; let deadline = null;
    if (t.status === 'suspended') status = 'suspended';
    else if (plan.price > 0) { deadline = (t.paid_until || 0) + GRACE_DAYS * DAY; if (!t.paid_until || Date.now() > deadline) status = 'expired'; }
    else if (plan.trial_days > 0) { deadline = t.trial_ends; if (Date.now() > deadline) status = 'expired'; }
    const until = plan.price > 0 ? t.paid_until : deadline;
    v = { id: t.id, name: t.name, slug: t.slug, status, plan, trial_ends: t.trial_ends, paid_until: t.paid_until, days_left: until ? Math.ceil((until - Date.now()) / DAY) : null, deadline, created_at: t.created_at, notes: t.notes };
  }
  infoCache.set(id, { v, at: Date.now() });
  return v;
}

export function limitOf(info, key) { const l = info?.plan?.limits?.[key]; return l === undefined || l === null ? -1 : l; }
export const hasFeature = (info, f) => Boolean(info?.plan?.features?.[f]);

export function deleteTenantRecord(id) {
  pq.run('DELETE FROM usage WHERE tenant_id=?', id); pq.run('DELETE FROM payments WHERE tenant_id=?', id);
  pq.run('DELETE FROM upgrade_requests WHERE tenant_id=?', id); pq.run('DELETE FROM sessions WHERE tenant_id=?', id);
  pq.run('DELETE FROM users WHERE tenant_id=?', id); pq.run('DELETE FROM tenants WHERE id=?', id);
  invalidateTenant(id);
  try { fs.rmSync(tenantDir(id), { recursive: true, force: true }); } catch { /* */ }
}

/* ---------------- الاستهلاك والحصص ---------------- */
export const periodKey = (d = new Date()) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
export function track(patch, tenantId = currentTenantId()) {
  if (tenantId == null) return;
  const p = periodKey();
  pq.run('INSERT OR IGNORE INTO usage(tenant_id, period) VALUES(?,?)', tenantId, p);
  const f = ['ai_replies', 'input_tokens', 'output_tokens', 'orders', 'messages_in'].filter((k) => patch[k]);
  if (f.length) pq.run(`UPDATE usage SET ${f.map((k) => `${k}=${k}+?`).join(',')} WHERE tenant_id=? AND period=?`, ...f.map((k) => Math.round(patch[k])), tenantId, p);
}
export function usageOf(tenantId = currentTenantId(), period = periodKey()) {
  return pq.get('SELECT * FROM usage WHERE tenant_id=? AND period=?', tenantId, period) || { tenant_id: tenantId, period, ai_replies: 0, input_tokens: 0, output_tokens: 0, orders: 0, messages_in: 0 };
}
/** هل لسه فيه حصة ردود ذكاء اصطناعي الشهر ده؟ */
export function aiQuota(tenantId = currentTenantId()) {
  const info = tenantInfo(tenantId); const limit = limitOf(info, 'ai_replies'); const used = usageOf(tenantId).ai_replies;
  return { ok: limit < 0 || used < limit, used, limit };
}

/* ---------------- تدقيق وسجلات ---------------- */
export function audit(actor, tenantId, action, detail = '') {
  pq.run('INSERT INTO audit(at,actor,tenant_id,action,detail) VALUES(?,?,?,?,?)', now(), String(actor || ''), tenantId ?? null, action, typeof detail === 'string' ? detail : JSON.stringify(detail));
}
export function platformLog(level, scope, message, tenantId = currentTenantId()) {
  try {
    pq.run('INSERT INTO plogs(tenant_id,level,scope,message,created_at) VALUES(?,?,?,?,?)', tenantId ?? null, level, scope, String(message).slice(0, 1500), now());
    pq.run('DELETE FROM plogs WHERE id < (SELECT MAX(id) - 5000 FROM plogs)');
  } catch { /* */ }
}
export const allTenantIds = () => pq.all('SELECT id FROM tenants').map((r) => r.id);
