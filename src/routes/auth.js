import express from 'express';
import * as auth from '../auth.js';
import { pq, listPlans, getPlatformSettings, tenantInfo, audit } from '../platform.js';
import { now } from '../util.js';

/** مسارات عامة: تسجيل متجر، دخول، خروج، باقات */
export const authRouter = express.Router();

const home = (role) => (role === 'superadmin' ? '/admin/' : '/app/');

authRouter.get('/auth/status', (req, res) => {
  const ps = getPlatformSettings();
  res.json({
    authed: Boolean(req.auth), role: req.auth?.role || null, home: req.auth ? home(req.auth.role) : null,
    signup_open: ps.signup.open, brand: ps.brand.name, has_superadmin: Boolean(pq.get(`SELECT 1 FROM users WHERE role='superadmin'`)),
    setup_needed: !pq.get(`SELECT 1 FROM users WHERE role='superadmin'`) && Boolean(auth.getSetupCode()),
  });
});

authRouter.get('/plans', (req, res) => {
  res.json(listPlans({ publicOnly: true }).map((p) => ({ slug: p.slug, name: p.name, price: p.price, currency: p.currency, trial_days: p.trial_days, description: p.description, limits: p.limits, features: p.features })));
});

authRouter.post('/auth/signup', (req, res) => {
  const ip = `signup:${req.ip}`;
  if (!auth.rateOk(ip, 5, 3600000)) return res.status(429).json({ error: 'محاولات تسجيل كتير. جرّب بعد شوية.' });
  try {
    const { tenant, user } = auth.signup(req.body || {});
    auth.rateHit(ip, false, 3600000);
    auth.setCookie(res, auth.newSession(user));
    res.json({ ok: true, home: '/app/', tenant: { name: tenant.name, slug: tenant.slug } });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

authRouter.post('/auth/login', (req, res) => {
  const key = `login:${req.ip}:${String(req.body?.email || '').toLowerCase()}`;
  if (!auth.rateOk(key)) return res.status(429).json({ error: 'محاولات كتير. جرّب بعد شوية.' });
  const u = auth.login(req.body?.email, req.body?.password);
  auth.rateHit(key, Boolean(u));
  if (!u) return res.status(401).json({ error: 'الإيميل أو الباسورد غلط' });
  auth.setCookie(res, auth.newSession(u));
  res.json({ ok: true, role: u.role, home: home(u.role) });
});

authRouter.post('/auth/logout', (req, res) => {
  const t = auth.cookieToken(req); if (t) auth.destroySession(t); auth.clearCookie(res); res.json({ ok: true });
});

authRouter.post('/auth/setup-admin', (req, res) => {
  const key = `setup:${req.ip}`;
  if (!auth.rateOk(key, 5)) return res.status(429).json({ error: 'محاولات كتير' });
  try { const u = auth.setupSuperadmin(req.body || {}); auth.setCookie(res, auth.newSession(u)); res.json({ ok: true, home: '/admin/' }); }
  catch (e) { auth.rateHit(key, false); res.status(400).json({ error: e.message }); }
});

// السوبر أدمن بيخرج من "الدخول كعميل" ويرجع لحسابه
authRouter.post('/auth/stop-impersonating', (req, res) => {
  if (!req.auth?.impersonatorId) return res.status(400).json({ error: 'مش داخل كعميل' });
  const admin = pq.get('SELECT * FROM users WHERE id=?', req.auth.impersonatorId);
  auth.destroySession(req.auth.token);
  audit(admin.email, req.auth.tenantId, 'impersonate.stop');
  auth.setCookie(res, auth.newSession(admin));
  res.json({ ok: true, home: '/admin/' });
});

authRouter.post('/auth/change-password', (req, res) => {
  if (!req.auth) return res.status(401).json({ error: 'غير مسجّل' });
  const u = auth.login(req.auth.user.email, req.body?.current);
  if (!u) return res.status(401).json({ error: 'الباسورد الحالي غلط' });
  try { auth.setUserPassword(u.id, req.body?.password); auth.setCookie(res, auth.newSession(u)); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
