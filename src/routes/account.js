import express from 'express';
import * as auth from '../auth.js';
import { pq, listPlans, getPlan, getPlatformSettings, tenantInfo, usageOf, limitOf, audit } from '../platform.js';
import { q } from '../db.js';
import { emit } from '../events.js';
import { now } from '../util.js';

/** حسابي: بياناتي، اشتراكي واستهلاكي، فريق العمل. (جوه سياق العميل) */
export const account = express.Router();
const ownerOnly = (req, res, next) => (req.auth.role === 'owner' ? next() : res.status(403).json({ error: 'الصلاحية دي للمالك فقط' }));
const publicTenant = (info) => ({ name: info.name, slug: info.slug, status: info.status, days_left: info.days_left, plan: { slug: info.plan.slug, name: info.plan.name, price: info.plan.price }, created_at: info.created_at });

account.get('/me', (req, res) => {
  const info = req.tenant; const ps = getPlatformSettings();
  const u = usageOf(); const lim = (k) => limitOf(info, k);
  res.json({
    user: auth.publicUser(req.auth.user), role: req.auth.role, platform_admin: Boolean(req.auth.platformAdmin), impersonating: Boolean(req.auth.impersonatorId),
    tenant: publicTenant(info), brand: ps.brand.name, announcement: ps.announcement.text ? ps.announcement : null,
    limits: { products: lim('products'), ai_replies: lim('ai_replies'), channels: lim('channels'), staff: lim('staff') },
    usage: { ai_replies: u.ai_replies, orders: u.orders, messages_in: u.messages_in, products: q.get('SELECT COUNT(*) AS n FROM products').n },
    support: ps.support,
  });
});

account.get('/billing', ownerOnly, (req, res) => {
  const info = req.tenant; const ps = getPlatformSettings();
  res.json({
    tenant: publicTenant(info), paid_until: info.paid_until || null, trial_ends: info.trial_ends || null,
    usage: usageOf(), limits: info.plan.limits, features: info.plan.features,
    plans: listPlans({ publicOnly: true }).map((p) => ({ id: p.id, slug: p.slug, name: p.name, price: p.price, currency: p.currency, description: p.description, limits: p.limits })),
    payment_instructions: ps.payment_instructions, support: ps.support,
    open_request: pq.get(`SELECT * FROM upgrade_requests WHERE tenant_id=? AND status='open' ORDER BY id DESC LIMIT 1`, info.id) || null,
    payments: pq.all('SELECT amount, currency, method, reference, months, created_at FROM payments WHERE tenant_id=? ORDER BY id DESC LIMIT 20', info.id),
  });
});

account.post('/billing/upgrade', ownerOnly, (req, res) => {
  const plan = getPlan(Number(req.body?.plan_id));
  if (!plan || !plan.active) return res.status(400).json({ error: 'الباقة مش موجودة' });
  pq.run(`UPDATE upgrade_requests SET status='replaced' WHERE tenant_id=? AND status='open'`, req.tenant.id);
  pq.run('INSERT INTO upgrade_requests(tenant_id,plan_id,note,created_at) VALUES(?,?,?,?)', req.tenant.id, plan.id, String(req.body?.note || '').slice(0, 500), now());
  audit(req.auth.user.email, req.tenant.id, 'upgrade.request', plan.slug);
  res.json({ ok: true });
});

/* ---------- الفريق ---------- */
account.get('/team', ownerOnly, (req, res) => res.json(pq.all('SELECT * FROM users WHERE tenant_id=? ORDER BY id', req.tenant.id).map(auth.publicUser)));
account.post('/team', ownerOnly, (req, res) => {
  const lim = limitOf(req.tenant, 'staff');
  const n = pq.get(`SELECT COUNT(*) AS n FROM users WHERE tenant_id=? AND role='staff' AND active=1`, req.tenant.id).n;
  if (lim >= 0 && n >= lim) return res.status(402).json({ error: `باقتك بتسمح بـ ${lim} موظف. رقّي الباقة لإضافة المزيد.` });
  try { const u = auth.createUser({ tenantId: req.tenant.id, email: req.body?.email, name: req.body?.name, role: 'staff', password: req.body?.password }); res.json(auth.publicUser(u)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
account.patch('/team/:id', ownerOnly, (req, res) => {
  const u = pq.get(`SELECT * FROM users WHERE id=? AND tenant_id=? AND role='staff'`, req.params.id, req.tenant.id);
  if (!u) return res.status(404).json({ error: 'مش موجود' });
  if (req.body?.active !== undefined) pq.run('UPDATE users SET active=? WHERE id=?', req.body.active ? 1 : 0, u.id);
  if (req.body?.name !== undefined) pq.run('UPDATE users SET name=? WHERE id=?', String(req.body.name), u.id);
  if (req.body?.password) { try { auth.setUserPassword(u.id, req.body.password); } catch (e) { return res.status(400).json({ error: e.message }); } }
  res.json(auth.publicUser(pq.get('SELECT * FROM users WHERE id=?', u.id)));
});
account.delete('/team/:id', ownerOnly, (req, res) => {
  pq.run(`DELETE FROM users WHERE id=? AND tenant_id=? AND role='staff'`, req.params.id, req.tenant.id);
  res.json({ ok: true });
});
void tenantInfo; void emit;
