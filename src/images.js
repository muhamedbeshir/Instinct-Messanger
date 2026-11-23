import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { uploadDir, inboundDir, currentTenantId } from './tenancy.js';
import { getSetting } from './db.js';
import { getPlatformSettings } from './platform.js';

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };
const MAX_BYTES = 4.5 * 1024 * 1024;
const cache = new Map();

export function mimeFromName(name) { return MIME[path.extname(name).slice(1).toLowerCase()] || 'image/jpeg'; }

export function saveInboundImage(buffer, contentType = 'image/jpeg') {
  const ext = EXT[contentType.split(';')[0]] || 'jpg';
  const name = `${crypto.randomUUID()}.${ext}`;
  fs.writeFileSync(path.join(inboundDir(), name), buffer);
  return name;
}

export async function downloadImage(url, headers = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(20000), redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { buffer: buf, contentType: res.headers.get('content-type') || 'image/jpeg' };
}

/** يحوّل رابط صورة Google Drive العادي لرابط مباشر */
export function normalizeImageUrl(u) {
  const s = String(u || '').trim();
  const m = s.match(/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:export=\w+&)?id=)([\w-]+)/);
  return m ? `https://drive.google.com/uc?export=view&id=${m[1]}` : s;
}

/** رابط عام مطلق لصورة (Meta بتحتاج رابط عام عشان تبعت الصورة) */
export function absoluteUrl(u) {
  if (/^https?:\/\//i.test(u)) return u;
  const base = String(getPlatformSettings().public_url || getSetting('channels.public_base_url', '')).replace(/\/$/, '');
  if (!base) throw new Error('الرابط العام للسيرفر مش مضبوط، فمقدرناش نبعت صور المنتجات.');
  return base + (u.startsWith('/') ? u : '/' + u);
}

/** يرجّع {media_type, data(base64)} لصورة محلية أو رابط. للـ vision. */
export async function loadImageBase64(ref) {
  const key = typeof ref === 'string' ? ref : JSON.stringify(ref);
  if (cache.has(key)) return cache.get(key);
  let buf; let type;
  try {
    if (typeof ref === 'object' && ref.local) {
      const f = path.join(inboundDir(), path.basename(ref.local));
      buf = fs.readFileSync(f); type = mimeFromName(f);
    } else if (typeof ref === 'string' && ref.startsWith('/media/')) {
      const [, , tid, file] = ref.split('/');
      if (Number(tid) !== currentTenantId()) return null; // صور عميل تاني ممنوعة
      const f = path.join(uploadDir(), path.basename(file));
      buf = fs.readFileSync(f); type = mimeFromName(f);
    } else {
      const d = await downloadImage(normalizeImageUrl(typeof ref === 'string' ? ref : ref.url));
      buf = d.buffer; type = d.contentType.split(';')[0];
    }
  } catch { return null; }
  if (buf.length > MAX_BYTES || !Object.keys(EXT).includes(type)) return null;
  const out = { media_type: type, data: buf.toString('base64') };
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  cache.set(key, out);
  return out;
}
