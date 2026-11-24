// الأسعار على صفحة الهبوط بتتقري من باقات المنصة الحقيقية (من لوحة الإدارة). لو فشل الطلب، الأسعار المكتوبة في الصفحة بتفضل.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n = (v) => Number(v).toLocaleString('en-US');
const lim = (v, unit) => (v < 0 ? `${unit} بلا حد` : `${n(v)} ${unit}`);
try {
  const plans = await (await fetch('/api/plans')).json();
  const list = document.querySelector('#plans');
  if (list && Array.isArray(plans) && plans.length) {
    list.innerHTML = plans.map((p) => `<li><span class="rows__name">${esc(p.name)}${p.trial_days ? `<small>${p.trial_days} يوم</small>` : ''}</span><p>${esc(lim(p.limits.ai_replies, 'رد ذكي في الشهر'))}، ${esc(lim(p.limits.products, 'منتج'))}، ${p.limits.channels} قنوات، ${p.limits.staff} موظف.</p><span class="rows__value">${p.price ? `${n(p.price)} جنيه` : 'مجانًا'}</span></li>`).join('');
  }
} catch { /* نسيب الأسعار المكتوبة */ }
