import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import { q, db, getSettings, updateSettings, hydrate, hydrateAll, getSetting } from '../db.js';
import { UPLOAD_DIR, INBOUND_DIR, IMPORT_DIR } from '../config.js';
import * as auth from '../auth.js';
import { bus, emit } from '../events.js';
import { isPlainObject, now, parseJSON } from '../util.js';
import { listCategories, getProduct, saveProduct, invalidateProducts } from '../catalog.js';
import { parseBuffer, loadSource, autoMapping, syncSource } from '../importer.js';
import { listConversations, getConversation, saveConversation, listMessages, addMessage, findOrCreateConversation, botIsPausedFor } from '../conversations.js';
import { enqueueReply, queueStats, enqueue } from '../queue.js';
import { listOrders, getOrder, updateOrder, ordersToCsv, ordersToXlsx } from '../orders.js';
import { learn, addKnowledge } from '../knowledge.js';
import { deliver } from '../channels/index.js';
import { testChannel } from '../channels/meta.js';
import { buildSystem } from '../ai/prompt.js';
import { providerName } from '../ai/agent.js';
import { mimeFromName } from '../images.js';
import { DEFAULT_SETTINGS } from '../defaults.js';

export const api = express.Router();

/* ---------------- مصادقة ---------------- */
api.get('/auth/status', (req, res) => res.json({ setup: auth.isSetup(), authed: auth.isAuthed(req) }));
api.post('/auth/setup', (req, res) => {
  if (auth.isSetup()) return res.status(400).json({ error: 'الباسورد متضبط بالفعل' });
  try { auth.setPassword(req.body.password); } catch (e) { return res.status(400).json({ error: e.message }); }
  auth.setCookie(res, auth.createSession()); res.json({ ok: true });
});
api.post('/auth/login', (req, res) => {
  const ip = req.ip;
  if (!auth.loginAllowed(ip)) return res.status(429).json({ error: 'محاولات كتير. جرّب بعد شوية.' });
  const ok = auth.checkPassword(req.body.password || '');
  auth.recordAttempt(ip, ok);
  if (!ok) return res.status(401).json({ error: 'الباسورد غلط' });
  auth.setCookie(res, auth.createSession()); res.json({ ok: true });
});
api.post('/auth/logout', (req, res) => { const t = auth.currentToken(req); if (t) auth.destroySession(t); auth.clearCookie(res); res.json({ ok: true }); });

api.use(auth.requireAuth);

api.post('/auth/change', (req, res) => {
  if (!auth.checkPassword(req.body.current || '')) return res.status(401).json({ error: 'الباسورد الحالي غلط' });
  try { auth.setPassword(req.body.password); res.json({ ok: true }); } catch (e) { res.status(400).json({ error: e.message }); }
});

/* ---------------- الإعدادات ---------------- */
const SECRET = /(token|secret|api_key|password)$/;
function mask(v) {
  if (Array.isArray(v)) return v.map(mask);
  if (!isPlainObject(v)) return v;
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = SECRET.test(k) && typeof x === 'string' && x ? '__set__' : mask(x);
  return out;
}
function unmask(v) {
  if (Array.isArray(v)) return v;
  if (!isPlainObject(v)) return v;
  const out = {};
  for (const [k, x] of Object.entries(v)) { if (x === '__set__') continue; out[k] = unmask(x); }
  return out;
}
api.get('/settings', (req, res) => {
  const s = getSettings(); const out = {};
  for (const k of Object.keys(DEFAULT_SETTINGS)) out[k] = s[k];
  res.json(mask(out));
});
api.put('/settings', (req, res) => {
  const patch = {};
  for (const [k, v] of Object.entries(unmask(req.body || {}))) if (k in DEFAULT_SETTINGS) patch[k] = v;
  updateSettings(patch);
  invalidateProducts();
  res.json({ ok: true });
});

/* ---------------- CRUD عام ---------------- */
function crud(base, table, fields, { orderBy = 'id', after } = {}) {
  const pick = (body) => {
    const cols = []; const vals = [];
    for (const f of fields) {
      if (body[f] === undefined) continue;
      let v = body[f];
      if (typeof v === 'boolean') v = v ? 1 : 0;
      else if (v !== null && typeof v === 'object') v = JSON.stringify(v);
      cols.push(f); vals.push(v);
    }
    return { cols, vals };
  };
  api.get(base, (req, res) => res.json(hydrateAll(table, q.all(`SELECT * FROM ${table} ORDER BY ${orderBy}`))));
  api.post(base, (req, res) => {
    const { cols, vals } = pick(req.body || {});
    if (!cols.length) return res.status(400).json({ error: 'بيانات ناقصة' });
    try {
      const r = q.run(`INSERT INTO ${table}(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`, ...vals);
      after?.(); res.json(hydrate(table, q.get(`SELECT * FROM ${table} WHERE id=?`, r.lastInsertRowid)));
    } catch (e) { res.status(400).json({ error: e.message.includes('UNIQUE') ? 'الاسم ده موجود بالفعل' : e.message }); }
  });
  api.put(`${base}/:id`, (req, res) => {
    const { cols, vals } = pick(req.body || {});
    if (cols.length) {
      try { q.run(`UPDATE ${table} SET ${cols.map((c) => `${c}=?`).join(',')} WHERE id=?`, ...vals, req.params.id); } catch (e) { return res.status(400).json({ error: e.message }); }
    }
    after?.(); res.json(hydrate(table, q.get(`SELECT * FROM ${table} WHERE id=?`, req.params.id)));
  });
  api.delete(`${base}/:id`, (req, res) => { q.run(`DELETE FROM ${table} WHERE id=?`, req.params.id); after?.(); res.json({ ok: true }); });
}
crud('/categories', 'categories', ['name', 'description', 'instructions', 'required_fields', 'policy', 'active', 'sort'], { orderBy: 'sort, id', after: invalidateProducts });
crud('/shipping', 'shipping_rates', ['governorate', 'price', 'eta', 'aliases', 'active']);
crud('/discounts', 'discount_rules', ['name', 'type', 'value', 'trigger', 'min_order', 'max_discount', 'coupon_code', 'instructions', 'active']);
crud('/modes', 'modes', ['name', 'description', 'instructions', 'take_orders', 'allow_retention_discount', 'allow_upsell', 'send_images']);
crud('/knowledge', 'knowledge', ['question', 'answer', 'status', 'source'], { orderBy: 'id DESC' });

api.get('/categories-with-counts', (req, res) => res.json(listCategories()));

/* ---------------- المنتجات ---------------- */
api.get('/products', (req, res) => {
  const where = []; const args = [];
  if (req.query.category) { where.push('p.category_id=?'); args.push(req.query.category); }
  if (req.query.active === '0' || req.query.active === '1') { where.push('p.active=?'); args.push(req.query.active); }
  if (req.query.q) { where.push('(p.name LIKE ? OR p.sku LIKE ? OR p.description LIKE ?)'); const s = `%${req.query.q}%`; args.push(s, s, s); }
  if (req.query.source) { where.push('p.source_id=?'); args.push(req.query.source); }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = q.get(`SELECT COUNT(*) AS n FROM products p ${w}`, ...args).n;
  const limit = Math.min(Number(req.query.limit) || 50, 200); const offset = Number(req.query.offset) || 0;
  const items = hydrateAll('products', q.all(`SELECT p.*, c.name AS category_name FROM products p LEFT JOIN categories c ON c.id=p.category_id ${w} ORDER BY p.id DESC LIMIT ? OFFSET ?`, ...args, limit, offset));
  res.json({ items, total });
});
api.get('/products/:id', (req, res) => { const p = getProduct(req.params.id); p ? res.json(p) : res.status(404).json({ error: 'مش موجود' }); });
api.post('/products', (req, res) => { try { res.json(saveProduct(req.body)); } catch (e) { res.status(400).json({ error: e.message }); } });
api.put('/products/:id', (req, res) => {
  try { const cur = getProduct(req.params.id); if (!cur) return res.status(404).json({ error: 'مش موجود' }); res.json(saveProduct({ ...cur, ...req.body }, Number(req.params.id))); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
api.delete('/products/:id', (req, res) => { q.run('DELETE FROM products WHERE id=?', req.params.id); invalidateProducts(); res.json({ ok: true }); });
api.post('/products/bulk', (req, res) => {
  const { ids = [], action, category_id } = req.body || {};
  for (const id of ids) {
    if (action === 'activate') q.run('UPDATE products SET active=1 WHERE id=?', id);
    else if (action === 'deactivate') q.run('UPDATE products SET active=0 WHERE id=?', id);
    else if (action === 'delete') q.run('DELETE FROM products WHERE id=?', id);
    else if (action === 'set_category') q.run('UPDATE products SET category_id=? WHERE id=?', category_id, id);
  }
  invalidateProducts(); res.json({ ok: true });
});

/* ---------------- رفع ملفات ---------------- */
const rawBody = express.raw({ type: () => true, limit: '25mb' });
const safeName = (n) => String(n || 'file').replace(/[^\w.\-]+/g, '_').slice(-80);
api.post('/upload', rawBody, (req, res) => {
  const ext = path.extname(safeName(req.query.name)).toLowerCase();
  if (!['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext)) return res.status(400).json({ error: 'الصور بس (jpg, png, webp, gif)' });
  const name = `${crypto.randomUUID()}${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), req.body);
  res.json({ url: `/media/${name}` });
});
api.get('/inbound/:file', (req, res) => {
  const f = path.join(INBOUND_DIR, path.basename(req.params.file));
  fs.existsSync(f) ? res.type(mimeFromName(f)).sendFile(f) : res.status(404).end();
});

/* ---------------- مصادر الاستيراد (شيت/إكسل) ---------------- */
const sourceFields = ['name', 'type', 'url', 'mapping', 'default_category', 'sync_minutes', 'deactivate_missing', 'active'];
api.get('/sources', (req, res) => res.json(hydrateAll('sources', q.all('SELECT s.*, (SELECT COUNT(*) FROM products p WHERE p.source_id=s.id) AS product_count FROM sources s ORDER BY id'))));
api.post('/sources', (req, res) => {
  const b = req.body || {};
  if (!b.name || !['google_sheet', 'url', 'file'].includes(b.type)) return res.status(400).json({ error: 'الاسم والنوع مطلوبين' });
  const r = q.run('INSERT INTO sources(name,type,url,mapping,default_category,sync_minutes,deactivate_missing) VALUES(?,?,?,?,?,?,?)',
    b.name, b.type, b.url || '', JSON.stringify(b.mapping || {}), b.default_category || '', Number(b.sync_minutes) || 0, b.deactivate_missing === false ? 0 : 1);
  res.json(hydrate('sources', q.get('SELECT * FROM sources WHERE id=?', r.lastInsertRowid)));
});
api.put('/sources/:id', (req, res) => {
  const cols = []; const vals = [];
  for (const f of sourceFields) if (req.body[f] !== undefined) { cols.push(`${f}=?`); const v = req.body[f]; vals.push(typeof v === 'boolean' ? +v : (v && typeof v === 'object' ? JSON.stringify(v) : v)); }
  if (cols.length) q.run(`UPDATE sources SET ${cols.join(',')} WHERE id=?`, ...vals, req.params.id);
  res.json(hydrate('sources', q.get('SELECT * FROM sources WHERE id=?', req.params.id)));
});
api.delete('/sources/:id', (req, res) => {
  if (req.query.delete_products === '1') q.run('DELETE FROM products WHERE source_id=?', req.params.id);
  q.run('DELETE FROM sources WHERE id=?', req.params.id); invalidateProducts(); res.json({ ok: true });
});
api.post('/sources/:id/file', rawBody, (req, res) => {
  const s = q.get('SELECT * FROM sources WHERE id=?', req.params.id);
  if (!s) return res.status(404).json({ error: 'المصدر مش موجود' });
  const ext = path.extname(safeName(req.query.name)).toLowerCase() || '.csv';
  if (!['.csv', '.xlsx'].includes(ext)) return res.status(400).json({ error: 'CSV أو XLSX بس' });
  const file = path.join(IMPORT_DIR, `source-${s.id}${ext}`);
  fs.writeFileSync(file, req.body);
  q.run('UPDATE sources SET file_path=? WHERE id=?', file, s.id);
  res.json({ ok: true });
});
api.get('/sources/:id/preview', async (req, res) => {
  try {
    const s = hydrate('sources', q.get('SELECT * FROM sources WHERE id=?', req.params.id));
    if (!s) return res.status(404).json({ error: 'المصدر مش موجود' });
    const table = await loadSource(s);
    res.json({ headers: table.headers, sample: table.rows.slice(0, 8), total_rows: table.rows.length, suggested_mapping: autoMapping(table.headers), mapping: s.mapping });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
api.post('/sources/:id/sync', async (req, res) => {
  try { res.json(await syncSource(Number(req.params.id))); } catch (e) { res.status(400).json({ error: e.message }); }
});

/* ---------------- الشحن بالجملة ---------------- */
api.post('/shipping/bulk', (req, res) => {
  // سطر لكل محافظة: الاسم,السعر,المدة(اختياري)
  let n = 0;
  for (const line of String(req.body.text || '').split(/\r?\n/)) {
    const [name, price, eta] = line.split(/[,\t;]/).map((s) => s.trim());
    if (!name || !Number.isFinite(Number(price))) continue;
    q.run(`INSERT INTO shipping_rates(governorate, price, eta) VALUES(?,?,?) ON CONFLICT(governorate) DO UPDATE SET price=excluded.price, eta=COALESCE(NULLIF(excluded.eta,''), eta)`, name, Number(price), eta || '');
    n++;
  }
  res.json({ updated: n });
});

/* ---------------- المحادثات ---------------- */
api.get('/conversations', (req, res) => res.json(listConversations({ filter: req.query.filter })));
api.get('/conversations/:id', (req, res) => {
  const c = getConversation(req.params.id);
  if (!c) return res.status(404).json({ error: 'مش موجودة' });
  q.run('UPDATE conversations SET unread=0 WHERE id=?', c.id);
  res.json({ conversation: { ...c, bot_active: !botIsPausedFor(c) }, messages: listMessages(c.id), unanswered: q.all(`SELECT * FROM unanswered WHERE conversation_id=? AND status='open'`, c.id) });
});
api.post('/conversations/:id/send', async (req, res) => {
  const c = getConversation(req.params.id);
  const text = String(req.body.text || '').trim();
  if (!c || !text) return res.status(400).json({ error: 'اكتب رسالة' });
  const lastIn = q.get(`SELECT MAX(id) AS id FROM messages WHERE conversation_id=? AND direction='in'`, c.id).id || 0;
  const mins = getSetting('bot.human_takeover_minutes', 60);
  saveConversation(c.id, { state: { ...c.state, replied_upto: lastIn }, ...(mins > 0 ? { paused_until: now() + mins * 60000 } : {}), needs_human: 0 });
  const results = await deliver(c.id, { text, sender: 'human' });
  // تعلّم: لو فيه سؤال معلّق في المحادثة دي، ردّك يبقى إجابته
  for (const u of q.all(`SELECT * FROM unanswered WHERE conversation_id=? AND status='open'`, c.id)) {
    q.run(`UPDATE unanswered SET status='answered', answer=? WHERE id=?`, text, u.id);
    if (u.reason === 'unknown_answer') learn(u.question, text);
  }
  res.json({ ok: results.every((r) => r.ok), results });
});
api.post('/conversations/:id/pause', (req, res) => {
  const paused = req.body.paused !== false;
  saveConversation(Number(req.params.id), { bot_paused: paused ? 1 : 0, paused_until: 0 });
  if (!paused) { const c = getConversation(req.params.id); if (c.unread || true) enqueueReply(c.id, 500); }
  res.json({ ok: true });
});
api.post('/conversations/:id/resolve', (req, res) => { saveConversation(Number(req.params.id), { needs_human: 0, needs_human_reason: '' }); q.run(`UPDATE unanswered SET status='dismissed' WHERE conversation_id=? AND status='open'`, req.params.id); res.json({ ok: true }); });
api.post('/conversations/:id/save-knowledge', (req, res) => {
  const { question, answer } = req.body || {};
  if (!question || !answer) return res.status(400).json({ error: 'السؤال والإجابة مطلوبين' });
  res.json({ id: addKnowledge({ question, answer, status: 'approved', source: 'learned' }) });
});
api.delete('/conversations/:id', (req, res) => { q.run('DELETE FROM conversations WHERE id=?', req.params.id); res.json({ ok: true }); });

/* ---------------- تجربة البوت (المحاكي) ---------------- */
api.post('/sim/message', (req, res) => {
  const session = String(req.body.session || 'default').replace(/[^\w-]/g, '').slice(0, 40) || 'default';
  const conv = findOrCreateConversation('simulator', session, `تجربة (${session})`);
  const atts = req.body.image ? [{ type: 'image', local: path.basename(req.body.image) }] : [];
  const text = String(req.body.text || '').trim();
  if (!text && !atts.length) return res.status(400).json({ error: 'اكتب رسالة' });
  addMessage(conv.id, { direction: 'in', sender: 'customer', text, attachments: atts, external_id: null });
  saveConversation(conv.id, { bot_paused: 0, paused_until: 0 });
  enqueueReply(conv.id, 200);
  res.json({ conversation_id: conv.id });
});
api.post('/sim/upload', rawBody, (req, res) => {
  const ext = path.extname(safeName(req.query.name)).toLowerCase();
  if (!['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext)) return res.status(400).json({ error: 'صور بس' });
  const name = `${crypto.randomUUID()}${ext}`;
  fs.writeFileSync(path.join(INBOUND_DIR, name), req.body);
  res.json({ file: name });
});
api.post('/sim/reset', (req, res) => {
  const session = String(req.body.session || 'default').replace(/[^\w-]/g, '');
  const c = q.get(`SELECT id FROM conversations WHERE channel='simulator' AND external_id=?`, session);
  if (c) q.run('DELETE FROM conversations WHERE id=?', c.id);
  res.json({ ok: true });
});
api.get('/prompt-preview', (req, res) => {
  const conv = findOrCreateConversation('simulator', 'preview', 'معاينة');
  const { stable, dynamic, mode } = buildSystem(conv, String(req.query.q || ''));
  res.json({ prompt: `${stable}\n\n${dynamic}`, mode: mode.name, provider: providerName() });
});

/* ---------------- الأوردرات ---------------- */
api.get('/orders', (req, res) => res.json(listOrders({ status: req.query.status, search: req.query.q })));
api.get('/orders/export.csv', (req, res) => { res.type('text/csv; charset=utf-8').attachment('orders.csv').send(ordersToCsv(listOrders({ status: req.query.status, limit: 5000 }))); });
api.get('/orders/export.xlsx', async (req, res) => { res.attachment('orders.xlsx').type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(await ordersToXlsx(listOrders({ status: req.query.status, limit: 5000 }))); });
api.get('/orders/:id', (req, res) => { const o = getOrder(req.params.id); o ? res.json(o) : res.status(404).json({ error: 'مش موجود' }); });
api.patch('/orders/:id', (req, res) => { const o = updateOrder(Number(req.params.id), req.body || {}); o ? res.json(o) : res.status(404).json({ error: 'مش موجود' }); });
api.post('/orders/:id/resend', (req, res) => { enqueue({ kind: 'order_export', payload: { order_id: Number(req.params.id) } }); res.json({ ok: true }); });

/* ---------------- الأسئلة اللي ما اتجاوبتش ---------------- */
api.get('/unanswered', (req, res) => res.json(q.all(`SELECT u.*, c.display_name, c.channel, c.external_id FROM unanswered u LEFT JOIN conversations c ON c.id=u.conversation_id WHERE u.status=? ORDER BY u.id DESC LIMIT 200`, req.query.status || 'open')));
api.post('/unanswered/:id/answer', async (req, res) => {
  const u = q.get('SELECT * FROM unanswered WHERE id=?', req.params.id);
  const answer = String(req.body.answer || '').trim();
  if (!u || !answer) return res.status(400).json({ error: 'اكتب الإجابة' });
  q.run(`UPDATE unanswered SET status='answered', answer=? WHERE id=?`, answer, u.id);
  let knowledgeId = null;
  if (req.body.save !== false) knowledgeId = learn(req.body.question || u.question, answer, { explicit: true });
  if (req.body.send !== false && u.conversation_id) {
    const c = getConversation(u.conversation_id);
    if (c) {
      const lastIn = q.get(`SELECT MAX(id) AS id FROM messages WHERE conversation_id=? AND direction='in'`, c.id).id || 0;
      saveConversation(c.id, { needs_human: 0, state: { ...c.state, replied_upto: Math.max(lastIn, c.state.replied_upto || 0) } });
      await deliver(c.id, { text: answer, sender: 'human' });
    }
  }
  res.json({ ok: true, knowledge_id: knowledgeId });
});
api.post('/unanswered/:id/dismiss', (req, res) => { q.run(`UPDATE unanswered SET status='dismissed' WHERE id=?`, req.params.id); res.json({ ok: true }); });

/* ---------------- نظرة عامة / صحة / لوجات / قنوات ---------------- */
api.get('/overview', (req, res) => {
  const day = new Date(); day.setHours(0, 0, 0, 0);
  res.json({
    orders_today: q.get('SELECT COUNT(*) AS n FROM orders WHERE created_at>=?', day.getTime()).n,
    sales_today: q.get('SELECT COALESCE(SUM(total),0) AS n FROM orders WHERE created_at>=? AND status<>?', day.getTime(), 'ملغي').n,
    new_orders: q.get('SELECT COUNT(*) AS n FROM orders WHERE status=?', getSetting('orders.default_status')).n,
    needs_human: q.get('SELECT COUNT(*) AS n FROM conversations WHERE needs_human=1').n,
    open_questions: q.get(`SELECT COUNT(*) AS n FROM unanswered WHERE status='open'`).n,
    pending_knowledge: q.get(`SELECT COUNT(*) AS n FROM knowledge WHERE status='pending'`).n,
    products: q.get('SELECT COUNT(*) AS n FROM products WHERE active=1').n,
  });
});
api.get('/health', (req, res) => {
  const s = getSettings();
  const ch = (k) => ({ enabled: Boolean(s.channels[k].enabled), configured: Boolean(s.channels[k].page_access_token || s.channels[k].access_token) });
  res.json({
    ok: true, uptime_s: Math.round(process.uptime()), provider: providerName(), model: s.ai.model, queue: queueStats(),
    channels: { messenger: ch('messenger'), instagram: ch('instagram'), whatsapp: { ...ch('whatsapp'), configured: Boolean(s.channels.whatsapp.access_token && s.channels.whatsapp.phone_number_id) } },
    webhook_signature_check: Boolean(s.channels.app_secret), public_base_url: s.channels.public_base_url || null,
    failed_messages: q.get(`SELECT COUNT(*) AS n FROM messages WHERE status='failed'`).n,
    recent_errors: q.all(`SELECT * FROM logs WHERE level IN ('error','warn') ORDER BY id DESC LIMIT 30`),
  });
});
api.get('/logs', (req, res) => res.json(q.all('SELECT * FROM logs ORDER BY id DESC LIMIT 200')));
api.get('/channels/info', (req, res) => {
  const base = String(getSetting('channels.public_base_url') || '').replace(/\/$/, '') || `${req.protocol}://${req.get('host')}`;
  res.json({ webhook_url: `${base}/webhooks/meta`, verify_code: getSetting('channels.verify_code'), base_is_public: Boolean(getSetting('channels.public_base_url')) });
});
api.post('/channels/:name/test', async (req, res) => res.json(await testChannel(req.params.name)));

/* ---------------- أحداث لحظية (SSE) ---------------- */
api.get('/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  const send = (e) => res.write(`data: ${JSON.stringify(e)}\n\n`);
  bus.on('event', send);
  const ka = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { bus.off('event', send); clearInterval(ka); });
});

api.use((err, req, res, next) => { res.status(500).json({ error: err.message }); }); // eslint-disable-line no-unused-vars
