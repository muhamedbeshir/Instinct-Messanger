import ExcelJS from 'exceljs';
import { q, hydrate, hydrateAll, getSetting } from './db.js';
import { now, escapeCsv } from './util.js';
import { emit } from './events.js';
import { enqueue } from './queue.js';

export function listOrders({ status = '', search = '', limit = 300 } = {}) {
  const where = []; const args = [];
  if (status) { where.push('status=?'); args.push(status); }
  if (search) { where.push('(number LIKE ? OR customer_name LIKE ? OR phone LIKE ?)'); args.push(`%${search}%`, `%${search}%`, `%${search}%`); }
  return hydrateAll('orders', q.all(`SELECT * FROM orders ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`, ...args, limit));
}
export const getOrder = (id) => hydrate('orders', q.get('SELECT * FROM orders WHERE id=?', id));

export function updateOrder(id, patch) {
  const cur = getOrder(id);
  if (!cur) return null;
  const allowed = ['status', 'notes', 'customer_name', 'phone', 'governorate', 'address', 'payment_method'];
  const sets = []; const vals = [];
  for (const k of allowed) if (patch[k] !== undefined) { sets.push(`${k}=?`); vals.push(patch[k]); }
  if (sets.length) q.run(`UPDATE orders SET ${sets.join(', ')}, updated_at=? WHERE id=?`, ...vals, now(), id);
  const next = getOrder(id);
  if (patch.status && patch.status !== cur.status) {
    emit('order_updated', { id, status: next.status });
    if (getSetting('notifications.notify_customer_on_status') && next.conversation_id) {
      enqueue({ kind: 'status_notify', payload: { order_id: id }, conversationId: next.conversation_id });
    }
  }
  return next;
}

export const orderLines = (o) => o.items.map((i) => `${i.qty}× ${i.name}${Object.keys(i.options || {}).length ? ` (${Object.entries(i.options).map(([k, v]) => `${k}: ${v}`).join('، ')})` : ''}`).join(' | ');

const COLUMNS = [
  ['رقم الأوردر', (o) => o.number], ['التاريخ', (o) => new Date(o.created_at).toLocaleString('en-GB', { timeZone: 'Africa/Cairo' })],
  ['القناة', (o) => o.channel], ['الاسم', (o) => o.customer_name], ['الموبايل', (o) => o.phone], ['المحافظة', (o) => o.governorate],
  ['العنوان', (o) => o.address], ['المنتجات', orderLines], ['المجموع', (o) => o.subtotal], ['الخصم', (o) => o.discount_total],
  ['الشحن', (o) => o.shipping], ['الإجمالي', (o) => o.total], ['الدفع', (o) => o.payment_method], ['الحالة', (o) => o.status], ['ملاحظات', (o) => o.notes],
];

export function ordersToCsv(orders) {
  const lines = [COLUMNS.map(([h]) => escapeCsv(h)).join(',')];
  for (const o of orders) lines.push(COLUMNS.map(([, f]) => escapeCsv(f(o))).join(','));
  return '﻿' + lines.join('\r\n');
}

export async function ordersToXlsx(orders) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('الأوردرات', { views: [{ rightToLeft: true }] });
  ws.addRow(COLUMNS.map(([h]) => h)).font = { bold: true };
  for (const o of orders) ws.addRow(COLUMNS.map(([, f]) => f(o)));
  ws.columns.forEach((c) => { c.width = 18; });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** الشكل اللي بيتبعت للـ webhook (Apps Script / Zapier / أي نظام) */
export function orderPayload(o) {
  return {
    event: 'order.created', number: o.number, created_at: new Date(o.created_at).toISOString(), channel: o.channel,
    customer: { name: o.customer_name, phone: o.phone, governorate: o.governorate, address: o.address, extra: o.extra },
    items: o.items, items_text: orderLines(o), subtotal: o.subtotal, discount: o.discount_total, shipping: o.shipping, total: o.total,
    payment_method: o.payment_method, status: o.status, notes: o.notes,
  };
}
