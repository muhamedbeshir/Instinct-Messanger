import { getSetting, q } from './db.js';
import { getOrder, orderPayload, orderLines } from './orders.js';
import { money } from './util.js';
import * as logger from './logger.js';

async function post(url, body, headers = {}) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000), redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return res;
}

export async function telegram(text) {
  const token = getSetting('notifications.telegram_bot_token'); const chat = getSetting('notifications.telegram_chat_id');
  if (!token || !chat) return false;
  await post(`https://api.telegram.org/bot${token}/sendMessage`, { chat_id: chat, text });
  return true;
}

/** تنبيه لصاحب المتجر: تليجرام (لو مضبوط) + لوحة التحكم بتاخده من الأحداث */
export async function alertOwner(text) {
  try { await telegram(text); } catch (e) { logger.warn('notify', `telegram: ${e.message}`); }
}

export async function notifyOrder({ order_id }) {
  const o = getOrder(order_id);
  if (!o) return;
  await telegram(`🛒 أوردر جديد ${o.number}\n${o.customer_name} - ${o.phone}\n${o.governorate} - ${o.address}\n${orderLines(o)}\nالإجمالي: ${money(o.total)} (شحن ${money(o.shipping)})\nالقناة: ${o.channel}`);
}

/** يبعت الأوردر للـ webhook (مثلًا Google Apps Script اللي بيضيفه في شيت) */
export async function exportOrder({ order_id }) {
  const o = getOrder(order_id);
  const url = getSetting('notifications.order_webhook_url');
  if (!o || !url) return;
  const secret = getSetting('notifications.order_webhook_secret');
  await post(url, { ...orderPayload(o), secret: secret || undefined }, secret ? { 'x-webhook-secret': secret } : {});
  q.run('UPDATE orders SET exported=1 WHERE id=?', o.id);
}
