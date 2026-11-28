import crypto from 'node:crypto';
import { getSettings, updateSettings } from '../db.js';
import { getPlatformSettings, metaConfig, linkChannel, unlinkChannel, linksOf, limitOf, hasFeature, tenantInfo } from '../platform.js';
import { currentTenantId } from '../tenancy.js';
import { graphUrl } from './graph.js';
import * as logger from '../logger.js';

/**
 * ربط ماسنجر وإنستجرام وواتساب بزرار واحد (Embedded Signup / Facebook Login for Business) بتطبيق ميتا واحد للمنصة.
 * العميل بيوافق في نافذة ميتا، والسيرفر بيبدّل الكود بتوكن ويحفظه. التوكنات ما بتوصلش للمتصفح.
 */
const ver = () => metaConfig().graph_version || 'v21.0';
async function graph(method, path, { token, params, body } = {}) {
  const url = new URL(graphUrl(path, ver()));
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  const res = await fetch(url, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Meta: ${data?.error?.message || res.status}`);
  return data;
}

export async function exchangeCode(code) {
  const m = metaConfig();
  const d = await graph('GET', '/oauth/access_token', { params: { client_id: m.app_id, client_secret: m.app_secret, code } });
  if (!d.access_token) throw new Error('ميتا ما رجّعتش توكن');
  return d.access_token;
}

/* تذاكر قصيرة العمر تحمل توكن المستخدم على السيرفر (عشان ما يمرّش على المتصفح) */
const tickets = new Map();
function putTicket(tenantId, token, pages) {
  const id = crypto.randomBytes(16).toString('hex');
  tickets.set(id, { tenantId, token, pages, exp: Date.now() + 10 * 60000 });
  for (const [k, v] of tickets) if (v.exp < Date.now()) tickets.delete(k);
  return id;
}
function takeTicket(id) {
  const t = tickets.get(id);
  if (!t || t.exp < Date.now() || t.tenantId !== currentTenantId()) throw new Error('انتهت صلاحية الجلسة، ابدأ الربط من الأول.');
  return t;
}

export async function pagesFromCode(code) {
  const token = await exchangeCode(code);
  const d = await graph('GET', '/me/accounts', { token, params: { fields: 'id,name,access_token,instagram_business_account{id,username}', limit: '50' } });
  const pages = (d.data || []).map((p) => ({ id: p.id, name: p.name, access_token: p.access_token, instagram: p.instagram_business_account ? { id: p.instagram_business_account.id, username: p.instagram_business_account.username } : null }));
  if (!pages.length) throw new Error('مفيش صفحات فيسبوك على الحساب ده، أو ما اديتش صلاحية الوصول للصفحة.');
  const ticket = putTicket(currentTenantId(), token, pages);
  return { ticket, pages: pages.map(({ id, name, instagram }) => ({ id, name, instagram })) };
}

function checkPlan(channel, alsoEnabling = 0) {
  const info = tenantInfo(); const st = getSettings().channels;
  if (channel !== 'messenger' && !hasFeature(info, channel)) throw new Error('القناة دي مش متاحة في باقتك.');
  const on = ['messenger', 'instagram', 'whatsapp'].filter((c) => st[c].enabled && c !== channel).length + 1 + alsoEnabling;
  const lim = limitOf(info, 'channels');
  if (lim >= 0 && on > lim) throw new Error(`باقتك بتسمح بـ ${lim} قناة بس. رقّي الباقة لتفعيل المزيد.`);
}

/** يربط الصفحة (ماسنجر) ولو فيها إنستجرام بيربطه كمان لو طُلب */
export async function connectPage({ ticket, page_id, with_instagram = true }) {
  const t = takeTicket(ticket);
  const page = t.pages.find((p) => p.id === String(page_id));
  if (!page) throw new Error('الصفحة مش من اللي اخترتها');
  checkPlan('messenger');
  const tid = currentTenantId();
  linkChannel(tid, 'messenger', page.id, page.name);
  await graph('POST', `/${page.id}/subscribed_apps`, { token: page.access_token, params: { subscribed_fields: 'messages,message_echoes,messaging_postbacks' } });
  const patch = { messenger: { enabled: true, page_access_token: page.access_token, page_id: page.id, page_name: page.name } };
  let igLinked = null;
  if (with_instagram && page.instagram) {
    try { checkPlan('instagram', patch.messenger.enabled && !getSettings().channels.messenger.enabled ? 1 : 0); linkChannel(tid, 'instagram', page.instagram.id, page.instagram.username || ''); patch.instagram = { enabled: true, access_token: page.access_token, account_id: page.instagram.id, account_name: page.instagram.username || '' }; igLinked = page.instagram.username || page.instagram.id; }
    catch (e) { logger.warn('connect', `إنستجرام ما اتربطش: ${e.message}`); }
  }
  updateSettings({ channels: patch });
  tickets.delete(ticket);
  return { messenger: page.name, instagram: igLinked };
}

export async function connectWhatsapp({ code, waba_id, phone_number_id }) {
  if (!code || !waba_id || !phone_number_id) throw new Error('بيانات واتساب ناقصة من ميتا');
  checkPlan('whatsapp');
  const token = await exchangeCode(code);
  linkChannel(currentTenantId(), 'whatsapp', phone_number_id, String(waba_id));
  await graph('POST', `/${waba_id}/subscribed_apps`, { token });
  updateSettings({ channels: { whatsapp: { enabled: true, access_token: token, phone_number_id: String(phone_number_id), waba_id: String(waba_id) } } });
  return { phone_number_id: String(phone_number_id) };
}

export function disconnect(channel) {
  if (!['messenger', 'instagram', 'whatsapp'].includes(channel)) throw new Error('قناة غير معروفة');
  unlinkChannel(currentTenantId(), channel);
  const clear = { messenger: { enabled: false, page_access_token: '', page_id: '', page_name: '' }, instagram: { enabled: false, access_token: '', account_id: '', account_name: '' }, whatsapp: { enabled: false, access_token: '', phone_number_id: '', waba_id: '' } }[channel];
  updateSettings({ channels: { [channel]: clear } });
}

export function connectInfo() {
  const m = metaConfig(); const ps = getPlatformSettings();
  return {
    available: Boolean(m.app_id && m.app_secret), app_id: m.app_id || null, graph_version: m.graph_version,
    config_id_whatsapp: m.config_id_whatsapp || null, config_id_messenger: m.config_id_messenger || null,
    links: linksOf(currentTenantId()), webhook_managed_by_platform: Boolean(ps.public_url),
  };
}
