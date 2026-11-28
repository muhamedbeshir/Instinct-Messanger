import express from 'express';
import fs from 'node:fs';
import * as auth from '../auth.js';
import {
  pq, listPlans, getPlan, savePlan, getPlatformSettings, setPlatformSettings, tenantInfo, tenantById, invalidateTenant, deleteTenantRecord,
  createTenant, usageOf, periodKey, audit, allTenantIds, metaConfig,
} from '../platform.js';
import { runInTenant, tenantDir } from '../tenancy.js';
import { q, closeTenantDb, openTenantDb, updateSettings } from '../db.js';
import { queueStats } from '../queue.js';
import { now } from '../util.js';
import { platformAiStatus } from '../ai/config.js';

/** لوحة السوبر أدمن: إدارة المنصة كلها. السوبر أدمن بس. */
export const admin = express.Router();
admin.use(auth.requireSuperadmin);
const actor = (req) => req.auth.user.email;
const DAY = 86400000;

function tenantRow(t) {
  const info = tenantInfo(t.id); const u = usageOf(t.id);
  const owner = pq.get(`SELECT email, name, last_login FROM users WHERE tenant_id=? AND role='owner' ORDER BY id LIMIT 1`, t.id);
  return { id: t.id, slug: t.slug, name: t.name, status: info.status, raw_status: t.status, plan: { id: info.plan.id, slug: info.plan.slug, name: info.plan.name, price: info.plan.price }, days_left: info.days_left,
    trial_ends: t.trial_ends, paid_until: t.paid_until, created_at: t.created_at, last_seen: t.last_seen, owner, usage: { ai_replies: u.ai_replies, orders: u.orders, messages_in: u.messages_in }, limits: info.plan.limits };
}

/* ---------- نظرة عامة ---------- */
admin.get('/stats', (req, res) => {
  const tenants = pq.all('SELECT * FROM tenants'); const byStatus = { active: 0, expired: 0, suspended: 0 }; let mrr = 0; const byPlan = {};
  for (const t of tenants) {
    const info = tenantInfo(t.id); byStatus[info.status] = (byStatus[info.status] || 0) + 1;
    byPlan[info.plan.name] = (byPlan[info.plan.name] || 0) + 1;
    if (info.status === 'active' && info.plan.price > 0) mrr += info.plan.price;
  }
  const p = periodKey();
  const tot = pq.get('SELECT COALESCE(SUM(ai_replies),0) ai, COALESCE(SUM(input_tokens),0) tin, COALESCE(SUM(output_tokens),0) tout, COALESCE(SUM(orders),0) orders, COALESCE(SUM(messages_in),0) msgs FROM usage WHERE period=?', p);
  const top = pq.all('SELECT u.tenant_id, t.name, u.ai_replies, u.orders FROM usage u JOIN tenants t ON t.id=u.tenant_id WHERE u.period=? ORDER BY u.ai_replies DESC LIMIT 5', p);
  res.json({
    tenants_total: tenants.length, by_status: byStatus, by_plan: byPlan, mrr, currency: 'EGP',
    signups_7d: pq.get('SELECT COUNT(*) n FROM tenants WHERE created_at>?', now() - 7 * DAY).n, signups_30d: pq.get('SELECT COUNT(*) n FROM tenants WHERE created_at>?', now() - 30 * DAY).n,
    month: p, usage: tot, top_tenants: top, open_upgrades: pq.get(`SELECT COUNT(*) n FROM upgrade_requests WHERE status='open'`).n,
    errors_24h: pq.get(`SELECT COUNT(*) n FROM plogs WHERE level='error' AND created_at>?`, now() - DAY).n,
    expiring_soon: tenants.map((t) => ({ t, i: tenantInfo(t.id) })).filter((x) => x.i.status === 'active' && x.i.days_left !== null && x.i.days_left <= 5).map((x) => ({ id: x.t.id, name: x.t.name, days_left: x.i.days_left, plan: x.i.plan.name })),
  });
});

/* ---------- العملاء ---------- */
admin.get('/tenants', (req, res) => {
  const qtext = `%${req.query.q || ''}%`;
  let rows = pq.all(`SELECT t.* FROM tenants t LEFT JOIN users u ON u.tenant_id=t.id AND u.role='owner' WHERE t.name LIKE ? OR t.slug LIKE ? OR u.email LIKE ? GROUP BY t.id ORDER BY t.id DESC`, qtext, qtext, qtext).map(tenantRow);
  if (req.query.status) rows = rows.filter((r) => r.status === req.query.status);
  res.json(rows);
});
admin.get('/tenants/:id', (req, res) => {
  const t = tenantById(Number(req.params.id)); if (!t) return res.status(404).json({ error: 'مش موجود' });
  const counts = runInTenant(t.id, () => ({
    products: q.get('SELECT COUNT(*) n FROM products').n, orders: q.get('SELECT COUNT(*) n FROM orders').n, conversations: q.get('SELECT COUNT(*) n FROM conversations').n,
    failed_jobs: q.get(`SELECT COUNT(*) n FROM jobs WHERE status='failed'`).n, failed_messages: q.get(`SELECT COUNT(*) n FROM messages WHERE status='failed'`).n,
  }));
  res.json({
    ...tenantRow(t), notes: t.notes, counts, users: pq.all('SELECT * FROM users WHERE tenant_id=?', t.id).map(auth.publicUser),
    usage_history: pq.all('SELECT * FROM usage WHERE tenant_id=? ORDER BY period DESC LIMIT 12', t.id), payments: pq.all('SELECT * FROM payments WHERE tenant_id=? ORDER BY id DESC LIMIT 50', t.id),
    audit: pq.all('SELECT * FROM audit WHERE tenant_id=? ORDER BY id DESC LIMIT 30', t.id),
  });
});
admin.post('/tenants', (req, res) => {
  try {
    const b = req.body || {};
    const t = createTenant({ name: String(b.name || '').trim(), planSlug: b.plan_slug });
    try { auth.createUser({ tenantId: t.id, email: b.owner_email, name: b.owner_name || '', role: 'owner', password: b.owner_password }); }
    catch (e) { pq.run('DELETE FROM tenants WHERE id=?', t.id); throw e; }
    runInTenant(t.id, () => { openTenantDb(t.id); updateSettings({ business: { name: t.name } }); });
    audit(actor(req), t.id, 'tenant.create', t.name);
    res.json(tenantRow(tenantById(t.id)));
  } catch (e) { res.status(400).json({ error: e.message }); }
});
admin.patch('/tenants/:id', (req, res) => {
  const t = tenantById(Number(req.params.id)); if (!t) return res.status(404).json({ error: 'مش موجود' });
  const b = req.body || {}; const sets = []; const vals = [];
  for (const k of ['name', 'status', 'notes']) if (b[k] !== undefined) { sets.push(`${k}=?`); vals.push(String(b[k])); }
  for (const k of ['plan_id', 'trial_ends', 'paid_until']) if (b[k] !== undefined) { sets.push(`${k}=?`); vals.push(b[k] === null ? 0 : Number(b[k])); }
  if (b.status && !['active', 'suspended'].includes(b.status)) return res.status(400).json({ error: 'حالة غير صحيحة' });
  if (b.plan_id !== undefined && !getPlan(Number(b.plan_id))) return res.status(400).json({ error: 'باقة غير موجودة' });
  if (sets.length) pq.run(`UPDATE tenants SET ${sets.join(',')} WHERE id=?`, ...vals, t.id);
  invalidateTenant(t.id); audit(actor(req), t.id, 'tenant.update', b);
  res.json(tenantRow(tenantById(t.id)));
});
admin.delete('/tenants/:id', (req, res) => {
  const t = tenantById(Number(req.params.id)); if (!t) return res.status(404).json({ error: 'مش موجود' });
  if (req.body?.confirm !== t.slug) return res.status(400).json({ error: 'اكتب الـ slug للتأكيد' });
  closeTenantDb(t.id); deleteTenantRecord(t.id); audit(actor(req), null, 'tenant.delete', `${t.name} (${t.slug})`);
  res.json({ ok: true });
});
admin.post('/tenants/:id/impersonate', (req, res) => {
  const t = tenantById(Number(req.params.id)); if (!t) return res.status(404).json({ error: 'مش موجود' });
  const owner = pq.get(`SELECT * FROM users WHERE tenant_id=? AND role='owner' ORDER BY id LIMIT 1`, t.id);
  if (!owner) return res.status(400).json({ error: 'العميل ده ملوش مالك' });
  audit(actor(req), t.id, 'impersonate.start');
  auth.setCookie(res, auth.newSession(owner, { impersonatorId: req.auth.userId }), 4 * 3600 * 1000);
  res.json({ ok: true, home: '/app/' });
});
admin.post('/tenants/:id/payments', (req, res) => {
  const t = tenantById(Number(req.params.id)); if (!t) return res.status(404).json({ error: 'مش موجود' });
  const b = req.body || {}; const months = Math.max(1, Math.min(36, Number(b.months) || 1));
  const plan = getPlan(Number(b.plan_id) || t.plan_id);
  const base = Math.max(now(), t.paid_until || 0);
  const until = base + months * 30 * DAY;
  pq.run('INSERT INTO payments(tenant_id,plan_id,amount,currency,method,reference,note,months,recorded_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
    t.id, plan.id, Number(b.amount) || 0, plan.currency, String(b.method || ''), String(b.reference || ''), String(b.note || ''), months, req.auth.userId, now());
  pq.run('UPDATE tenants SET plan_id=?, paid_until=?, status=? WHERE id=?', plan.id, until, 'active', t.id);
  pq.run(`UPDATE upgrade_requests SET status='done' WHERE tenant_id=? AND status='open'`, t.id);
  invalidateTenant(t.id); audit(actor(req), t.id, 'payment.record', { amount: b.amount, months, plan: plan.slug });
  res.json(tenantRow(tenantById(t.id)));
});
admin.post('/users/:id/password', (req, res) => {
  const u = pq.get('SELECT * FROM users WHERE id=?', req.params.id); if (!u) return res.status(404).json({ error: 'مش موجود' });
  try { auth.setUserPassword(u.id, req.body?.password); audit(actor(req), u.tenant_id, 'user.password_reset', u.email); res.json({ ok: true }); } catch (e) { res.status(400).json({ error: e.message }); }
});
admin.patch('/users/:id', (req, res) => {
  const u = pq.get('SELECT * FROM users WHERE id=?', req.params.id); if (!u) return res.status(404).json({ error: 'مش موجود' });
  if (u.id === req.auth.userId) return res.status(400).json({ error: 'ما ينفعش تعطّل حسابك' });
  if (req.body?.active !== undefined) pq.run('UPDATE users SET active=? WHERE id=?', req.body.active ? 1 : 0, u.id);
  audit(actor(req), u.tenant_id, 'user.update', { email: u.email, active: req.body?.active });
  res.json(auth.publicUser(pq.get('SELECT * FROM users WHERE id=?', u.id)));
});

/* ---------- الباقات ---------- */
admin.get('/plans', (req, res) => res.json(listPlans().map((p) => ({ ...p, tenants: pq.get('SELECT COUNT(*) n FROM tenants WHERE plan_id=?', p.id).n }))));
admin.post('/plans', (req, res) => { try { const p = savePlan(req.body || {}); audit(actor(req), null, 'plan.create', p.slug); res.json(p); } catch (e) { res.status(400).json({ error: e.message }); } });
admin.put('/plans/:id', (req, res) => {
  try { const p = savePlan(req.body || {}, Number(req.params.id)); for (const id of allTenantIds()) invalidateTenant(id); audit(actor(req), null, 'plan.update', p.slug); res.json(p); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

/* ---------- إعدادات المنصة ---------- */
admin.get('/settings', (req, res) => {
  const s = JSON.parse(JSON.stringify(getPlatformSettings()));
  if (s.ai.api_key) s.ai.api_key = '__set__';
  if (s.meta.app_secret) s.meta.app_secret = '__set__';
  s.meta.verify_code = metaConfig().verify_code;
  res.json({ ...s, ai_status: platformAiStatus() });
});
admin.put('/settings', (req, res) => {
  const patch = JSON.parse(JSON.stringify(req.body || {}));
  if (patch.ai?.api_key === '__set__') delete patch.ai.api_key;
  if (patch.meta?.app_secret === '__set__') delete patch.meta.app_secret;
  if (patch.meta) delete patch.meta.verify_code;
  setPlatformSettings(patch);
  for (const id of allTenantIds()) invalidateTenant(id);
  audit(actor(req), null, 'platform.settings', Object.keys(patch));
  res.json({ ok: true });
});

/* ---------- طلبات الترقية، تدقيق، سجلات، صحة ---------- */
admin.get('/upgrade-requests', (req, res) => res.json(pq.all(`SELECT r.*, t.name AS tenant_name, p.name AS plan_name FROM upgrade_requests r JOIN tenants t ON t.id=r.tenant_id LEFT JOIN plans p ON p.id=r.plan_id WHERE r.status='open' ORDER BY r.id DESC`)));
admin.post('/upgrade-requests/:id/dismiss', (req, res) => { pq.run(`UPDATE upgrade_requests SET status='dismissed' WHERE id=?`, req.params.id); res.json({ ok: true }); });
admin.get('/audit', (req, res) => res.json(pq.all('SELECT a.*, t.name AS tenant_name FROM audit a LEFT JOIN tenants t ON t.id=a.tenant_id ORDER BY a.id DESC LIMIT 200')));
admin.get('/logs', (req, res) => res.json(pq.all(`SELECT l.*, t.name AS tenant_name FROM plogs l LEFT JOIN tenants t ON t.id=l.tenant_id ${req.query.level ? 'WHERE l.level=?' : ''} ORDER BY l.id DESC LIMIT 300`, ...(req.query.level ? [req.query.level] : []))));
admin.get('/health', (req, res) => {
  let pending = 0; let failed = 0; let failedMsgs = 0;
  for (const id of allTenantIds()) { try { runInTenant(id, () => { const s = queueStats(); pending += s.pending; failed += s.failed; failedMsgs += q.get(`SELECT COUNT(*) n FROM messages WHERE status='failed'`).n; }); } catch { /* */ } }
  const ps = getPlatformSettings();
  let dbBytes = 0; for (const id of allTenantIds()) { try { dbBytes += fs.statSync(`${tenantDir(id)}/app.db`).size; } catch { /* */ } }
  res.json({ uptime_s: Math.round(process.uptime()), node: process.version, memory_mb: Math.round(process.memoryUsage().rss / 1048576), ai: platformAiStatus(), public_url: ps.public_url || null, queue_pending: pending, failed_jobs: failed, failed_messages: failedMsgs, tenants_db_mb: Math.round(dbBytes / 1048576 * 10) / 10 });
});
admin.get('/admins', (req, res) => res.json(pq.all(`SELECT * FROM users WHERE role='superadmin'`).map(auth.publicUser)));
admin.post('/admins', (req, res) => { try { const u = auth.createUser({ email: req.body?.email, name: req.body?.name, role: 'superadmin', password: req.body?.password }); audit(actor(req), null, 'admin.create', u.email); res.json(auth.publicUser(u)); } catch (e) { res.status(400).json({ error: e.message }); } });
