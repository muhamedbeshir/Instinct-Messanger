import crypto from 'node:crypto';
import { q, getSetting, getSettings, updateSettings } from './db.js';
import { getConversation, saveConversation, withTransaction } from './conversations.js';
import { getProduct, getCategory, inStock, invalidateProducts } from './catalog.js';
import { quote } from './shipping.js';
import { amountFor, bestAutoRule } from './discounts.js';
import { normalizeAr, toLatinDigits, now, money } from './util.js';
import { emit } from './events.js';
import { enqueue } from './queue.js';

const SEP = /[,،/|؛;\n]+/;
const optionList = (v) => String(v ?? '').split(SEP).map((s) => s.trim()).filter(Boolean);
const round2 = (n) => Math.round(n * 100) / 100;

/* ---------- إضافة للسلة ---------- */
export function cartAdd(convId, { product_id, quantity = 1, options = {} }) {
  const conv = getConversation(convId);
  const p = getProduct(Number(product_id));
  if (!p || !p.active) return { error: 'المنتج مش موجود أو مش متاح حاليًا.' };
  const qty = Math.max(1, Math.floor(Number(quantity) || 1));
  const cat = p.category_id ? getCategory(p.category_id) : null;
  const opts = {};
  for (const [k, v] of Object.entries(options || {})) if (String(v ?? '').trim()) opts[String(k).trim()] = String(v).trim();

  // الحقول المطلوبة من القسم + أي خاصية في المنتج لها أكتر من اختيار لازم العميل يختار
  const wanted = new Set(cat?.required_fields || []);
  for (const [k, v] of Object.entries(p.attributes || {})) if (optionList(v).length > 1) wanted.add(k);
  const missing = []; const problems = [];
  for (const f of wanted) {
    const available = p.attributes && p.attributes[f] !== undefined ? optionList(p.attributes[f]) : null;
    const given = Object.entries(opts).find(([k]) => normalizeAr(k) === normalizeAr(f));
    if (available && available.length === 1 && !given) { opts[f] = available[0]; continue; }
    if (!given) { missing.push({ field: f, available_values: available || undefined }); continue; }
    if (available && available.length) {
      const hit = available.find((a) => normalizeAr(a) === normalizeAr(given[1]));
      if (!hit) problems.push({ field: f, given: given[1], available_values: available });
      else { delete opts[given[0]]; opts[f] = hit; }
    }
  }
  if (missing.length || problems.length) {
    return { error: 'لازم تسأل العميل عن الاختيارات دي قبل الإضافة للسلة.', missing_options: missing, invalid_options: problems };
  }

  const key = (o) => JSON.stringify(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
  const cart = [...conv.cart];
  const existing = cart.find((l) => l.product_id === p.id && key(l.options) === key(opts));
  const already = cart.filter((l) => l.product_id === p.id).reduce((s, l) => s + l.qty, 0);
  if (!inStock(p, already + qty)) {
    return { error: `الكمية المطلوبة مش متاحة. المتاح من "${p.name}": ${p.stock}.`, available_stock: p.stock };
  }
  if (existing) existing.qty += qty;
  else cart.push({ line_id: (cart.reduce((m, l) => Math.max(m, l.line_id), 0) || 0) + 1, product_id: p.id, name: p.name, unit_price: p.price, qty, options: opts });
  saveConversation(convId, { cart });
  return { ok: true, cart: viewCart(convId) };
}

export function cartUpdate(convId, { line_id, quantity }) {
  const conv = getConversation(convId);
  let cart = [...conv.cart];
  const line = cart.find((l) => l.line_id === Number(line_id));
  if (!line) return { error: 'البند ده مش موجود في السلة.' };
  const qty = Math.floor(Number(quantity));
  if (!(qty > 0)) cart = cart.filter((l) => l !== line);
  else {
    const p = getProduct(line.product_id);
    const others = cart.filter((l) => l.product_id === line.product_id && l !== line).reduce((s, l) => s + l.qty, 0);
    if (p && !inStock(p, others + qty)) return { error: `الكمية مش متاحة. المتاح: ${p.stock}.`, available_stock: p.stock };
    line.qty = qty;
  }
  saveConversation(convId, { cart });
  return { ok: true, cart: viewCart(convId) };
}

export function cartClear(convId) {
  saveConversation(convId, { cart: [], discount: null });
  return { ok: true };
}

/* ---------- الحسابات ---------- */
export function computeTotals(conv) {
  const subtotal = round2(conv.cart.reduce((s, l) => s + l.unit_price * l.qty, 0));
  let best = null; let bestAmt = 0;
  const manual = conv.discount;
  if (manual) { const a = amountFor(manual, subtotal); if (a > bestAmt) { best = { rule_id: manual.id, name: manual.name, source: manual.source || 'applied' }; bestAmt = a; } }
  const auto = bestAutoRule(subtotal);
  if (auto) { const a = amountFor(auto, subtotal); if (a > bestAmt) { best = { rule_id: auto.id, name: auto.name, source: 'auto' }; bestAmt = a; } }
  const discount_amount = round2(bestAmt);
  const afterDiscount = round2(subtotal - discount_amount);

  const gov = conv.customer?.governorate;
  const sq = gov ? quote(gov) : null;
  let shipping = null; let free = false;
  if (sq?.known) {
    shipping = sq.price;
    const freeOver = Number(getSetting('shipping.free_over', 0));
    if (freeOver > 0 && afterDiscount >= freeOver) { shipping = 0; free = true; }
  }
  return {
    subtotal, discount_amount, discount: best, shipping, shipping_known: sq?.known === true, shipping_eta: sq?.eta || '', free_shipping: free,
    total: round2(afterDiscount + (shipping || 0)),
    total_note: shipping === null ? 'الإجمالي بدون الشحن (المحافظة لسه ما اتحددتش)' : undefined,
  };
}

export function viewCart(convId) {
  const conv = getConversation(convId);
  return { items: conv.cart.map((l) => ({ line_id: l.line_id, product_id: l.product_id, name: l.name, options: l.options, qty: l.qty, unit_price: l.unit_price, line_total: round2(l.unit_price * l.qty) })), ...computeTotals(conv) };
}

/* ---------- بيانات العميل ---------- */
export function customerFieldsConfig() { return getSetting('orders.customer_fields', []); }

export function missingCustomerFields(conv) {
  return customerFieldsConfig().filter((f) => f.required && !String(conv.customer?.[f.key] ?? '').trim()).map((f) => ({ key: f.key, label: f.label, hint: f.hint }));
}

export function normalizePhone(raw) {
  let s = toLatinDigits(raw).replace(/[^\d+]/g, '');
  if (s.startsWith('+20')) s = '0' + s.slice(3);
  else if (s.startsWith('0020')) s = '0' + s.slice(4);
  else if (s.startsWith('20') && s.length === 12) s = '0' + s.slice(2);
  return s;
}

export function saveCustomerFields(convId, fields = {}) {
  const conv = getConversation(convId);
  const config = customerFieldsConfig();
  const customer = { ...conv.customer };
  const errors = []; const saved = [];
  for (const [key, valueRaw] of Object.entries(fields)) {
    const def = config.find((f) => f.key === key);
    if (!def) { errors.push({ field: key, error: 'حقل غير معروف' }); continue; }
    let value = String(valueRaw ?? '').trim();
    if (!value) continue;
    if (key === 'phone') {
      value = normalizePhone(value);
      const rx = getSetting('orders.phone_regex', '');
      if (rx && !new RegExp(rx).test(value)) { errors.push({ field: key, error: 'رقم الموبايل شكله مش صحيح، اطلب من العميل يكتبه تاني.' }); continue; }
    }
    if (key === 'governorate') {
      const sq = quote(value);
      if (!sq.known) {
        errors.push({ field: key, error: 'المحافظة دي مش موجودة في جدول الشحن. اسأل العميل يأكدها.', valid_values: q.all('SELECT governorate FROM shipping_rates WHERE active=1').map((r) => r.governorate) });
        continue;
      }
      value = sq.governorate;
    }
    customer[key] = value; saved.push(key);
  }
  saveConversation(convId, { customer });
  const updated = getConversation(convId);
  return { saved, errors, missing: missingCustomerFields(updated).map((m) => m.label) };
}

/* ---------- الملخص + حماية التأكيد ---------- */
export function orderSummary(convId) {
  const conv = getConversation(convId);
  const cart = viewCart(convId);
  const missing = missingCustomerFields(conv);
  const labels = {}; for (const f of customerFieldsConfig()) labels[f.label] = conv.customer?.[f.key] || null;
  const summary = {
    items: cart.items.map(({ name, options, qty, unit_price, line_total }) => ({ name, options, qty, unit_price, line_total })),
    subtotal: cart.subtotal, discount: cart.discount ? { name: cart.discount.name, amount: cart.discount_amount } : null,
    shipping: cart.shipping, shipping_eta: cart.shipping_eta || undefined, free_shipping: cart.free_shipping, total: cart.total,
    customer: labels, payment_methods: getSetting('orders.payment_methods', []).map((p) => p.name),
    missing_fields: missing.map((m) => m.label),
  };
  const hash = crypto.createHash('sha1').update(JSON.stringify([cart.items, cart.total, conv.customer])).digest('hex');
  saveConversation(convId, { state: { ...conv.state, summary_hash: missing.length || !cart.items.length ? null : hash } });
  summary.ready_to_confirm = !missing.length && cart.items.length > 0;
  return summary;
}

/* ---------- إنشاء الأوردر ---------- */
export function createOrder(convId, { notes = '', payment_method = '' } = {}) {
  const conv = getConversation(convId);
  if (!conv.cart.length) return { error: 'السلة فاضية.' };
  const missing = missingCustomerFields(conv);
  if (missing.length) return { error: 'لسه ناقص بيانات من العميل.', missing: missing.map((m) => m.label) };
  const cartView = viewCart(convId);
  const hash = crypto.createHash('sha1').update(JSON.stringify([cartView.items, cartView.total, conv.customer])).digest('hex');
  if (getSetting('orders.require_confirmation', true) && conv.state?.summary_hash !== hash) {
    return { error: 'الأوردر اتعدّل (أو الملخص ما اتعرضش). نادي order_summary، اعرض الملخص على العميل واستنى موافقته الصريحة، وبعدين confirm_order.' };
  }
  if (cartView.shipping === null) return { error: 'الشحن مش محسوب. حدد المحافظة الأول.' };

  let order;
  try {
    order = withTransaction(() => {
      for (const l of conv.cart) {
        const p = getProduct(l.product_id);
        const total = conv.cart.filter((x) => x.product_id === l.product_id).reduce((s, x) => s + x.qty, 0);
        if (!p || !p.active) throw new Error(`المنتج "${l.name}" مبقاش متاح.`);
        if (!inStock(p, total)) throw new Error(`المخزون مش كفاية لـ "${l.name}". المتاح: ${p.stock}.`);
      }
      const s = getSettings().orders;
      const number = `${s.number_prefix}${s.next_number}`;
      updateSettings({ orders: { next_number: s.next_number + 1 } });
      const c = conv.customer;
      const extra = { ...c }; for (const k of ['name', 'phone', 'governorate', 'address']) delete extra[k];
      const t = now();
      const r = q.run(`INSERT INTO orders(number,conversation_id,channel,customer_name,phone,governorate,address,extra,items,subtotal,discount_total,discount_info,shipping,total,payment_method,status,notes,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        number, convId, conv.channel, c.name || conv.display_name || '', c.phone || '', c.governorate || '', c.address || '', JSON.stringify(extra),
        JSON.stringify(cartView.items.map(({ product_id, name, options, qty, unit_price, line_total }) => ({ product_id, name, options, qty, unit_price, line_total }))),
        cartView.subtotal, cartView.discount_amount, JSON.stringify(cartView.discount), cartView.shipping, cartView.total,
        payment_method || getSetting('orders.payment_methods.0.name', ''), s.default_status, String(notes || ''), t, t);
      if (getSetting('orders.decrement_stock', true)) {
        for (const l of conv.cart) q.run('UPDATE products SET stock = stock - ? WHERE id=? AND stock IS NOT NULL', l.qty, l.product_id);
        invalidateProducts();
      }
      saveConversation(convId, { cart: [], discount: null, state: { ...conv.state, summary_hash: null, last_order: number } });
      return q.get('SELECT * FROM orders WHERE id=?', r.lastInsertRowid);
    });
  } catch (e) {
    return { error: e.message };
  }
  emit('order', { id: order.id, number: order.number });
  enqueue({ kind: 'order_notify', payload: { order_id: order.id } });
  enqueue({ kind: 'order_export', payload: { order_id: order.id } });
  return { ok: true, order_number: order.number, total: order.total };
}

export { money };
