import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { currentTenantId, runInTenant, tenantDir } from './tenancy.js';
import { parseJSON, deepMerge, clone, isPlainObject, randomToken } from './util.js';
import { DEFAULT_SETTINGS, DEFAULT_GOVERNORATES, DEFAULT_MODES, DEFAULT_DISCOUNTS } from './defaults.js';

/* ============ قاعدة بيانات لكل عميل (tenant) ============ */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  instructions TEXT DEFAULT '',        -- تعليمات للبوت خاصة بالقسم
  required_fields TEXT DEFAULT '[]',   -- حقول لازم البوت يسأل عنها قبل الإضافة للسلة (مقاس، لون...)
  policy TEXT DEFAULT '',              -- سياسة القسم (استبدال، ضمان...)
  active INTEGER DEFAULT 1,
  sort INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL,                  -- google_sheet | url | file
  url TEXT DEFAULT '',
  file_path TEXT DEFAULT '',
  mapping TEXT DEFAULT '{}',
  default_category TEXT DEFAULT '',
  sync_minutes INTEGER DEFAULT 0,
  deactivate_missing INTEGER DEFAULT 1,
  active INTEGER DEFAULT 1,
  last_sync INTEGER DEFAULT 0,
  last_status TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT DEFAULT '',
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  price REAL DEFAULT 0,
  compare_price REAL,
  stock INTEGER,                       -- NULL = غير محدد/متاح دايمًا
  images TEXT DEFAULT '[]',
  attributes TEXT DEFAULT '{}',        -- أعمدة ديناميكية جاية من الشيت (مقاس، لون، خامة...)
  notes TEXT DEFAULT '',               -- تعليمات للبوت خاصة بالمنتج
  active INTEGER DEFAULT 1,
  source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL,
  source_key TEXT DEFAULT '',
  updated_at INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_products_source ON products(source_id, source_key);

CREATE TABLE IF NOT EXISTS shipping_rates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  governorate TEXT NOT NULL UNIQUE,
  price REAL NOT NULL DEFAULT 0,
  eta TEXT DEFAULT '',
  aliases TEXT DEFAULT '',             -- أسماء بديلة مفصولة بفاصلة
  active INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS discount_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'percent',   -- percent | fixed
  value REAL NOT NULL DEFAULT 0,
  trigger TEXT NOT NULL DEFAULT 'retention', -- retention | min_order | coupon | manual
  min_order REAL DEFAULT 0,
  max_discount REAL DEFAULT 0,            -- 0 = بدون حد
  coupon_code TEXT DEFAULT '',
  instructions TEXT DEFAULT '',           -- امتى ينفع البوت يعرضه
  active INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS modes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  instructions TEXT DEFAULT '',
  take_orders INTEGER DEFAULT 1,
  allow_retention_discount INTEGER DEFAULT 0,
  allow_upsell INTEGER DEFAULT 0,
  send_images INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,
  external_id TEXT NOT NULL,
  display_name TEXT DEFAULT '',
  bot_paused INTEGER DEFAULT 0,
  paused_until INTEGER DEFAULT 0,
  needs_human INTEGER DEFAULT 0,
  needs_human_reason TEXT DEFAULT '',
  cart TEXT DEFAULT '[]',
  customer TEXT DEFAULT '{}',
  discount TEXT DEFAULT 'null',
  state TEXT DEFAULT '{}',
  unread INTEGER DEFAULT 0,
  last_message_at INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT 0,
  UNIQUE(channel, external_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  direction TEXT NOT NULL,             -- in | out
  sender TEXT NOT NULL,                -- customer | bot | human
  text TEXT DEFAULT '',
  attachments TEXT DEFAULT '[]',
  meta TEXT DEFAULT '{}',
  external_id TEXT,
  status TEXT DEFAULT 'sent',
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_msg_ext ON messages(conversation_id, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, id);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL UNIQUE,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  channel TEXT DEFAULT '',
  customer_name TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  governorate TEXT DEFAULT '',
  address TEXT DEFAULT '',
  extra TEXT DEFAULT '{}',
  items TEXT DEFAULT '[]',
  subtotal REAL DEFAULT 0,
  discount_total REAL DEFAULT 0,
  discount_info TEXT DEFAULT 'null',
  shipping REAL DEFAULT 0,
  total REAL DEFAULT 0,
  payment_method TEXT DEFAULT '',
  status TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  exported INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS knowledge (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  status TEXT DEFAULT 'approved',      -- approved | pending
  source TEXT DEFAULT 'manual',        -- manual | learned
  uses INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS unanswered (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  question TEXT NOT NULL,
  reason TEXT DEFAULT '',
  status TEXT DEFAULT 'open',          -- open | answered | dismissed
  answer TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  conversation_id INTEGER,
  payload TEXT DEFAULT '{}',
  run_at INTEGER NOT NULL,
  attempts INTEGER DEFAULT 0,
  status TEXT DEFAULT 'pending',       -- pending | running | done | failed
  last_error TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs(status, run_at);

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level TEXT, scope TEXT, message TEXT, extra TEXT, created_at INTEGER
);

`;

const dbs = new Map();
export function openTenantDb(id) {
  id = Number(id);
  let d = dbs.get(id);
  if (d) return d;
  fs.mkdirSync(tenantDir(id), { recursive: true });
  d = new DatabaseSync(path.join(tenantDir(id), 'app.db'));
  d.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  d.exec(SCHEMA);
  dbs.set(id, d);
  runInTenant(id, seedDefaults);
  return d;
}
export function closeTenantDb(id) {
  const d = dbs.get(Number(id));
  if (d) { try { d.close(); } catch { /* */ } dbs.delete(Number(id)); }
  caches.delete(Number(id));
}
export function tenantDb() {
  const id = currentTenantId();
  if (id == null) throw new Error('no tenant context (الكود ده لازم يشتغل جوه runInTenant)');
  return openTenantDb(id);
}
/** الـ db اللي كل الكود بيستخدمه: بيشاور تلقائيًا على قاعدة العميل الحالي */
export const db = new Proxy({}, { get: (_, p) => { const d = tenantDb(); const v = d[p]; return typeof v === 'function' ? v.bind(d) : v; } });

export const q = {
  all: (sql, ...p) => db.prepare(sql).all(...p),
  get: (sql, ...p) => db.prepare(sql).get(...p),
  run: (sql, ...p) => db.prepare(sql).run(...p),
};

/* ---------------- الإعدادات (مخزّنة لكل عميل) ---------------- */
const caches = new Map();
function loadSettings() {
  const merged = clone(DEFAULT_SETTINGS);
  for (const row of q.all('SELECT key, value FROM settings')) {
    const v = parseJSON(row.value);
    merged[row.key] = isPlainObject(merged[row.key]) && isPlainObject(v) ? deepMerge(merged[row.key], v) : v;
  }
  return merged;
}
export function getSettings() {
  const id = currentTenantId();
  if (!caches.has(id)) caches.set(id, loadSettings());
  return caches.get(id);
}
export function getSetting(pathStr, fallback) {
  let cur = getSettings();
  for (const p of pathStr.split('.')) { if (cur == null) return fallback; cur = cur[p]; }
  return cur === undefined ? fallback : cur;
}
// خرائط بتتستبدل بالكامل (عشان لما تمسح صف من اللوحة يتمسح فعلًا)
const REPLACE_MAPS = [['notifications', 'status_messages']];
export function updateSettings(patch) {
  const cur = getSettings();
  for (const [k, v] of Object.entries(patch)) {
    let base = cur[k];
    for (const [top, sub] of REPLACE_MAPS) if (k === top && isPlainObject(v) && isPlainObject(v[sub])) base = { ...base, [sub]: {} };
    const next = isPlainObject(base) && isPlainObject(v) ? deepMerge(base, v) : v;
    q.run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', k, JSON.stringify(next));
  }
  caches.delete(currentTenantId());
  return getSettings();
}
export function getRaw(key, fallback = null) {
  const r = q.get('SELECT value FROM settings WHERE key=?', key);
  return r ? parseJSON(r.value, fallback) : fallback;
}
export function setRaw(key, value) {
  q.run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, JSON.stringify(value));
  caches.delete(currentTenantId());
}

/* ---------------- بيانات افتراضية لكل عميل جديد ---------------- */
export function seedDefaults() {
  if (!getRaw('_seeded')) {
    const dp = getSettings().shipping.default_price;
    for (const g of DEFAULT_GOVERNORATES) {
      q.run('INSERT OR IGNORE INTO shipping_rates(governorate, price, eta, aliases) VALUES(?,?,?,?)', g.name, dp, g.eta || '', g.aliases || '');
    }
    for (const r of DEFAULT_DISCOUNTS) {
      q.run('INSERT INTO discount_rules(name,type,value,trigger,min_order,max_discount,coupon_code,instructions,active) VALUES(?,?,?,?,?,?,?,?,?)',
        r.name, r.type, r.value, r.trigger, r.min_order || 0, r.max_discount || 0, r.coupon_code || '', r.instructions || '', r.active ? 1 : 0);
    }
    let firstModeId = null;
    for (const m of DEFAULT_MODES) {
      const res = q.run('INSERT INTO modes(name,description,instructions,take_orders,allow_retention_discount,allow_upsell,send_images) VALUES(?,?,?,?,?,?,?)',
        m.name, m.description, m.instructions, m.take_orders ? 1 : 0, m.allow_retention_discount ? 1 : 0, m.allow_upsell ? 1 : 0, m.send_images ? 1 : 0);
      if (firstModeId === null) firstModeId = Number(res.lastInsertRowid);
    }
    updateSettings({ active_mode_id: firstModeId });
    setRaw('_seeded', true);
  }
  if (!getSettings().channels.verify_code) {
    updateSettings({ channels: { verify_code: 'im_' + randomToken(6) } });
  }
}

/* ---------------- مساعدات صفوف ---------------- */
export const JSON_COLS = {
  categories: ['required_fields'],
  products: ['images', 'attributes'],
  sources: ['mapping'],
  conversations: ['cart', 'customer', 'discount', 'state'],
  messages: ['attachments', 'meta'],
  orders: ['extra', 'items', 'discount_info'],
};
export function hydrate(table, row) {
  if (!row) return row;
  const out = { ...row };
  for (const c of JSON_COLS[table] || []) {
    const fallback = ['cart', 'images', 'attachments', 'items', 'required_fields'].includes(c) ? [] : (c === 'discount' || c === 'discount_info' ? null : {});
    out[c] = parseJSON(out[c], fallback);
  }
  return out;
}
export const hydrateAll = (table, rows) => rows.map((r) => hydrate(table, r));
