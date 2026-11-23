import crypto from 'node:crypto';
import { pq, createTenant, tenantById, getPlatformSettings, audit, invalidateTenant } from './platform.js';
import { ENV_SUPERADMIN_EMAIL, ENV_SUPERADMIN_PASSWORD } from './config.js';
import { runInTenant } from './tenancy.js';
import { openTenantDb, updateSettings } from './db.js';
import { now } from './util.js';

const COOKIE = 'im_session';
const TTL = 14 * 24 * 3600 * 1000;

/* ---------------- كلمات السر ---------------- */
const hash = (pw, salt = crypto.randomBytes(16).toString('hex')) => `${salt}:${crypto.scryptSync(String(pw), salt, 64).toString('hex')}`;
function verify(pw, stored) {
  const [salt, h] = String(stored).split(':');
  const x = Buffer.from(crypto.scryptSync(String(pw), salt, 64).toString('hex')); const y = Buffer.from(h || '');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
export const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export function checkPasswordStrength(pw) {
  if (String(pw || '').length < 8) throw new Error('كلمة السر لازم تكون 8 حروف على الأقل');
}

/* ---------------- مستخدمين ---------------- */
export function createUser({ tenantId = null, email, name = '', role, password }) {
  email = String(email || '').trim().toLowerCase();
  if (!EMAIL_RX.test(email)) throw new Error('الإيميل مش صحيح');
  checkPasswordStrength(password);
  if (pq.get('SELECT 1 FROM users WHERE email=?', email)) throw new Error('الإيميل ده مسجّل قبل كده');
  const r = pq.run('INSERT INTO users(tenant_id,email,name,role,password_hash,created_at) VALUES(?,?,?,?,?,?)', tenantId, email, name, role, hash(password), now());
  return pq.get('SELECT * FROM users WHERE id=?', r.lastInsertRowid);
}
export function setUserPassword(userId, password) {
  checkPasswordStrength(password);
  pq.run('UPDATE users SET password_hash=? WHERE id=?', hash(password), userId);
  pq.run('DELETE FROM sessions WHERE user_id=?', userId);
}
export const publicUser = (u) => u && ({ id: u.id, email: u.email, name: u.name, role: u.role, tenant_id: u.tenant_id, active: u.active, last_login: u.last_login, created_at: u.created_at });

/** تسجيل متجر جديد: عميل + مالك + قاعدة بياناته (اسم المتجر بيتحط في إعداداته) */
export function signup({ businessName, email, password, name = '' }) {
  if (!getPlatformSettings().signup.open) throw new Error('التسجيل مقفول حاليًا');
  businessName = String(businessName || '').trim();
  if (businessName.length < 2) throw new Error('اكتب اسم المتجر');
  checkPasswordStrength(password);
  const t = createTenant({ name: businessName });
  let user;
  try { user = createUser({ tenantId: t.id, email, name, role: 'owner', password }); }
  catch (e) { pq.run('DELETE FROM tenants WHERE id=?', t.id); throw e; }
  runInTenant(t.id, () => { openTenantDb(t.id); updateSettings({ business: { name: businessName } }); });
  audit(user.email, t.id, 'tenant.signup', businessName);
  return { tenant: tenantById(t.id), user };
}

export function login(email, password) {
  const u = pq.get('SELECT * FROM users WHERE email=?', String(email || '').trim().toLowerCase());
  if (!u || !u.active || !verify(password || '', u.password_hash)) return null;
  pq.run('UPDATE users SET last_login=? WHERE id=?', now(), u.id);
  return u;
}

/* ---------------- جلسات ---------------- */
export function newSession(user, { impersonatorId = null } = {}) {
  const token = crypto.randomBytes(32).toString('hex');
  pq.run('INSERT INTO sessions(token,user_id,tenant_id,role,impersonator_id,expires_at) VALUES(?,?,?,?,?,?)', token, user.id, user.tenant_id, user.role, impersonatorId, now() + (impersonatorId ? 4 * 3600 * 1000 : TTL));
  pq.run('DELETE FROM sessions WHERE expires_at<?', now());
  return token;
}
export const destroySession = (t) => pq.run('DELETE FROM sessions WHERE token=?', t);
export function cookieToken(req) {
  const m = String(req.headers.cookie || '').match(new RegExp(`(?:^|; )${COOKIE}=([a-f0-9]+)`));
  return m ? m[1] : null;
}
export function authFromReq(req) {
  const token = cookieToken(req);
  if (!token) return null;
  const s = pq.get('SELECT * FROM sessions WHERE token=?', token);
  if (!s || s.expires_at < now()) return null;
  const user = pq.get('SELECT * FROM users WHERE id=?', s.user_id);
  if (!user || !user.active) return null;
  return { token, user, userId: user.id, tenantId: s.tenant_id, role: s.role, impersonatorId: s.impersonator_id, platformAdmin: s.role === 'superadmin' || Boolean(s.impersonator_id) };
}
export const setCookie = (res, token, ttl = TTL) => res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(ttl / 1000)}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
export const clearCookie = (res) => res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);

/* ---------------- حماية: محاولات الدخول ---------------- */
const attempts = new Map();
export function rateOk(key, max = 8, windowMs = 15 * 60000) {
  const a = attempts.get(key);
  if (!a || now() - a.t > windowMs) return true;
  return a.n < max;
}
export function rateHit(key, ok, windowMs = 15 * 60000) {
  if (ok === true) { attempts.delete(key); return; }
  const a = attempts.get(key);
  if (!a || now() - a.t > windowMs) attempts.set(key, { n: 1, t: now() }); else a.n++;
}

/* ---------------- Middleware ---------------- */
export function attach(req, res, next) { req.auth = authFromReq(req); next(); }
export const requireSuperadmin = (req, res, next) => (req.auth?.role === 'superadmin' ? next() : res.status(req.auth ? 403 : 401).json({ error: 'غير مصرّح' }));

// صلاحيات الموظف (staff): الأوردرات والمحادثات والرد على الأسئلة وقراءة الكتالوج فقط
const STAFF_OK = [
  /^GET \/(me|overview|orders|conversations|products|categories-with-counts|knowledge|unanswered|shipping|events|inbound)/,
  /^PATCH \/orders\/\d+$/, /^POST \/conversations\/\d+\/(send|pause|resolve|save-knowledge)$/, /^POST \/unanswered\/\d+\/(answer|dismiss)$/,
  /^POST \/orders\/\d+\/resend$/, /^POST \/sim\//,
];
// حالات يتسمح فيها بالقراءة فقط (اشتراك منتهي/موقوف)
const READONLY_OK = [/^GET /, /^POST \/billing\/upgrade$/, /^POST \/auth\//];

import { tenantInfo } from './platform.js';
/** يدخّل الطلب سياق العميل (قاعدة بياناته)، ويطبّق صلاحيات الدور وحالة الاشتراك */
export function requireTenantUser(req, res, next) {
  const a = req.auth;
  if (!a || !a.tenantId || !['owner', 'staff'].includes(a.role)) return res.status(401).json({ error: 'غير مسجّل الدخول' });
  const info = tenantInfo(a.tenantId);
  const key = `${req.method} ${req.path}`;
  if (a.role === 'staff' && !STAFF_OK.some((r) => r.test(key))) return res.status(403).json({ error: 'الصلاحية دي للمالك فقط' });
  if (info.status !== 'active' && !a.platformAdmin && !READONLY_OK.some((r) => r.test(key))) {
    return res.status(402).json({ error: info.status === 'suspended' ? 'الحساب موقوف. تواصل مع الدعم.' : 'الاشتراك انتهى. جدّد باقتك عشان تكمل التعديل.', code: info.status });
  }
  pq.run('UPDATE tenants SET last_seen=? WHERE id=? AND last_seen<?', now(), a.tenantId, now() - 60000);
  req.tenant = info;
  return runInTenant(a.tenantId, next);
}

/* ---------------- السوبر أدمن الأول ---------------- */
let setupCode = null;
export const getSetupCode = () => setupCode;
export function ensureSuperadmin(log = console.log) {
  if (ENV_SUPERADMIN_EMAIL && ENV_SUPERADMIN_PASSWORD) {
    const u = pq.get('SELECT * FROM users WHERE email=?', ENV_SUPERADMIN_EMAIL.toLowerCase());
    if (!u) createUser({ email: ENV_SUPERADMIN_EMAIL, name: 'Super Admin', role: 'superadmin', password: ENV_SUPERADMIN_PASSWORD });
    else if (u.role === 'superadmin' && !verify(ENV_SUPERADMIN_PASSWORD, u.password_hash)) pq.run('UPDATE users SET password_hash=? WHERE id=?', hash(ENV_SUPERADMIN_PASSWORD), u.id);
    return;
  }
  if (!pq.get(`SELECT 1 FROM users WHERE role='superadmin'`)) {
    setupCode = crypto.randomBytes(5).toString('hex');
    log(`لا يوجد سوبر أدمن. افتح /admin/ واستخدم كود الإعداد: ${setupCode}  (أو اضبط SUPERADMIN_EMAIL و SUPERADMIN_PASSWORD)`);
  }
}
export function setupSuperadmin({ code, email, password }) {
  if (!setupCode || String(code) !== setupCode) throw new Error('كود الإعداد غلط');
  const u = createUser({ email, name: 'Super Admin', role: 'superadmin', password });
  setupCode = null;
  return u;
}
export { invalidateTenant };
