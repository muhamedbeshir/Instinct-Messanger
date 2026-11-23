export const now = () => Date.now();
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function parseJSON(s, fallback = null) {
  if (s === null || s === undefined || s === '') return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}

export function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function deepMerge(base, patch) {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch === undefined ? base : patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isPlainObject(v) && isPlainObject(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

export const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
export function toLatinDigits(s) {
  return String(s ?? '').replace(/[٠-٩۰-۹]/g, (d) => {
    const i = ARABIC_DIGITS.indexOf(d);
    return String(i >= 0 ? i : PERSIAN_DIGITS.indexOf(d));
  });
}

/** توحيد النص العربي للبحث: بدون تشكيل، همزات، تاء مربوطة، إلخ */
export function normalizeAr(s) {
  return toLatinDigits(String(s ?? ''))
    .toLowerCase()
    .replace(/[ً-ْـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const STOP = new Set(['ال', 'في', 'من', 'عن', 'علي', 'الي', 'عايز', 'عاوز', 'عايزه', 'عاوزه', 'اريد', 'ابغي', 'عندكم', 'عندك',
  'فيه', 'في', 'هل', 'ممكن', 'لو', 'سمحت', 'يا', 'انا', 'ده', 'دي', 'دا', 'ايه', 'اي', 'ازاي', 'كام', 'بكام', 'سعر', 'السعر',
  'the', 'a', 'an', 'is', 'do', 'you', 'have', 'i', 'want', 'need', 'of', 'and', 'or', 'to', 'for', 'with', 'و', 'ب', 'ل']);

/** كلمات بحث بعد التوحيد وحذف "ال" التعريف وكلمات الحشو */
export function tokens(s) {
  return normalizeAr(s)
    .split(' ')
    .map((t) => (t.length > 3 && t.startsWith('ال') ? t.slice(2) : t))
    .filter((t) => t && !STOP.has(t) && t.length > 0);
}

export function escapeCsv(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function withTimeout(promise, ms, label = 'operation') {
  let timer;
  const t = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms); });
  return Promise.race([promise, t]).finally(() => clearTimeout(timer));
}

export function money(n) {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

export function randomToken(bytes = 24) {
  return globalThis.crypto.randomUUID().replace(/-/g, '') + Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(bytes))).toString('hex');
}
