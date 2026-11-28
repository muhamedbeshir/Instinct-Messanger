/* لوحة إدارة المنصة (السوبر أدمن): العملاء، الباقات، الإيرادات، الإعدادات، السجلات */
import { $, $$, esc, fmt, when, day, toast, get, post, put, patch, del, modal, confirmBox, meter, setUnauthorizedHandler } from '/shared/ui.js';

const STATUS = { active: ['فعّال', 'ok'], expired: ['منتهي', 'bad'], suspended: ['موقوف', 'bad'] };
const tag = (st) => `<span class="tag ${STATUS[st]?.[1] || ''}">${STATUS[st]?.[0] || esc(st)}</span>`;
const pages = {}; let ME = null; let currentPage = '';

/* ---------- نظرة عامة ---------- */
pages.home = async (el) => {
  const [s, reqs] = await Promise.all([get('/admin/stats'), get('/admin/upgrade-requests')]);
  el.innerHTML = `<div class="pagehead"><h2>نظرة عامة على المنصة</h2></div>
  <div class="grid g4">
    <div class="card stat"><b>${s.tenants_total}</b><span>متجر</span></div>
    <div class="card stat"><b>${s.by_status.active || 0}</b><span>فعّال</span></div>
    <div class="card stat"><b>${s.by_status.expired || 0}</b><span>اشتراك منتهي</span></div>
    <div class="card stat"><b>${fmt(s.mrr)}</b><span>إيراد شهري متكرر (${s.currency})</span></div>
    <div class="card stat"><b>${s.signups_7d}</b><span>تسجيلات آخر 7 أيام</span></div>
    <div class="card stat"><b>${fmt(s.usage.ai)}</b><span>رد ذكي هذا الشهر</span></div>
    <div class="card stat"><b>${fmt(s.usage.orders)}</b><span>أوردر هذا الشهر</span></div>
    <div class="card stat"><b>${s.errors_24h}</b><span>أخطاء آخر 24 ساعة</span></div>
  </div>
  <div class="grid g2">
    <div class="card"><h3>طلبات الترقية (${reqs.length})</h3>${reqs.map((r) => `<div class="row sp" style="padding:6px 0"><a href="#/tenants/${r.tenant_id}">${esc(r.tenant_name)}</a><span class="tag">${esc(r.plan_name || '')}</span><span class="muted">${esc(r.note || '')}</span><button class="ghost small" data-dis="${r.id}">تجاهل</button></div>`).join('') || '<span class="muted">مفيش طلبات</span>'}</div>
    <div class="card"><h3>اشتراكات بتنتهي قريبًا</h3>${s.expiring_soon.map((t) => `<div class="row sp" style="padding:6px 0"><a href="#/tenants/${t.id}">${esc(t.name)}</a><span class="tag warn">${t.days_left} يوم</span><span class="muted">${esc(t.plan)}</span></div>`).join('') || '<span class="muted">مفيش</span>'}</div>
    <div class="card"><h3>الأكثر استهلاكًا هذا الشهر</h3>${s.top_tenants.map((t) => `<div class="row sp" style="padding:6px 0"><a href="#/tenants/${t.tenant_id}">${esc(t.name)}</a><span>${fmt(t.ai_replies)} رد</span><span class="muted">${fmt(t.orders)} أوردر</span></div>`).join('') || '<span class="muted">لسه</span>'}</div>
    <div class="card"><h3>توزيع الباقات</h3>${Object.entries(s.by_plan).map(([k, v]) => `<div class="row sp" style="padding:6px 0"><span>${esc(k)}</span><b>${v}</b></div>`).join('') || '<span class="muted">—</span>'}</div>
  </div>`;
  $$('[data-dis]', el).forEach((b) => { b.onclick = async () => { await post(`/admin/upgrade-requests/${b.dataset.dis}/dismiss`); pages.home(el); }; });
};

/* ---------- العملاء ---------- */
pages.tenants = async (el, id) => {
  if (id) return tenantPage(el, Number(id));
  let status = ''; let text = '';
  el.innerHTML = `<div class="pagehead"><h2>المتاجر</h2><button id="add">+ متجر جديد</button></div>
  <div class="row" style="margin-bottom:16px"><input id="q" placeholder="بحث بالاسم أو الإيميل" style="max-width:300px"><select id="st" style="max-width:180px"><option value="">كل الحالات</option><option value="active">فعّال</option><option value="expired">منتهي</option><option value="suspended">موقوف</option></select></div><div id="list"></div>`;
  const load = async () => {
    const rows = await get(`/admin/tenants?q=${encodeURIComponent(text)}&status=${status}`);
    $('#list', el).innerHTML = `<div class="card tablewrap"><table><thead><tr><th>المتجر</th><th>المالك</th><th>الباقة</th><th>الحالة</th><th>الاستهلاك (شهر)</th><th>آخر نشاط</th><th></th></tr></thead><tbody>${rows.map((t) => `<tr>
      <td><a href="#/tenants/${t.id}"><b>${esc(t.name)}</b></a><div class="muted mono" style="font-size:12px">${esc(t.slug)}</div></td>
      <td dir="ltr" style="text-align:start">${esc(t.owner?.email || '—')}</td><td>${esc(t.plan.name)}</td>
      <td>${tag(t.status)}${t.days_left !== null ? `<div class="muted">${t.days_left} يوم</div>` : ''}</td>
      <td>${fmt(t.usage.ai_replies)} / ${t.limits.ai_replies < 0 ? '∞' : fmt(t.limits.ai_replies)}<div class="muted">${fmt(t.usage.orders)} أوردر</div></td><td>${when(t.last_seen)}</td>
      <td><button class="ghost small" data-imp="${t.id}">دخول كعميل</button></td></tr>`).join('') || '<tr><td colspan="7" class="muted">مفيش</td></tr>'}</tbody></table></div>`;
    $$('[data-imp]', el).forEach((b) => { b.onclick = () => impersonate(b.dataset.imp); });
  };
  $('#q', el).oninput = (e) => { text = e.target.value; clearTimeout(pages.tenants.t); pages.tenants.t = setTimeout(load, 250); };
  $('#st', el).onchange = (e) => { status = e.target.value; load(); };
  $('#add', el).onclick = async () => {
    const plans = await get('/admin/plans');
    modal('متجر جديد', `<label>اسم المتجر</label><input id="n"><label>إيميل المالك</label><input id="e" type="email" dir="ltr"><label>كلمة سر المالك (8+)</label><input id="p" dir="ltr"><label>الباقة</label><select id="pl">${plans.map((p) => `<option value="${esc(p.slug)}">${esc(p.name)}</option>`).join('')}</select>`, {
      onSave: async (m) => { const t = await post('/admin/tenants', { name: $('#n', m.el).value, owner_email: $('#e', m.el).value, owner_password: $('#p', m.el).value, plan_slug: $('#pl', m.el).value }); location.hash = `#/tenants/${t.id}`; } });
  };
  await load();
};
async function impersonate(id) { const r = await post(`/admin/tenants/${id}/impersonate`); location.href = r.home; }

async function tenantPage(el, id) {
  const [t, plans] = await Promise.all([get(`/admin/tenants/${id}`), get('/admin/plans')]);
  const lim = t.limits; const u = t.usage;
  el.innerHTML = `<div class="pagehead"><div><a href="#/tenants">← المتاجر</a><h2 style="margin-top:4px">${esc(t.name)} ${tag(t.status)}</h2><div class="muted mono">${esc(t.slug)} · أُنشئ ${day(t.created_at)} · آخر نشاط ${when(t.last_seen)}</div></div>
    <div class="row"><button id="imp">دخول كعميل</button><button class="ghost" id="susp">${t.raw_status === 'suspended' ? 'إعادة تفعيل' : 'إيقاف الحساب'}</button><button class="danger" id="rm">حذف</button></div></div>
  <div class="grid g2">
    <div class="card"><h3>الاشتراك</h3><label>الباقة</label><select id="plan">${plans.map((p) => `<option value="${p.id}" ${p.id === t.plan.id ? 'selected' : ''}>${esc(p.name)} (${fmt(p.price)})</option>`).join('')}</select>
      <label>ينتهي الاشتراك المدفوع</label><input type="date" id="paid" value="${t.paid_until ? new Date(t.paid_until).toISOString().slice(0, 10) : ''}">
      <label>تنتهي التجربة</label><input type="date" id="trial" value="${t.trial_ends ? new Date(t.trial_ends).toISOString().slice(0, 10) : ''}">
      <label>ملاحظات داخلية</label><textarea id="notes" style="min-height:70px">${esc(t.notes)}</textarea><div class="row" style="margin-top:12px"><button id="save">حفظ</button></div></div>
    <div class="card"><h3>الاستهلاك والمحتوى</h3>${meter('ردود ذكية (الشهر)', u.ai_replies, lim.ai_replies ?? -1)}
      <div class="grid g3" style="margin-top:12px"><div class="stat"><b style="font-size:24px">${t.counts.products}</b><span>منتج</span></div><div class="stat"><b style="font-size:24px">${t.counts.orders}</b><span>أوردر</span></div><div class="stat"><b style="font-size:24px">${t.counts.conversations}</b><span>محادثة</span></div></div>
      ${t.counts.failed_jobs || t.counts.failed_messages ? `<div class="banner bad" style="border-radius:12px;margin-top:12px">${t.counts.failed_jobs} مهمة فاشلة · ${t.counts.failed_messages} رسالة ما اتبعتتش</div>` : ''}</div>
  </div>
  <div class="card"><div class="row sp"><h3 style="margin:0">تسجيل دفعة</h3></div><div class="row" style="margin-top:12px"><input id="pa" type="number" placeholder="المبلغ" style="max-width:130px"><input id="pm" placeholder="الوسيلة (InstaPay / فودافون كاش)" style="max-width:240px"><input id="pr" placeholder="مرجع" style="max-width:160px"><input id="pmo" type="number" value="1" min="1" style="max-width:90px" title="عدد الشهور"><button id="pay">سجّل ومدّد</button></div><div class="hint">بيمدّد الاشتراك بعدد الشهور، وبيفعّل الحساب، وبيضبط الباقة المختارة فوق.</div>
    ${t.payments.length ? `<div class="tablewrap" style="margin-top:12px"><table><tbody>${t.payments.map((p) => `<tr><td>${day(p.created_at)}</td><td>${fmt(p.amount)} ${esc(p.currency)}</td><td>${esc(p.method)}</td><td>${esc(p.reference)}</td><td>${p.months} شهر</td></tr>`).join('')}</tbody></table></div>` : ''}</div>
  <div class="card"><h3>المستخدمين</h3><div class="tablewrap"><table><tbody>${t.users.map((x) => `<tr><td dir="ltr" style="text-align:start">${esc(x.email)}</td><td>${x.role === 'owner' ? 'مالك' : 'موظف'}${x.active ? '' : ' <span class="tag bad">معطّل</span>'}</td><td>${when(x.last_login)}</td><td><button class="ghost small" data-pw="${x.id}">كلمة سر جديدة</button> <button class="ghost small" data-tg="${x.id}" data-a="${x.active ? 0 : 1}">${x.active ? 'تعطيل' : 'تفعيل'}</button></td></tr>`).join('')}</tbody></table></div></div>
  <div class="card tablewrap"><h3>سجل الإجراءات</h3><table><tbody>${t.audit.map((a) => `<tr><td>${when(a.at)}</td><td>${esc(a.actor)}</td><td>${esc(a.action)}</td><td class="muted">${esc(a.detail)}</td></tr>`).join('') || '<tr><td class="muted">—</td></tr>'}</tbody></table></div>`;
  const toMs = (v) => (v ? new Date(v + 'T23:59:59').getTime() : null);
  $('#imp', el).onclick = () => impersonate(id);
  $('#save', el).onclick = async () => { await patch(`/admin/tenants/${id}`, { plan_id: Number($('#plan', el).value), paid_until: toMs($('#paid', el).value), trial_ends: toMs($('#trial', el).value), notes: $('#notes', el).value }); toast('اتحفظ ✓'); tenantPage(el, id); };
  $('#susp', el).onclick = async () => { await patch(`/admin/tenants/${id}`, { status: t.raw_status === 'suspended' ? 'active' : 'suspended' }); tenantPage(el, id); };
  $('#rm', el).onclick = async () => { const c = prompt(`للحذف النهائي (كل بياناته هتتمسح) اكتب: ${t.slug}`); if (c) { await del(`/admin/tenants/${id}`, { confirm: c }); location.hash = '#/tenants'; } };
  $('#pay', el).onclick = async () => { await post(`/admin/tenants/${id}/payments`, { amount: Number($('#pa', el).value), method: $('#pm', el).value, reference: $('#pr', el).value, months: Number($('#pmo', el).value), plan_id: Number($('#plan', el).value) }); toast('اتسجّلت ✓'); tenantPage(el, id); };
  $$('[data-pw]', el).forEach((b) => { b.onclick = async () => { const p = prompt('كلمة السر الجديدة (8+ حروف):'); if (p) { await post(`/admin/users/${b.dataset.pw}/password`, { password: p }); toast('اتغيّرت ✓'); } }; });
  $$('[data-tg]', el).forEach((b) => { b.onclick = async () => { await patch(`/admin/users/${b.dataset.tg}`, { active: b.dataset.a === '1' }); tenantPage(el, id); }; });
}

/* ---------- الباقات ---------- */
pages.plans = async (el) => {
  const plans = await get('/admin/plans');
  el.innerHTML = `<div class="pagehead"><h2>الباقات</h2><button id="add">+ باقة</button></div><div class="hint" style="margin-bottom:12px">-1 = بدون حد. الأسعار الحالية أرقام مبدئية: عدّلها حسب تسعيرك.</div>
  <div class="card tablewrap"><table><thead><tr><th>الباقة</th><th>السعر / شهر</th><th>المنتجات</th><th>ردود ذكية</th><th>قنوات</th><th>موظفين</th><th>متاجر</th><th></th></tr></thead><tbody>${plans.map((p) => `<tr><td><b>${esc(p.name)}</b> <span class="muted mono">${esc(p.slug)}</span>${p.active ? '' : ' <span class="tag bad">متوقفة</span>'}${p.public ? '' : ' <span class="tag">مخفية</span>'}</td><td>${fmt(p.price)} ${esc(p.currency)}</td><td>${p.limits.products}</td><td>${fmt(p.limits.ai_replies)}</td><td>${p.limits.channels}</td><td>${p.limits.staff}</td><td>${p.tenants}</td><td><button class="ghost small" data-e="${p.id}">تعديل</button></td></tr>`).join('')}</tbody></table></div>`;
  const edit = (p = { limits: { products: 100, ai_replies: 1000, channels: 3, staff: 2 }, features: { auto_sync: true, byok: false, instagram: true, whatsapp: true }, price: 0 }) => modal(p.id ? `تعديل باقة ${p.name}` : 'باقة جديدة', `<div class="grid g2"><div><label>الاسم</label><input id="pn" value="${esc(p.name)}"></div><div><label>المعرّف (slug)</label><input id="ps" dir="ltr" value="${esc(p.slug)}" ${p.id ? 'readonly' : ''}></div>
    <div><label>السعر / شهر</label><input id="pp" type="number" value="${p.price}"></div><div><label>أيام التجربة (0 = مدفوعة)</label><input id="pt" type="number" value="${p.trial_days || 0}"></div>
    <div><label>حد المنتجات</label><input id="l1" type="number" value="${p.limits.products}"></div><div><label>حد الردود الذكية / شهر</label><input id="l2" type="number" value="${p.limits.ai_replies}"></div>
    <div><label>عدد القنوات</label><input id="l3" type="number" value="${p.limits.channels}"></div><div><label>عدد الموظفين</label><input id="l4" type="number" value="${p.limits.staff}"></div></div>
    <label>وصف قصير</label><input id="pd" value="${esc(p.description)}">
    <label class="chk"><input type="checkbox" id="f1" ${p.features.auto_sync ? 'checked' : ''}> مزامنة تلقائية للشيت</label><label class="chk"><input type="checkbox" id="f2" ${p.features.byok ? 'checked' : ''}> مفتاح Claude خاص بالعميل (BYOK)</label>
    <label class="chk"><input type="checkbox" id="f3" ${p.features.instagram !== false ? 'checked' : ''}> إنستجرام</label><label class="chk"><input type="checkbox" id="f4" ${p.features.whatsapp !== false ? 'checked' : ''}> واتساب</label>
    <label class="chk"><input type="checkbox" id="pub" ${p.public === 0 ? '' : 'checked'}> ظاهرة للعملاء</label><label class="chk"><input type="checkbox" id="act" ${p.active === 0 ? '' : 'checked'}> متاحة</label>`, {
    onSave: async (m) => { const v = (i) => $(i, m.el); const body = { name: v('#pn').value, slug: v('#ps').value, price: Number(v('#pp').value), trial_days: Number(v('#pt').value), description: v('#pd').value, sort: p.sort || plans.length + 1, limits: { products: Number(v('#l1').value), ai_replies: Number(v('#l2').value), channels: Number(v('#l3').value), staff: Number(v('#l4').value) }, features: { auto_sync: v('#f1').checked, byok: v('#f2').checked, instagram: v('#f3').checked, whatsapp: v('#f4').checked }, public: v('#pub').checked, active: v('#act').checked }; p.id ? await put(`/admin/plans/${p.id}`, body) : await post('/admin/plans', body); pages.plans(el); } });
  $('#add', el).onclick = () => edit(); $$('[data-e]', el).forEach((b) => { b.onclick = () => edit(plans.find((p) => p.id == b.dataset.e)); });
};

/* ---------- إعدادات المنصة ---------- */
pages.settings = async (el) => {
  const s = await get('/admin/settings'); const plans = await get('/admin/plans'); const ai = s.ai; const st = s.ai_status;
  el.innerHTML = `<div class="pagehead"><h2>إعدادات المنصة</h2></div>
  <div class="card"><h3>الذكاء الاصطناعي (مشترك لكل المتاجر)</h3><div class="hint" style="margin:0 0 8px">الحالة الحالية: <b>${st.provider === 'anthropic' ? 'Claude متوصل' : 'تجريبي (مفيش مفتاح)'}</b>. العملاء ما بيشوفوش المفتاح ولا الموديل.</div>
    <div class="grid g2"><div><label>المشغّل</label><select id="a_p"><option value="auto" ${ai.provider === 'auto' ? 'selected' : ''}>تلقائي</option><option value="anthropic" ${ai.provider === 'anthropic' ? 'selected' : ''}>Claude</option><option value="mock" ${ai.provider === 'mock' ? 'selected' : ''}>تجريبي</option></select></div>
    <div><label>الموديل</label><input id="a_m" dir="ltr" value="${esc(ai.model)}"></div><div><label>مفتاح Claude (Anthropic API Key)</label><input id="a_k" type="password" autocomplete="new-password" value="${ai.api_key === '__set__' ? '__set__' : ''}" placeholder="${ai.api_key === '__set__' ? 'محفوظ' : 'sk-ant-...'}"></div>
    <div><label>أقصى طول رد (tokens)</label><input id="a_t" type="number" value="${ai.max_tokens}"></div><div><label>مهلة الرد (ms)</label><input id="a_o" type="number" value="${ai.timeout_ms}"></div></div>
    <label class="chk"><input type="checkbox" id="a_mock" ${ai.allow_mock ? 'checked' : ''}> اسمح بالوضع التجريبي في الإنتاج (مش مفضّل: بيرد برد مبسّط على عملاء حقيقيين)</label></div>
  <div class="card"><h3>الربط المركزي مع ميتا (Embedded Signup)</h3><div class="hint" style="margin:0 0 8px">تطبيق ميتا واحد للمنصة كلها. العميل بيربط بزرار واحد من غير ما يعمل تطبيق. لازم تطبيقك يكون معتمد (Tech Provider + App Review). من غير القيم دي، العملاء بيستخدموا الربط اليدوي.</div>
    <div class="grid g2"><div><label>App ID</label><input id="m_i" dir="ltr" value="${esc(s.meta.app_id)}"></div><div><label>App Secret</label><input id="m_s" type="password" autocomplete="new-password" value="${s.meta.app_secret === '__set__' ? '__set__' : ''}" placeholder="${s.meta.app_secret === '__set__' ? 'محفوظ' : ''}"></div>
    <div><label>Config ID لواتساب (Embedded Signup)</label><input id="m_w" dir="ltr" value="${esc(s.meta.config_id_whatsapp)}"></div><div><label>Config ID لماسنجر/إنستجرام (Facebook Login for Business)</label><input id="m_m" dir="ltr" value="${esc(s.meta.config_id_messenger)}"></div></div>
    <label>Callback URL للـ Webhook (حطه مرة واحدة في تطبيق ميتا)</label><input readonly dir="ltr" value="${esc((s.public_url || location.origin).replace(/\/$/, ''))}/webhooks/meta" onclick="this.select()"><label>Verify Token</label><input readonly dir="ltr" value="${esc(s.meta.verify_code)}" onclick="this.select()"></div>
  <div class="card"><h3>التسجيل والعلامة</h3><div class="grid g2"><div><label>اسم المنصة</label><input id="b_n" value="${esc(s.brand.name)}"></div><div><label>الباقة الافتراضية للتسجيل</label><select id="s_p">${plans.map((p) => `<option value="${esc(p.slug)}" ${p.slug === s.signup.default_plan ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div></div>
    <label class="chk"><input type="checkbox" id="s_o" ${s.signup.open ? 'checked' : ''}> التسجيل الذاتي مفتوح</label>
    <label>الرابط العام للمنصة (https) — بيستخدم في صور المنتجات وروابط الـ webhook</label><input id="pu" dir="ltr" value="${esc(s.public_url)}" placeholder="https://app.example.com"></div>
  <div class="card"><h3>الدعم والدفع</h3><div class="grid g2"><div><label>إيميل الدعم</label><input id="su_e" dir="ltr" value="${esc(s.support.email)}"></div><div><label>واتساب الدعم</label><input id="su_w" dir="ltr" value="${esc(s.support.whatsapp)}"></div></div>
    <label>تعليمات الدفع (بتظهر للعميل في صفحة الاشتراك)</label><textarea id="pi" placeholder="تحويل InstaPay على ... أو فودافون كاش ...">${esc(s.payment_instructions)}</textarea></div>
  <div class="card"><h3>إعلان لكل العملاء</h3><label>النص (فاضي = بدون إعلان)</label><input id="an_t" value="${esc(s.announcement.text)}"><label>النوع</label><select id="an_l"><option value="info" ${s.announcement.level === 'info' ? 'selected' : ''}>معلومة</option><option value="warn" ${s.announcement.level === 'warn' ? 'selected' : ''}>تحذير</option></select></div>
  <button id="save">حفظ الإعدادات</button>`;
  $('#save', el).onclick = async () => {
    const v = (i) => $(i, el);
    const key = v('#a_k').value;
    await put('/admin/settings', { ai: { provider: v('#a_p').value, model: v('#a_m').value, ...(key && key !== '__set__' ? { api_key: key } : {}), max_tokens: Number(v('#a_t').value), timeout_ms: Number(v('#a_o').value), allow_mock: v('#a_mock').checked },
      meta: { app_id: v('#m_i').value.trim(), ...(v('#m_s').value && v('#m_s').value !== '__set__' ? { app_secret: v('#m_s').value.trim() } : {}), config_id_whatsapp: v('#m_w').value.trim(), config_id_messenger: v('#m_m').value.trim() },
      brand: { name: v('#b_n').value }, signup: { open: v('#s_o').checked, default_plan: v('#s_p').value }, public_url: v('#pu').value.trim(), support: { email: v('#su_e').value, whatsapp: v('#su_w').value }, payment_instructions: v('#pi').value, announcement: { text: v('#an_t').value, level: v('#an_l').value } });
    toast('اتحفظ ✓'); pages.settings(el);
  };
};

/* ---------- سجلات وتدقيق وصحة وأدمنز ---------- */
pages.logs = async (el) => {
  let level = '';
  const load = async () => {
    const [logs, audit] = await Promise.all([get(`/admin/logs${level ? `?level=${level}` : ''}`), get('/admin/audit')]);
    el.innerHTML = `<div class="pagehead"><h2>السجلات والتدقيق</h2><select id="lv" style="max-width:160px"><option value="">كل المستويات</option><option value="error" ${level === 'error' ? 'selected' : ''}>أخطاء فقط</option><option value="warn" ${level === 'warn' ? 'selected' : ''}>تحذيرات</option></select></div>
    <div class="card tablewrap"><h3>أخطاء النظام</h3><table><tbody>${logs.map((l) => `<tr><td>${when(l.created_at)}</td><td>${esc(l.tenant_name || '—')}</td><td><span class="tag ${l.level === 'error' ? 'bad' : 'warn'}">${l.level}</span></td><td>${esc(l.scope)}</td><td dir="auto">${esc(l.message)}</td></tr>`).join('') || '<tr><td class="muted">مفيش 👌</td></tr>'}</tbody></table></div>
    <div class="card tablewrap"><h3>سجل إجراءات الإدارة</h3><table><tbody>${audit.map((a) => `<tr><td>${when(a.at)}</td><td>${esc(a.actor)}</td><td>${esc(a.tenant_name || '')}</td><td>${esc(a.action)}</td><td class="muted">${esc(a.detail)}</td></tr>`).join('')}</tbody></table></div>`;
    $('#lv', el).onchange = (e) => { level = e.target.value; load(); };
  };
  await load();
};
pages.health = async (el) => {
  const h = await get('/admin/health');
  el.innerHTML = `<div class="pagehead"><h2>صحة النظام</h2></div><div class="grid g4">
    <div class="card stat"><b>${h.ai.provider === 'anthropic' ? 'Claude' : 'تجريبي ⚠️'}</b><span>${esc(h.ai.model)}</span></div>
    <div class="card stat"><b>${h.queue_pending}</b><span>رسائل في الطابور</span></div>
    <div class="card stat"><b>${h.failed_jobs}</b><span>مهام فاشلة</span></div>
    <div class="card stat"><b>${h.failed_messages}</b><span>رسائل ما اتبعتتش</span></div>
    <div class="card stat"><b>${h.memory_mb} MB</b><span>ذاكرة السيرفر</span></div>
    <div class="card stat"><b>${h.tenants_db_mb} MB</b><span>حجم قواعد المتاجر</span></div>
    <div class="card stat"><b>${Math.round(h.uptime_s / 60)}</b><span>دقيقة تشغيل</span></div></div>
  ${h.ai.provider !== 'anthropic' ? '<div class="banner bad" style="border-radius:12px;margin-bottom:16px">مفيش مفتاح Claude: ضيفه من إعدادات المنصة، وإلا البوت مش هيرد على العملاء في الإنتاج.</div>' : ''}
  ${h.public_url ? '' : '<div class="banner warn" style="border-radius:12px">الرابط العام للمنصة مش مضبوط (إعدادات المنصة): صور المنتجات وروابط الـ webhook محتاجينه.</div>'}`;
};
pages.admins = async (el) => {
  const a = await get('/admin/admins');
  el.innerHTML = `<div class="pagehead"><h2>مديرو المنصة</h2><button id="add">+ مدير</button></div><div class="card tablewrap"><table><tbody>${a.map((u) => `<tr><td dir="ltr" style="text-align:start">${esc(u.email)}</td><td>${esc(u.name)}</td><td>${when(u.last_login)}</td></tr>`).join('')}</tbody></table></div>
  <div class="card"><h3>كلمة سري</h3><div class="row"><input type="password" id="pw0" placeholder="الحالية" autocomplete="current-password" style="max-width:220px"><input type="password" id="pw1" placeholder="الجديدة (8+)" autocomplete="new-password" style="max-width:220px"><button id="chpw">تغيير</button></div></div>`;
  $('#add', el).onclick = () => modal('مدير جديد', `<label>الإيميل</label><input id="e" dir="ltr"><label>الاسم</label><input id="n"><label>كلمة السر (8+)</label><input id="p" dir="ltr">`, { onSave: async (m) => { await post('/admin/admins', { email: $('#e', m.el).value, name: $('#n', m.el).value, password: $('#p', m.el).value }); pages.admins(el); } });
  $('#chpw', el).onclick = async () => { await post('/auth/change-password', { current: $('#pw0', el).value, password: $('#pw1', el).value }); toast('اتغيّرت ✓'); };
};

/* ---------- الإطار ---------- */
const NAV = [['home', 'نظرة عامة'], ['tenants', 'المتاجر'], ['plans', 'الباقات'], ['settings', 'إعدادات المنصة'], ['logs', 'السجلات'], ['health', 'صحة النظام'], ['admins', 'المديرون']];
function drawNav() {
  $('#nav').innerHTML = `<div class="brand"><span class="mark" aria-hidden="true">A</span><span>إدارة المنصة</span></div>${NAV.map(([k, l]) => `<a href="#/${k}" ${currentPage === k ? 'aria-current="page"' : ''}>${l}</a>`).join('')}<div class="foot"><div class="muted" style="padding:0 12px 8px;font-size:13px;direction:ltr;text-align:start">${esc(ME.user.email)}</div><a href="#" id="logout">تسجيل خروج</a></div>`;
  $('#logout').onclick = async (e) => { e.preventDefault(); await post('/auth/logout'); location.hash = '#/'; auth(); };
}
async function route() {
  const [, page = 'home', arg] = location.hash.split('/');
  if (!pages[page]) return (location.hash = '#/home');
  currentPage = page; drawNav();
  const el = $('#main'); el.innerHTML = '<div class="muted">جاري التحميل...</div>';
  try { await pages[page](el, arg); } catch (e) { el.innerHTML = `<div class="card">حصل خطأ: ${esc(e.message)}</div>`; }
}
async function shell() {
  const st = await fetch('/api/auth/status').then((r) => r.json());
  ME = { user: { email: st.email || 'admin' } };
  $('#app').innerHTML = `<a class="skip-link" href="#main">تخطي للمحتوى</a><div class="layout"><nav class="side" id="nav" aria-label="القائمة"></nav><main id="main" tabindex="-1"></main></div>`;
  route();
}
async function auth() {
  const st = await fetch('/api/auth/status').then((r) => r.json());
  if (st.authed && st.role === 'superadmin') return shell();
  if (st.authed) { location.href = '/app/'; return; }
  const setup = st.setup_needed;
  $('#app').innerHTML = `<div class="auth"><div class="side-art"><div class="row"><span class="mark" style="background:var(--p-inv-ink);color:var(--p-inv-bg)">A</span><b>إدارة المنصة</b></div><div><h1>${setup ? 'إعداد أول مدير' : 'لوحة إدارة المنصة'}</h1><p style="margin-top:16px">المتاجر، الباقات، الاشتراكات، والإعدادات المشتركة.</p></div><div></div></div>
    <div class="form"><form id="f" novalidate><h2>${setup ? 'إنشاء حساب المدير' : 'دخول المدير'}</h2>
    ${setup ? '<label for="cd">كود الإعداد (ظاهر في سجل السيرفر)</label><input id="cd" dir="ltr" autocomplete="off">' : ''}
    <label for="em">الإيميل</label><input id="em" type="email" dir="ltr" autocomplete="email"><label for="pw">كلمة السر</label><input id="pw" type="password" autocomplete="${setup ? 'new-password' : 'current-password'}">
    <p id="err" role="alert" style="color:var(--bad);min-height:22px;margin:8px 0 0;font-size:14px"></p><button class="primary" id="go" type="submit">${setup ? 'إنشاء ودخول' : 'دخول'}</button></form></div></div>`;
  $('#f').onsubmit = async (e) => {
    e.preventDefault(); $('#err').textContent = '';
    try {
      const r = await post(setup ? '/auth/setup-admin' : '/auth/login', { email: $('#em').value, password: $('#pw').value, code: $('#cd')?.value });
      if (r.home && !r.home.startsWith('/admin')) { location.href = r.home; return; }
      shell();
    } catch (err) { $('#err').textContent = err.message; }
  };
}
window.addEventListener('hashchange', () => { if ($('#main')) route(); });
setUnauthorizedHandler(() => auth());
auth();
