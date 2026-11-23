import { addMessage, getConversation } from '../conversations.js';
import { q, getSetting } from '../db.js';
import { enqueue } from '../queue.js';
import { absoluteUrl } from '../images.js';
import { emit } from '../events.js';
import * as meta from './meta.js';
import * as logger from '../logger.js';

const LIMITS = { messenger: 1900, instagram: 950, whatsapp: 3800, simulator: 4000 };

export function splitText(text, limit) {
  const out = []; let rest = String(text).trim();
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n\n', limit); if (cut < limit * 0.4) cut = rest.lastIndexOf('\n', limit);
    if (cut < limit * 0.4) cut = rest.lastIndexOf(' ', limit); if (cut < limit * 0.4) cut = limit;
    out.push(rest.slice(0, cut).trim()); rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/** شات بدون ماركداون (ماسنجر وواتساب مش بيعرضوه) */
export function plainText(s) {
  return String(s ?? '')
    .replace(/\*\*(.*?)\*\*/gs, '$1').replace(/__(.*?)__/gs, '$1').replace(/^#{1,6}\s*/gm, '').replace(/`([^`]*)`/g, '$1')
    .replace(/^\s*[-*]\s+/gm, '• ').replace(/\n{3,}/g, '\n\n').trim();
}

async function transmit(conv, msg) {
  if (conv.channel === 'simulator') return null;
  if (msg.attachments?.[0]?.type === 'image') return meta.sendImage(conv, absoluteUrl(msg.attachments[0].url), msg.text);
  return meta.sendText(conv, msg.text);
}

async function sendOne(conv, { text = '', attachments = [], sender, metaInfo }) {
  const msg = addMessage(conv.id, { direction: 'out', sender, text, attachments, meta: metaInfo || {}, status: 'pending' });
  try {
    const externalId = await transmit(conv, msg);
    q.run(`UPDATE messages SET status='sent', external_id=COALESCE(?, external_id) WHERE id=?`, externalId, msg.id);
    return { ok: true, id: msg.id };
  } catch (e) {
    logger.error('send', `فشل إرسال رسالة ${msg.id} على ${conv.channel}: ${e.message}`);
    q.run(`UPDATE messages SET status='failed' WHERE id=?`, msg.id);
    enqueue({ kind: 'send', payload: { message_id: msg.id }, conversationId: conv.id, delayMs: 5000 });
    return { ok: false, id: msg.id, error: e.message };
  } finally { emit('message_status', { id: msg.id, conversation_id: conv.id }); }
}

/** يبعت للعميل: صور الأول ثم النص (مقسّم حسب حد القناة) */
export async function deliver(convId, { text = '', images = [], sender = 'bot', meta: metaInfo } = {}) {
  const conv = getConversation(convId);
  const results = [];
  for (const img of images) results.push(await sendOne(conv, { text: img.caption || '', attachments: [{ type: 'image', url: img.url }], sender }));
  const chunks = text ? splitText(plainText(text), LIMITS[conv.channel] || 1900) : [];
  for (let i = 0; i < chunks.length; i++) {
    results.push(await sendOne(conv, { text: chunks[i], sender, metaInfo: i === chunks.length - 1 ? metaInfo : undefined }));
  }
  return results;
}

/** إعادة محاولة إرسال رسالة فشلت */
export async function retrySend({ message_id }) {
  const row = q.get('SELECT * FROM messages WHERE id=?', message_id);
  if (!row || row.status === 'sent') return;
  const conv = getConversation(row.conversation_id);
  const msg = { ...row, attachments: JSON.parse(row.attachments || '[]') };
  const externalId = await transmit(conv, msg);
  q.run(`UPDATE messages SET status='sent', external_id=COALESCE(?, external_id) WHERE id=?`, externalId, row.id);
}

export async function typing(convId) {
  const conv = getConversation(convId);
  if (conv && conv.channel !== 'simulator' && getSetting('bot.typing_indicator', true)) await meta.sendTyping(conv);
}
