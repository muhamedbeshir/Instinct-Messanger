/* أدوات واجهة مشتركة بين لوحة العميل ولوحة الإدارة (بدون مكتبات خارجية) */
export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const fmt = (n) => (Math.round((Number(n) || 0) * 100) / 100).toLocaleString('en-US');
export const when = (t) => (t ? new Date(t).toLocaleString('ar-EG', { dateStyle: 'short', timeStyle: 'short' }) : '—');
export const day = (t) => (t ? new Date(t).toLocaleDateString('ar-EG', { dateStyle: 'medium' }) : '—');
export const CH = { messenger: 'ماسنجر', instagram: 'إنستجرام', whatsapp: 'واتساب', simulator: 'تجربة' };

export function toast(msg, bad = false) {
  let box = $('#toasts'); if (!box) { box = document.createElement('div'); box.id = 'toasts'; box.setAttribute('role', 'status'); document.body.append(box); }
  const t = document.createElement('div'); t.className = 'toast' + (bad ? ' bad' : ''); t.textContent = msg;
  box.append(t); setTimeout(() => t.remove(), bad ? 6000 : 3500);
}

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

export async function api(method, path, body, raw) {
  const opt = { method, headers: {}, credentials: 'same-origin' };
  if (raw) opt.body = raw; else if (body !== undefined) { opt.headers['content-type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const res = await fetch('/api' + path, opt);
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (res.status === 401 && !path.startsWith('/auth/')) { onUnauthorized(); throw new Error('سجّل الدخول'); }
  if (!res.ok) { const e = new Error(data?.error || `خطأ ${res.status}`); e.status = res.status; e.code = data?.code; if (!e.silent) toast(e.message, true); throw e; }
  return data;
}
export const get = (p) => api('GET', p);
export const post = (p, b) => api('POST', p, b ?? {});
export const put = (p, b) => api('PUT', p, b);
export const patch = (p, b) => api('PATCH', p, b);
export const del = (p, b) => api('DELETE', p, b ?? {});

export function modal(title, bodyHtml, { onSave, saveText = 'حفظ', wide } = {}) {
  const m = document.createElement('div'); m.className = 'modal'; m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true');
  m.innerHTML = `<div class="box" ${wide ? 'style="max-width:980px"' : ''}><div class="row sp" style="margin-bottom:16px"><h2>${esc(title)}</h2><button class="ghost small" data-close aria-label="إغلاق">✕</button></div><div class="mbody">${bodyHtml}</div>${onSave ? `<div class="row" style="margin-top:24px"><button data-save>${saveText}</button><button class="ghost" data-close>إلغاء</button></div>` : ''}</div>`;
  document.body.append(m);
  const close = () => m.remove();
  m.addEventListener('click', (e) => { if (e.target === m || e.target.closest('[data-close]')) close(); });
  m.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  $('[data-save]', m)?.addEventListener('click', async (e) => { e.target.disabled = true; try { if ((await onSave(m)) !== false) close(); } finally { e.target.disabled = false; } });
  $('input,textarea,select', m)?.focus();
  return { el: m, close };
}
export const confirmBox = (msg) => window.confirm(msg);

export function beep() { try { const c = new (window.AudioContext || window.webkitAudioContext)(); const o = c.createOscillator(); const g = c.createGain(); o.connect(g); g.connect(c.destination); o.frequency.value = 880; g.gain.value = 0.08; o.start(); o.stop(c.currentTime + 0.18); } catch { /* */ } }

/** شريط استهلاك: used من limit (-1 = بدون حد) */
export function meter(label, used, limit) {
  const unl = limit < 0; const pct = unl ? 0 : Math.min(100, Math.round((used / Math.max(limit, 1)) * 100));
  return `<div style="margin:12px 0"><div class="row sp"><span>${esc(label)}</span><span class="muted"><bdi dir="ltr">${fmt(used)} / ${unl ? "∞" : fmt(limit)}</bdi></span></div><div class="meter ${!unl && used >= limit ? 'over' : ''}"><i style="width:${unl ? 4 : pct}%"></i></div></div>`;
}
