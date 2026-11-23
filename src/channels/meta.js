import crypto from 'node:crypto';
import { getSetting } from '../db.js';
import { addMessage, findOrCreateConversation, getConversation, saveConversation, botIsPausedFor } from '../conversations.js';
import { enqueueReply } from '../queue.js';
import { q } from '../db.js';
import { now } from '../util.js';
import { saveInboundImage, downloadImage } from '../images.js';
import { emit } from '../events.js';
import * as logger from '../logger.js';

const graph = (p) => `https://graph.facebook.com/${getSetting('channels.graph_version', 'v21.0')}${p}`;

/* ---------------- إرسال ---------------- */
function tokenFor(channel) {
  if (channel === 'messenger') return getSetting('channels.messenger.page_access_token');
  if (channel === 'instagram') return getSetting('channels.instagram.access_token') || getSetting('channels.messenger.page_access_token');
  if (channel === 'whatsapp') return getSetting('channels.whatsapp.access_token');
  return '';
}

async function call(url, token, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Meta API ${res.status}: ${data?.error?.message || JSON.stringify(data).slice(0, 200)}`);
  return data;
}

export async function sendText(conv, text) {
  const token = tokenFor(conv.channel);
  if (!token) throw new Error(`قناة ${conv.channel} مش متوصلة (مفيش Access Token)`);
  if (conv.channel === 'whatsapp') {
    const id = getSetting('channels.whatsapp.phone_number_id');
    const d = await call(graph(`/${id}/messages`), token, { messaging_product: 'whatsapp', to: conv.external_id, type: 'text', text: { body: text, preview_url: true } });
    return d.messages?.[0]?.id || null;
  }
  const d = await call(graph('/me/messages'), token, { recipient: { id: conv.external_id }, messaging_type: 'RESPONSE', message: { text } });
  return d.message_id || null;
}

export async function sendImage(conv, url, caption = '') {
  const token = tokenFor(conv.channel);
  if (!token) throw new Error(`قناة ${conv.channel} مش متوصلة`);
  if (conv.channel === 'whatsapp') {
    const id = getSetting('channels.whatsapp.phone_number_id');
    const d = await call(graph(`/${id}/messages`), token, { messaging_product: 'whatsapp', to: conv.external_id, type: 'image', image: { link: url, caption: caption || undefined } });
    return d.messages?.[0]?.id || null;
  }
  const d = await call(graph('/me/messages'), token, { recipient: { id: conv.external_id }, messaging_type: 'RESPONSE', message: { attachment: { type: 'image', payload: { url, is_reusable: true } } } });
  return d.message_id || null;
}

export async function sendTyping(conv) {
  if (conv.channel === 'whatsapp') return;
  const token = tokenFor(conv.channel);
  if (!token) return;
  await call(graph('/me/messages'), token, { recipient: { id: conv.external_id }, sender_action: 'typing_on' }).catch(() => {});
}

export async function fetchProfileName(channel, id) {
  const token = tokenFor(channel);
  if (!token || channel === 'whatsapp') return '';
  try {
    const res = await fetch(graph(`/${id}?fields=${channel === 'instagram' ? 'name,username' : 'name'}`), { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) });
    const d = await res.json();
    return d.name || d.username || '';
  } catch { return ''; }
}

/* ---------------- استقبال ---------------- */
export function verifySignature(rawBody, header) {
  const secret = getSetting('channels.app_secret');
  if (!secret) return true; // لو مفيش App Secret متحققناش (نحذّر في صفحة الصحة)
  if (!header || !header.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const given = header.slice(7);
  return given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

export function verifyChallenge(query) {
  if (query['hub.mode'] === 'subscribe' && query['hub.verify_token'] === getSetting('channels.verify_code')) return query['hub.challenge'];
  return null;
}

async function ingest({ channel, userId, name, mid, text, attachments, isEcho }) {
  const enabled = getSetting(`channels.${channel}.enabled`);
  if (!enabled) return;
  const conv = findOrCreateConversation(channel, userId, name);
  if (isEcho) {
    // رد من موظف من صندوق الصفحة. لو هو رد البوت نفسه نتجاهله
    const recentBot = q.get(`SELECT id FROM messages WHERE conversation_id=? AND direction='out' AND text=? AND created_at>?`, conv.id, text, now() - 60000);
    if (recentBot || (mid && q.get('SELECT id FROM messages WHERE conversation_id=? AND external_id=?', conv.id, mid))) return;
    addMessage(conv.id, { direction: 'out', sender: 'human', text, attachments, external_id: mid });
    const mins = getSetting('bot.human_takeover_minutes', 60);
    if (mins > 0) saveConversation(conv.id, { paused_until: now() + mins * 60000 });
    return;
  }
  const msg = addMessage(conv.id, { direction: 'in', sender: 'customer', text, attachments, external_id: mid });
  if (!msg) return; // مكررة
  q.run('UPDATE conversations SET unread=unread+1 WHERE id=?', conv.id);
  emit('conversation', { id: conv.id });
  if (!conv.display_name) {
    fetchProfileName(channel, userId).then((n) => { if (n) q.run('UPDATE conversations SET display_name=? WHERE id=?', n, conv.id); }).catch(() => {});
  }
  const fresh = getConversation(conv.id);
  if (getSetting('bot.enabled', true) && !botIsPausedFor(fresh)) enqueueReply(conv.id);
}

async function savePicture(url, headers) {
  try { const d = await downloadImage(url, headers); return saveInboundImage(d.buffer, d.contentType); } catch (e) { logger.warn('meta', `تحميل صورة العميل فشل: ${e.message}`); return null; }
}

async function handleMessagingEvents(channel, events) {
  for (const ev of events) {
    const m = ev.message;
    if (!m) continue; // delivery/read/postback...
    const userId = m.is_echo ? ev.recipient?.id : ev.sender?.id;
    if (!userId) continue;
    let text = m.text || '';
    const atts = [];
    for (const a of m.attachments || []) {
      if (a.type === 'image' && a.payload?.url) {
        const local = await savePicture(a.payload.url);
        atts.push({ type: 'image', local, url: a.payload.url });
      } else if (a.type === 'audio') text += ' [العميل بعت رسالة صوتية - اطلب منه يكتب طلبه]';
      else if (a.type === 'location' && a.payload?.coordinates) text += ` [موقع العميل: https://maps.google.com/?q=${a.payload.coordinates.lat},${a.payload.coordinates.long}]`;
      else text += ` [${a.type}]`;
    }
    await ingest({ channel, userId, mid: m.mid, text: text.trim(), attachments: atts, isEcho: Boolean(m.is_echo) });
  }
}

async function handleWhatsApp(entries) {
  const token = getSetting('channels.whatsapp.access_token');
  for (const entry of entries) {
    for (const ch of entry.changes || []) {
      const v = ch.value || {};
      const names = Object.fromEntries((v.contacts || []).map((c) => [c.wa_id, c.profile?.name || '']));
      for (const m of v.messages || []) {
        let text = ''; const atts = [];
        if (m.type === 'text') text = m.text?.body || '';
        else if (m.type === 'image') {
          text = m.image?.caption || '';
          try {
            const meta = await (await fetch(graph(`/${m.image.id}`), { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) })).json();
            const local = meta.url ? await savePicture(meta.url, { authorization: `Bearer ${token}` }) : null;
            atts.push({ type: 'image', local });
          } catch (e) { logger.warn('whatsapp', `media: ${e.message}`); atts.push({ type: 'image', local: null }); }
        } else if (m.type === 'interactive') text = m.interactive?.button_reply?.title || m.interactive?.list_reply?.title || '';
        else if (m.type === 'button') text = m.button?.text || '';
        else if (m.type === 'location') text = `[موقع العميل: https://maps.google.com/?q=${m.location.latitude},${m.location.longitude}] ${m.location.address || ''}`;
        else if (m.type === 'audio') text = '[العميل بعت رسالة صوتية - اطلب منه يكتب طلبه]';
        else text = `[${m.type}]`;
        await ingest({ channel: 'whatsapp', userId: m.from, name: names[m.from], mid: m.id, text: text.trim(), attachments: atts });
      }
    }
  }
}

export async function handleWebhook(body) {
  if (body.object === 'page') for (const e of body.entry || []) await handleMessagingEvents('messenger', e.messaging || []);
  else if (body.object === 'instagram') for (const e of body.entry || []) await handleMessagingEvents('instagram', e.messaging || []);
  else if (body.object === 'whatsapp_business_account') await handleWhatsApp(body.entry || []);
}

/* اختبار الاتصال من لوحة التحكم */
export async function testChannel(channel) {
  const token = tokenFor(channel);
  if (!token) return { ok: false, error: 'مفيش Access Token' };
  try {
    const url = channel === 'whatsapp' ? graph(`/${getSetting('channels.whatsapp.phone_number_id')}?fields=display_phone_number,verified_name`) : graph('/me?fields=id,name');
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) });
    const d = await res.json();
    if (!res.ok) return { ok: false, error: d?.error?.message || `HTTP ${res.status}` };
    return { ok: true, info: d };
  } catch (e) { return { ok: false, error: e.message }; }
}
