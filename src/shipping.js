import { q, getSetting } from './db.js';
import { normalizeAr } from './util.js';

export function listRates() { return q.all('SELECT * FROM shipping_rates ORDER BY id'); }

/** يطابق اسم المحافظة (بأي كتابة) مع جدول الشحن */
export function matchGovernorate(input) {
  const n = normalizeAr(input);
  if (!n) return null;
  const rates = q.all('SELECT * FROM shipping_rates WHERE active=1');
  // مطابقة تامة بالاسم أو الأسماء البديلة
  for (const r of rates) {
    const names = [r.governorate, ...String(r.aliases || '').split(',')].map(normalizeAr).filter(Boolean);
    if (names.includes(n)) return r;
  }
  // احتواء (العميل كتب "القاهرة مدينة نصر")
  for (const r of rates) {
    const names = [r.governorate, ...String(r.aliases || '').split(',')].map(normalizeAr).filter(Boolean);
    if (names.some((x) => x.length >= 4 && (n.includes(x) || (n.length >= 4 && x.includes(n))))) return r;
  }
  return null;
}

/** نتيجة: {known, governorate, price, eta} أو null لو مفيش محافظة */
export function quote(governorate) {
  if (!governorate) return null;
  const r = matchGovernorate(governorate);
  if (r) return { known: true, governorate: r.governorate, price: r.price, eta: r.eta || '' };
  if (getSetting('shipping.unknown_governorate') === 'default_price') {
    return { known: true, governorate: String(governorate).trim(), price: getSetting('shipping.default_price', 0), eta: '' };
  }
  return { known: false, governorate: String(governorate).trim() };
}
