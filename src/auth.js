import crypto from 'node:crypto';
import { q, getRaw, setRaw } from './db.js';
import { ENV_ADMIN_PASSWORD } from './config.js';
import { now } from './util.js';

const COOKIE = 'im_session';
const TTL = 14 * 24 * 3600 * 1000;

function hash(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(String(pw), salt, 64).toString('hex') };
}
const safeEq = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

export const isSetup = () => Boolean(ENV_ADMIN_PASSWORD || getRaw('_auth'));

export function setPassword(pw) {
  if (String(pw).length < 6) throw new Error('الباسورد لازم يكون 6 حروف على الأقل');
  setRaw('_auth', hash(pw));
}

export function checkPassword(pw) {
  if (ENV_ADMIN_PASSWORD) return safeEq(pw, ENV_ADMIN_PASSWORD);
  const a = getRaw('_auth');
  if (!a) return false;
  return safeEq(hash(pw, a.salt).hash, a.hash);
}

const attempts = new Map();
export function loginAllowed(ip) {
  const a = attempts.get(ip) || { n: 0, t: now() };
  if (now() - a.t > 15 * 60000) { attempts.delete(ip); return true; }
  return a.n < 8;
}
export function recordAttempt(ip, ok) {
  if (ok) { attempts.delete(ip); return; }
  const a = attempts.get(ip) || { n: 0, t: now() };
  a.n++; attempts.set(ip, a);
}

export function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  q.run('INSERT INTO sessions(token, expires_at) VALUES(?,?)', token, now() + TTL);
  q.run('DELETE FROM sessions WHERE expires_at<?', now());
  return token;
}
export const destroySession = (t) => q.run('DELETE FROM sessions WHERE token=?', t);

function cookieToken(req) {
  const m = String(req.headers.cookie || '').match(new RegExp(`(?:^|; )${COOKIE}=([a-f0-9]+)`));
  return m ? m[1] : null;
}
export function isAuthed(req) {
  const t = cookieToken(req);
  if (!t) return false;
  const s = q.get('SELECT expires_at FROM sessions WHERE token=?', t);
  return Boolean(s && s.expires_at > now());
}
export const setCookie = (res, token) => res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${TTL / 1000}`);
export const clearCookie = (res) => res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
export const currentToken = cookieToken;

export function requireAuth(req, res, next) {
  if (isAuthed(req)) return next();
  res.status(401).json({ error: 'غير مسجّل الدخول' });
}
