import { q, getSetting } from './db.js';

export const listRules = () => q.all('SELECT * FROM discount_rules ORDER BY id');

export function amountFor(rule, subtotal) {
  let amt = rule.type === 'fixed' ? Number(rule.value) : (subtotal * Number(rule.value)) / 100;
  if (rule.max_discount > 0) amt = Math.min(amt, rule.max_discount);
  const cap = Number(getSetting('discounts.max_percent_cap', 0));
  if (cap > 0) amt = Math.min(amt, (subtotal * cap) / 100);
  return Math.max(0, Math.min(amt, subtotal));
}

/** أفضل خصم تلقائي (min_order) ينطبق على المبلغ */
export function bestAutoRule(subtotal) {
  const rules = q.all(`SELECT * FROM discount_rules WHERE active=1 AND trigger='min_order' AND min_order<=?`, subtotal);
  let best = null; let bestAmt = 0;
  for (const r of rules) { const a = amountFor(r, subtotal); if (a > bestAmt) { best = r; bestAmt = a; } }
  return best;
}

export function findCoupon(code) {
  const c = String(code || '').trim().toLowerCase();
  if (!c) return null;
  return q.all(`SELECT * FROM discount_rules WHERE active=1 AND trigger='coupon'`).find((r) => String(r.coupon_code).trim().toLowerCase() === c) || null;
}
