/* لوحة تحكم المتجر (العميل): عربي RTL، بدون مكتبات. التصميم من shared/base.css */
import { $, $$, esc, fmt, when, day, CH, toast, api, get, post, put, patch, del, modal, confirmBox, beep, meter, setUnauthorizedHandler } from '/shared/ui.js';

/* ---------------- مولّد حقول الإعدادات ---------------- */
function getPath(o, p) { return p.split('.').reduce((a, k) => (a == null ? a : a[k]), o); }
function setPath(o, p, v) { const ks = p.split('.'); let c = o; ks.slice(0, -1).forEach((k) => { c = c[k] ??= {}; }); c[ks.at(-1)] = v; }

function fieldHtml(f, values) {
  const v = getPath(values, f.path);
  const id = `f_${f.path.replace(/\W/g, '_')}`;
  const hint = f.hint ? `<div class="hint">${esc(f.hint)}</div>` : '';
  const attr = `data-path="${esc(f.path)}" data-type="${f.type}" id="${id}"`;
  switch (f.type) {
    case 'bool': return `<label class="chk"><input type="checkbox" ${attr} ${v ? 'checked' : ''}> ${esc(f.label)}</label>${hint}`;
    case 'textarea': return `<label for="${id}">${esc(f.label)}</label><textarea ${attr} ${f.rows ? `style="min-height:${f.rows * 24}px"` : ''}>${esc(v)}</textarea>${hint}`;
    case 'select': return `<label for="${id}">${esc(f.label)}</label><select ${attr}>${f.options.map(([val, lab]) => `<option value="${esc(val)}" ${String(v) === String(val) ? 'selected' : ''}>${esc(lab)}</option>`).join('')}</select>${hint}`;
    case 'list': return `<label for="${id}">${esc(f.label)}</label><input ${attr} value="${esc((v || []).join('، '))}">${hint || '<div class="hint">افصل بين العناصر بفاصلة</div>'}`;
    case 'number': return `<label for="${id}">${esc(f.label)}</label><input type="number" step="any" ${attr} value="${esc(v)}">${hint}`;
    case 'secret': return `<label for="${id}">${esc(f.label)}</label><input type="password" autocomplete="new-password" ${attr} value="${v === '__set__' ? '__set__' : esc(v)}" placeholder="${v === '__set__' ? 'محفوظ (اكتب قيمة جديدة لتغييره)' : ''}">${hint}`;
    case 'rows': {
      const rows = f.asMap ? Object.entries(v || {}).map(([k, val]) => ({ [f.cols[0].k]: k, [f.cols[1].k]: val })) : (v || []);
      const head = f.cols.map((c) => `<th>${esc(c.label)}</th>`).join('');
      const body = rows.map((r) => rowHtml(f, r)).join('');
      return `<label>${esc(f.label)}</label><div class="tablewrap"><table data-rows="${esc(f.path)}" ${attr} data-asmap="${f.asMap ? 1 : 0}"><thead><tr>${head}<th></th></tr></thead><tbody>${body}</tbody></table></div><button type="button" class="ghost small" data-addrow="${esc(f.path)}">+ إضافة</button>${hint}`;
    }
    default: return `<label for="${id}">${esc(f.label)}</label><input ${attr} value="${esc(v)}" ${f.dir ? `dir="${f.dir}"` : ''}>${hint}`;
  }
}
function rowHtml(f, r) {
  return `<tr>${f.cols.map((c) => c.type === 'bool'
    ? `<td><input type="checkbox" data-k="${c.k}" ${r[c.k] ? 'checked' : ''}></td>`
    : `<td><input data-k="${c.k}" value="${esc(r[c.k] ?? '')}" ${c.dir ? `dir="${c.dir}"` : ''}></td>`).join('')}<td><button type="button" class="ghost small" data-delrow>✕</button></td></tr>`;
}
function bindRows(root, fieldsByPath) {
  root.addEventListener('click', (e) => {
    const add = e.target.closest('[data-addrow]'); const delb = e.target.closest('[data-delrow]');
    if (add) { const f = fieldsByPath[add.dataset.addrow]; $(`[data-rows="${add.dataset.addrow}"] tbody`, root).insertAdjacentHTML('beforeend', rowHtml(f, f.defaults || {})); }
    if (delb) delb.closest('tr').remove();
  });
}
function readFields(root, fields) {
  const out = {};
  for (const f of fields) {
    const el = $(`[data-path="${f.path}"]`, root); if (!el) continue;
    let v;
    if (f.type === 'bool') v = el.checked;
    else if (f.type === 'number') v = el.value === '' ? 0 : Number(el.value);
    else if (f.type === 'list') v = el.value.split(/[,،\n]/).map((s) => s.trim()).filter(Boolean);
    else if (f.type === 'rows') {
      const rows = $$('tbody tr', el).map((tr) => Object.fromEntries($$('[data-k]', tr).map((i) => [i.dataset.k, i.type === 'checkbox' ? i.checked : i.value.trim()])));
      v = f.asMap ? Object.fromEntries(rows.filter((r) => r[f.cols[0].k]).map((r) => [r[f.cols[0].k], r[f.cols[1].k]])) : rows.filter((r) => Object.values(r).some((x) => x !== '' && x !== false));
    } else v = el.value;
    setPath(out, f.path, v);
  }
  return out;
}

/* ---------------- تعريف إعدادات النظام (كلها قابلة للتعديل) ---------------- */
const T = (path, label, type = 'text', extra = {}) => ({ path, label, type, ...extra });
const GROUPS = {
  business: { title: 'بيانات المتجر والسياسات', hint: 'البوت بيستخدم المعلومات دي في الرد. اكتب اللي تحب العميل يعرفه.', fields: [
    T('business.name', 'اسم المتجر'), T('business.description', 'نبذة عن المتجر', 'textarea'), T('business.phone', 'تليفون المتجر'), T('business.address', 'العنوان'),
    T('business.working_hours_text', 'مواعيد العمل (نص يظهر للبوت)'),
    T('business.policies.return', 'سياسة الإرجاع', 'textarea'), T('business.policies.exchange', 'سياسة الاستبدال', 'textarea'), T('business.policies.warranty', 'الضمان', 'textarea'),
    T('business.policies.delivery', 'معلومات التوصيل', 'textarea'), T('business.policies.other', 'سياسات أخرى', 'textarea')] },
  persona: { title: 'شخصية البوت وتعليماته', hint: 'ده البرومبت اللي بتتحكم فيه. القواعد الأمنية الأساسية (عدم اختراع أسعار، تأكيد الأوردر قبل التسجيل...) مقفولة ومضافة تلقائيًا فوق كلامك.', fields: [
    T('persona.instructions', 'التعليمات الأساسية (شخصية البوت وهدفه)', 'textarea', { rows: 6 }),
    T('persona.style', 'الأسلوب واللهجة', 'textarea', { rows: 4 }), T('persona.greeting', 'رسالة الترحيب', 'text', { hint: 'ممكن تستخدم {business_name}' }),
    T('persona.extra_instructions', 'تعليمات إضافية (عروض، حاجات تركز عليها...)', 'textarea', { rows: 6, hint: 'أي حاجة جديدة عايز البوت يعرفها تحطها هنا وتتطبق فورًا' }),
    T('persona.forbidden_topics', 'مواضيع ممنوع البوت يتكلم فيها')] },
  ai: { title: 'الذكاء الاصطناعي', fields: [
    T('ai.provider', 'المشغّل', 'select', { options: [['auto', 'تلقائي (Claude لو فيه مفتاح، وإلا تجريبي)'], ['anthropic', 'Claude فقط'], ['mock', 'تجريبي (قواعد بسيطة، للاختبار فقط)']] }),
    T('ai.api_key', 'مفتاح Claude (Anthropic API Key)', 'secret', { hint: 'من console.anthropic.com' }), T('ai.model', 'اسم الموديل', 'text', { dir: 'ltr' }),
    T('ai.max_tokens', 'أقصى طول للرد (tokens)', 'number'), T('ai.timeout_ms', 'مهلة الرد (ميلي ثانية)', 'number'), T('ai.understand_images', 'يفهم الصور اللي العميل يبعتها', 'bool')] },
  bot: { title: 'سلوك البوت', fields: [
    T('bot.enabled', 'البوت شغال (إيقاف كامل لو ألغيته)', 'bool'),
    T('bot.debounce_ms', 'استنى قبل الرد (ميلي ثانية) لتجميع رسائل العميل', 'number'), T('bot.history_limit', 'عدد الرسائل اللي يفتكرها', 'number'),
    T('bot.max_tool_rounds', 'أقصى خطوات تفكير للرد الواحد', 'number'),
    T('bot.human_takeover_minutes', 'لو رديت أنت بنفسك، البوت يسكت كام دقيقة؟', 'number', { hint: '0 = ما يسكتش' }), T('bot.typing_indicator', 'إظهار "بيكتب..." للعميل', 'bool'),
    T('bot.max_attempts', 'عدد محاولات إعادة الرد عند الفشل', 'number'), T('bot.fallback_message', 'رسالة الاعتذار لو البوت فشل', 'textarea'),
    T('handoff.keywords', 'كلمات تحوّل العميل لموظف فورًا', 'list'), T('handoff.message', 'رسالة التحويل لموظف', 'textarea'), T('handoff.pause_bot', 'يوقف البوت بعد التحويل', 'bool'),
    T('learning.mode', 'التعلم من ردودك', 'select', { options: [['review', 'يحفظ الردود ويستنى موافقتك'], ['auto', 'يحفظ الردود تلقائيًا'], ['off', 'بدون تعلم']], hint: 'لما ترد على سؤال البوت ما عرفوش، الإجابة بتتحفظ في قاعدة المعرفة ويستخدمها بعد كده' })] },
  hours: { title: 'مواعيد العمل', fields: [
    T('working_hours.enabled', 'فعّل مواعيد العمل', 'bool'), T('working_hours.start', 'من (HH:MM)', 'text', { dir: 'ltr' }), T('working_hours.end', 'إلى (HH:MM)', 'text', { dir: 'ltr' }),
    T('working_hours.timezone', 'المنطقة الزمنية', 'text', { dir: 'ltr' }), T('working_hours.off_hours_message', 'رسالة خارج المواعيد', 'textarea'), T('working_hours.bot_replies_off_hours', 'البوت يكمل رد برضو خارج المواعيد', 'bool')] },
  orders: { title: 'الأوردرات', fields: [
    T('orders.customer_fields', 'البيانات المطلوبة من العميل', 'rows', { cols: [{ k: 'key', label: 'المفتاح (name/phone/governorate/address أو جديد)', dir: 'ltr' }, { k: 'label', label: 'الاسم الظاهر' }, { k: 'hint', label: 'سؤال/توضيح' }, { k: 'required', label: 'إجباري', type: 'bool' }], defaults: { required: true }, hint: 'تقدر تضيف أي حقل (مثلًا: ملاحظات، موعد التسليم). name و phone و governorate و address ليهم معاملة خاصة.' }),
    T('orders.phone_regex', 'شكل رقم الموبايل المقبول (Regex، فاضي = أي رقم)', 'text', { dir: 'ltr' }),
    T('orders.require_confirmation', 'لازم تأكيد صريح من العميل قبل تسجيل الأوردر', 'bool'), T('orders.decrement_stock', 'ينقّص المخزون عند تسجيل الأوردر', 'bool'),
    T('orders.statuses', 'حالات الأوردر', 'list'), T('orders.default_status', 'الحالة الأولى للأوردر'), T('orders.number_prefix', 'بداية رقم الأوردر', 'text', { dir: 'ltr' }), T('orders.next_number', 'رقم الأوردر الجاي', 'number'),
    T('orders.payment_methods', 'طرق الدفع', 'rows', { cols: [{ k: 'name', label: 'الاسم' }, { k: 'instructions', label: 'تعليمات (رقم المحفظة مثلًا)' }] })] },
  shipping: { title: 'الشحن والخصومات (إعدادات عامة)', hint: 'أسعار كل محافظة من صفحة "الشحن". الخصومات والأوضاع من صفحة "الخصومات والأوضاع".', fields: [
    T('shipping.default_price', 'سعر الشحن الافتراضي', 'number'), T('shipping.free_over', 'شحن مجاني لو المبلغ فوق (0 = معطل)', 'number'),
    T('shipping.unknown_governorate', 'لو المحافظة مش في الجدول', 'select', { options: [['ask', 'يرجع يسأل العميل'], ['default_price', 'يطبق السعر الافتراضي']] }),
    T('discounts.max_percent_cap', 'أقصى خصم مسموح (% من المجموع) مهما كانت القواعد', 'number')] },
  notifications: { title: 'الإشعارات والربط بالشيت', fields: [
    T('notifications.order_webhook_url', 'رابط Webhook للأوردرات (Google Apps Script)', 'text', { dir: 'ltr', hint: 'كل أوردر جديد بيتبعت هنا ويتضاف لشيتك. اقرأ docs/SETUP.md' }), T('notifications.order_webhook_secret', 'كلمة سر الـ Webhook (اختياري)', 'secret'),
    T('notifications.telegram_bot_token', 'Telegram Bot Token (للتنبيهات على موبايلك)', 'secret'), T('notifications.telegram_chat_id', 'Telegram Chat ID', 'text', { dir: 'ltr' }),
    T('notifications.notify_customer_on_status', 'ابعت للعميل رسالة لما تتغير حالة أوردره', 'bool'),
    T('notifications.status_messages', 'رسائل الحالات', 'rows', { asMap: true, cols: [{ k: 'status', label: 'الحالة' }, { k: 'message', label: 'الرسالة ({number} = رقم الأوردر)' }] })] },
  channels: { title: 'ربط القنوات (Meta)', fields: [
    T('channels.public_base_url', 'الرابط العام للسيرفر (https)', 'text', { dir: 'ltr', hint: 'لازم عشان ميتا تبعت صور المنتجات.' }),
    T('channels.app_secret', 'Meta App Secret (للتحقق من الرسائل)', 'secret'),
    T('channels.messenger.enabled', 'تفعيل ماسنجر', 'bool'), T('channels.messenger.page_access_token', 'Page Access Token', 'secret'),
    T('channels.instagram.enabled', 'تفعيل إنستجرام', 'bool'), T('channels.instagram.access_token', 'Instagram Access Token (سيبه فاضي لو بنفس توكن الصفحة)', 'secret'),
    T('channels.whatsapp.enabled', 'تفعيل واتساب', 'bool'), T('channels.whatsapp.phone_number_id', 'WhatsApp Phone Number ID', 'text', { dir: 'ltr' }), T('channels.whatsapp.access_token', 'WhatsApp Access Token', 'secret'),
    T('channels.graph_version', 'إصدار Graph API', 'text', { dir: 'ltr' })] },
};

async function settingsForm(root, groupKeys, { onSaved } = {}) {
  const s = await get('/settings');
  const groups = groupKeys.map((k) => ({ ...GROUPS[k], fields: GROUPS[k].fields.filter((f) => getPath(s, f.path) !== undefined) })).filter((g) => g.fields.length);
  const fields = groups.flatMap((g) => g.fields);
  const byPath = Object.fromEntries(fields.map((f) => [f.path, f]));
  root.innerHTML = groups.map((g) => `<div class="card"><h3 style="margin-top:0">${esc(g.title)}</h3>${g.hint ? `<div class="hint" style="margin-bottom:8px">${esc(g.hint)}</div>` : ''}${g.fields.map((f) => fieldHtml(f, s)).join('')}</div>`).join('')
    + `<div class="row"><button data-savesettings>حفظ التغييرات</button></div>`;
  bindRows(root, byPath);
  $('[data-savesettings]', root).onclick = async () => { await put('/settings', readFields(root, fields)); toast('اتحفظ ✓ وبيتطبق فورًا'); onSaved?.(); };
}

/* ---------------- الصفحات ---------------- */
const pages = {};
let currentPage = ''; let cleanup = null;
const main = () => $('#main');

pages.home = async (el) => {
  const [o, orders, convs, health] = await Promise.all([get('/overview'), get('/orders?status='), get('/conversations?filter=needs_human'), get('/health')]);
  const checks = [
    [o.products > 0, 'ضيف منتجاتك (من شيت أو يدويًا)', '#/import'],
    [Object.values(health.channels).some((c) => c.enabled && c.configured), 'اربط قناة واحدة على الأقل (ماسنجر / إنستجرام / واتساب)', '#/channels'],
    [Boolean(ME.tenant.name && ME.tenant.name !== 'متجرنا'), 'اكتب بيانات المتجر وسياساته', '#/persona'],
  ];
  const owner = ME.role === 'owner';
  el.innerHTML = `<div class="pagehead"><h2>أهلاً، ${esc(ME.tenant.name)}</h2></div>
  <div class="grid g4">
    <div class="card stat"><b>${o.orders_today}</b><span>أوردرات النهارده</span></div>
    <div class="card stat"><b>${fmt(o.sales_today)}</b><span>مبيعات النهارده</span></div>
    <div class="card stat"><b>${o.new_orders}</b><span>أوردرات جديدة لسه</span></div>
    <div class="card stat"><b>${o.needs_human}</b><span>محادثات محتاجاك</span></div>
    <div class="card stat"><b>${o.open_questions}</b><span>أسئلة البوت ما عرفهاش</span></div>
    <div class="card stat"><b>${o.products}</b><span>منتج فعّال</span></div>
  </div>
  ${owner && checks.some((c) => !c[0]) ? `<div class="card"><h3>خطوات التشغيل</h3>${checks.map(([ok, t, h]) => `<div style="padding:4px 0">${ok ? '✅' : '⬜'} ${ok ? esc(t) : `<a href="${h}">${esc(t)}</a>`}</div>`).join('')}</div>` : ''}
  <div class="grid g2">
    <div class="card"><h3>آخر الأوردرات</h3>${orders.slice(0, 6).map((x) => `<div class="row sp" style="padding:6px 0"><a href="#/orders">${esc(x.number)}</a><span>${esc(x.customer_name)}</span><b>${fmt(x.total)}</b><span class="tag">${esc(x.status)}</span></div>`).join('') || '<span class="muted">لسه مفيش أوردرات</span>'}</div>
    <div class="card"><h3>محتاجين تدخلك</h3>${convs.slice(0, 6).map((c) => `<div class="row sp" style="padding:6px 0"><a href="#/chats/${c.id}">${esc(c.display_name || c.external_id)}</a><span class="tag warn">${esc(REASONS[c.needs_human_reason] || 'محتاج رد')}</span><span class="tag">${CH[c.channel]}</span></div>`).join('') || '<span class="muted">مفيش 👌</span>'}</div>
  </div>`;
};
const REASONS = { quota: 'خلصت حصة الردود', human_requested: 'طلب موظف', complaint: 'شكوى', refund: 'استرجاع', payment_proof: 'إيصال دفع', unknown_answer: 'سؤال بدون إجابة', bot_error: 'عطل مؤقت', other: 'محتاج رد' };

/* --- الأوردرات --- */
pages.orders = async (el) => {
  const settings = await get('/settings'); const statuses = settings.orders.statuses;
  let status = ''; let q = '';
  el.innerHTML = `<div class="row sp"><h2>الأوردرات</h2><div class="row"><a class="btn ghost" style="border:1px solid var(--line);color:var(--ink);text-decoration:none;padding:8px 14px;border-radius:9px" href="/api/orders/export.xlsx">تصدير Excel</a><a class="btn ghost" style="border:1px solid var(--line);color:var(--ink);text-decoration:none;padding:8px 14px;border-radius:9px" href="/api/orders/export.csv">تصدير CSV</a></div></div>
  <div class="row" style="margin-bottom:10px"><select id="st" style="max-width:200px"><option value="">كل الحالات</option>${statuses.map((s) => `<option>${esc(s)}</option>`).join('')}</select><input id="sq" placeholder="بحث برقم الأوردر / الاسم / الموبايل" style="max-width:320px"></div><div id="list"></div>`;
  const load = async () => {
    const rows = await get(`/orders?status=${encodeURIComponent(status)}&q=${encodeURIComponent(q)}`);
    $('#list', el).innerHTML = `<div class="card tablewrap"><table><thead><tr><th>رقم</th><th>الوقت</th><th>العميل</th><th>المنتجات</th><th>الإجمالي</th><th>القناة</th><th>الحالة</th><th></th></tr></thead><tbody>${rows.map((o) => `<tr>
      <td><b>${esc(o.number)}</b></td><td>${when(o.created_at)}</td><td>${esc(o.customer_name)}<div class="muted">${esc(o.phone)}<br>${esc(o.governorate)} - ${esc(o.address)}</div></td>
      <td>${o.items.map((i) => `${i.qty}× ${esc(i.name)} ${Object.values(i.options || {}).length ? `<span class="tag">${esc(Object.values(i.options).join(' / '))}</span>` : ''}`).join('<br>')}</td>
      <td><b>${fmt(o.total)}</b><div class="muted">شحن ${fmt(o.shipping)}${o.discount_total ? ` · خصم ${fmt(o.discount_total)}` : ''}</div></td><td>${CH[o.channel] || o.channel}</td>
      <td><select data-st="${o.id}">${statuses.map((s) => `<option ${s === o.status ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select><div>${o.exported ? '<span class="tag ok">اتبعت للشيت</span>' : ''}</div></td>
      <td><button class="ghost small" data-edit="${o.id}">تعديل</button> ${o.conversation_id ? `<a href="#/chats/${o.conversation_id}">المحادثة</a>` : ''}</td></tr>`).join('') || '<tr><td colspan="8" class="muted">مفيش أوردرات</td></tr>'}</tbody></table></div>`;
    $$('[data-st]', el).forEach((s) => { s.onchange = async () => { await api('PATCH', `/orders/${s.dataset.st}`, { status: s.value }); toast('اتغيّرت الحالة'); }; });
    $$('[data-edit]', el).forEach((b) => { b.onclick = () => editOrder(rows.find((x) => x.id == b.dataset.edit)); });
  };
  const editOrder = (o) => modal(`أوردر ${o.number}`, `<label>الاسم</label><input id="o_n" value="${esc(o.customer_name)}"><label>الموبايل</label><input id="o_p" value="${esc(o.phone)}"><label>المحافظة</label><input id="o_g" value="${esc(o.governorate)}"><label>العنوان</label><textarea id="o_a">${esc(o.address)}</textarea><label>ملاحظات</label><textarea id="o_t">${esc(o.notes)}</textarea><div class="row" style="margin-top:8px"><button type="button" class="ghost small" id="o_r">إعادة إرسال للشيت/الـ webhook</button></div>`, {
    onSave: async (m) => { await api('PATCH', `/orders/${o.id}`, { customer_name: $('#o_n', m.el).value, phone: $('#o_p', m.el).value, governorate: $('#o_g', m.el).value, address: $('#o_a', m.el).value, notes: $('#o_t', m.el).value }); load(); },
  }).el.querySelector('#o_r').onclick = async () => { await post(`/orders/${o.id}/resend`); toast('اتجدول الإرسال'); };
  $('#st', el).onchange = (e) => { status = e.target.value; load(); };
  $('#sq', el).oninput = (e) => { q = e.target.value; clearTimeout(pages.orders.t); pages.orders.t = setTimeout(load, 300); };
  await load();
  window.onOrderEvent = load;
  cleanup = () => { window.onOrderEvent = null; };
};

/* --- المحادثات --- */
function threadHtml(messages, { trace } = {}) {
  return messages.map((m) => {
    const img = (m.attachments || []).filter((a) => a.type === 'image').map((a) => `<img src="${a.local ? `/api/inbound/${esc(a.local)}` : esc(a.url)}" alt="صورة من العميل">`).join('');
    const steps = m.meta?.steps?.length ? `<div class="steps">${[...new Set(m.meta.steps)].map((x) => `<span>${esc(x)}</span>`).join('')}</div>` : '';
    const tr = trace && m.meta?.trace?.length ? `<details><summary class="muted" style="font-size:12px;cursor:pointer">🔍 الأدوات (${m.meta.trace.length}) · ${esc(m.meta.provider || '')}</summary><div class="trace">${esc(m.meta.trace.map((t) => `${t.tool}(${JSON.stringify(t.input)})\n→ ${JSON.stringify(t.output).slice(0, 400)}`).join('\n\n'))}</div></details>` : '';
    return `<div class="m ${m.sender} ${m.status === 'failed' ? 'failed' : ''}">${img}${esc(m.text)}${steps}${tr}<small>${m.sender === 'bot' ? 'البوت' : m.sender === 'human' ? 'أنت' : 'العميل'} · ${when(m.created_at)}${m.status === 'failed' ? ' · ⚠️ ما اتبعتش' : ''}</small></div>`;
  }).join('');
}

pages.chats = async (el, arg) => {
  let selected = arg ? Number(arg) : null; let filter = '';
  el.innerHTML = `<div class="row sp"><h2>المحادثات</h2><select id="flt" style="max-width:220px"><option value="">الكل</option><option value="needs_human">محتاجة تدخلي</option><option value="paused">البوت موقوف فيها</option></select></div><div class="chat"><div class="clist" id="clist"></div><div class="thread" id="thread"><div class="msgs muted" style="align-items:center;justify-content:center">اختار محادثة</div></div></div>`;
  const loadList = async () => {
    const convs = await get(`/conversations?filter=${filter}`);
    $('#clist', el).innerHTML = convs.map((c) => `<div class="citem ${c.id === selected ? 'on' : ''}" data-id="${c.id}"><div class="row sp"><b>${esc(c.display_name || c.external_id)}</b>${c.unread ? `<span class="badge">${c.unread}</span>` : ''}</div><div class="t">${esc(c.last_text || '')}</div><div>${`<span class="tag">${CH[c.channel] || c.channel}</span>`}${c.needs_human ? '<span class="tag warn">محتاج تدخل</span>' : ''}${c.bot_paused || c.paused_until > Date.now() ? '<span class="tag bad">البوت موقوف</span>' : ''}${c.orders_count ? `<span class="tag ok">${c.orders_count} أوردر</span>` : ''}</div></div>`).join('') || '<div class="citem muted">مفيش محادثات</div>';
    $$('.citem[data-id]', el).forEach((i) => { i.onclick = () => { selected = Number(i.dataset.id); location.hash = `#/chats/${selected}`; }; });
  };
  const loadThread = async () => {
    if (!selected) return;
    const d = await get(`/conversations/${selected}`); const c = d.conversation;
    const th = $('#thread', el); const prev = $('.msgs', th); const atBottom = !prev || prev.scrollHeight - prev.scrollTop - prev.clientHeight < 80;
    const draft = $('#reply', th)?.value || '';
    th.innerHTML = `<div class="row sp" style="padding:10px 14px;border-bottom:1px solid var(--line)"><div><b>${esc(c.display_name || c.external_id)}</b> <span class="tag">${CH[c.channel] || c.channel}</span><div class="muted" style="font-size:12px">${esc(Object.values(c.customer || {}).join(' · '))}</div></div>
      <div class="row"><button class="small ${c.bot_active ? 'ghost' : ''}" id="tg">${c.bot_active ? '⏸ إيقاف البوت' : '▶ تشغيل البوت'}</button>${c.needs_human ? '<button class="small ghost" id="rs">تم الحل</button>' : ''}</div></div>
      ${d.unanswered.map((u) => `<div style="padding:10px 14px;background:var(--soft)"><b>❓ سؤال البوت ما عرفش يجاوبه:</b> ${esc(u.question)}<div class="row" style="margin-top:6px"><textarea data-ua="${u.id}" style="min-height:50px" placeholder="اكتب الإجابة، هتتبعت للعميل وتتحفظ في قاعدة المعرفة"></textarea><button class="small" data-uans="${u.id}">رد وتعلّم</button></div></div>`).join('')}
      <div class="msgs" id="msgs">${threadHtml(d.messages, { trace: ME?.platform_admin })}</div>
      <div class="composer"><textarea id="reply" placeholder="اكتب رد بنفسك (البوت هيسكت ${'شوية'} لحد ما تخلص)">${esc(draft)}</textarea><button id="send">إرسال</button></div>`;
    const ms = $('#msgs', th); if (atBottom || !prev) ms.scrollTop = ms.scrollHeight; else ms.scrollTop = prev.scrollTop;
    $('#tg', th).onclick = async () => { await post(`/conversations/${selected}/pause`, { paused: c.bot_active }); loadThread(); loadList(); };
    $('#rs', th)?.addEventListener('click', async () => { await post(`/conversations/${selected}/resolve`); loadThread(); loadList(); });
    const send = async () => { const t = $('#reply', th).value.trim(); if (!t) return; $('#reply', th).value = ''; await post(`/conversations/${selected}/send`, { text: t }); loadThread(); loadList(); };
    $('#send', th).onclick = send;
    $('#reply', th).onkeydown = (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send(); };
    $$('[data-uans]', th).forEach((b) => { b.onclick = async () => { const a = $(`[data-ua="${b.dataset.uans}"]`, th).value.trim(); if (!a) return; await post(`/unanswered/${b.dataset.uans}/answer`, { answer: a }); toast('اتبعت واتحفظ في قاعدة المعرفة ✓'); loadThread(); loadList(); }; });
    await loadList();
  };
  $('#flt', el).onchange = (e) => { filter = e.target.value; loadList(); };
  await loadList(); await loadThread();
  window.onMsgEvent = (ev) => { loadList(); if (ev.data.conversation_id === selected) loadThread(); };
  cleanup = () => { window.onMsgEvent = null; };
};

/* --- تجربة البوت --- */
pages.sim = async (el) => {
  const key = 'im_sim_session'; let session = localStorage.getItem(key) || 'default'; let img = null;
  el.innerHTML = `<div class="row sp"><h2>تجربة البوت</h2><div class="row"><button class="ghost small" id="newchat">محادثة جديدة</button><button class="ghost small" id="seeprompt">شوف البرومبت الكامل</button></div></div>
  <div class="hint" style="margin-bottom:8px">جرّب العميل بنفسك. ده بيمشي على نفس الإعدادات والمنتجات الحقيقية، لكن الأوردرات اللي هتعملها هنا بتتسجل فعلًا (امسحها من صفحة الأوردرات). 🔍 تحت كل رد بتشوف الأدوات اللي البوت استخدمها.</div>
  <div class="thread" style="height:calc(100vh - 220px)"><div class="msgs" id="msgs"></div><div class="composer"><input type="file" id="file" accept="image/*" hidden><button class="ghost" id="att">📎</button><textarea id="txt" placeholder="اكتب كأنك عميل..."></textarea><button id="send">إرسال</button></div></div>`;
  let convId = null;
  const refresh = async () => {
    if (!convId) { const list = await get('/conversations'); convId = list.find((c) => c.channel === 'simulator' && c.external_id === session)?.id || null; }
    if (!convId) return;
    const d = await get(`/conversations/${convId}`); const ms = $('#msgs', el);
    ms.innerHTML = threadHtml(d.messages, { trace: ME?.platform_admin }); ms.scrollTop = ms.scrollHeight;
  };
  const send = async () => {
    const text = $('#txt', el).value.trim(); if (!text && !img) return;
    $('#txt', el).value = '';
    const r = await post('/sim/message', { session, text, image: img }); convId = r.conversation_id; img = null; $('#att', el).textContent = '📎';
    await refresh(); const t0 = Date.now();
    const poll = setInterval(async () => { await refresh().catch(() => {}); if (Date.now() - t0 > 40000) clearInterval(poll); }, 1200);
    pages.sim.poll = poll;
  };
  $('#send', el).onclick = send; $('#txt', el).onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } };
  $('#att', el).onclick = () => $('#file', el).click();
  $('#file', el).onchange = async (e) => { const f = e.target.files[0]; if (!f) return; const r = await api('POST', `/sim/upload?name=${encodeURIComponent(f.name)}`, undefined, f); img = r.file; $('#att', el).textContent = '✅ صورة'; };
  $('#newchat', el).onclick = async () => { await post('/sim/reset', { session }); session = 's' + Date.now().toString(36); localStorage.setItem(key, session); convId = null; $('#msgs', el).innerHTML = ''; };
  $('#seeprompt', el).onclick = async () => { const p = await get('/prompt-preview'); modal(`البرومبت الكامل (وضع: ${p.mode} · المشغّل: ${p.provider})`, `<pre class="prompt">${esc(p.prompt)}</pre>`, { wide: true }); };
  await refresh();
  window.onMsgEvent = (ev) => { if (ev.data.conversation_id === convId) refresh(); };
  cleanup = () => { window.onMsgEvent = null; clearInterval(pages.sim.poll); };
};

/* --- المنتجات --- */
pages.products = async (el) => {
  let cats = await get('/categories-with-counts'); const state = { category: '', q: '', active: '', offset: 0 }; const LIMIT = 50; let sel = new Set();
  el.innerHTML = `<div class="row sp"><h2>المنتجات</h2><div class="row"><a href="#/import" class="btn" style="text-decoration:none">استيراد من شيت/إكسل</a><button id="add" class="ghost">+ منتج يدوي</button></div></div>
  <div class="row" style="margin-bottom:10px"><select id="fc" style="max-width:200px"><option value="">كل الأقسام</option>${cats.map((c) => `<option value="${c.id}">${esc(c.name)} (${c.product_count})</option>`).join('')}</select><select id="fa" style="max-width:150px"><option value="">الكل</option><option value="1">فعّال</option><option value="0">متوقف</option></select><input id="fq" placeholder="بحث..." style="max-width:260px"><span id="bulk" class="row"></span></div><div id="list"></div>`;
  const load = async () => {
    const r = await get(`/products?category=${state.category}&active=${state.active}&q=${encodeURIComponent(state.q)}&limit=${LIMIT}&offset=${state.offset}`);
    $('#list', el).innerHTML = `<div class="card tablewrap"><table><thead><tr><th><input type="checkbox" id="all" style="width:auto"></th><th>المنتج</th><th>القسم</th><th>السعر</th><th>المخزون</th><th>الخصائص</th><th></th></tr></thead><tbody>${r.items.map((p) => `<tr style="${p.active ? '' : 'opacity:.5'}"><td><input type="checkbox" data-sel="${p.id}" style="width:auto" ${sel.has(p.id) ? 'checked' : ''}></td>
      <td><div class="row" style="flex-wrap:nowrap">${p.images[0] ? `<img src="${esc(p.images[0])}" style="width:42px;height:42px;object-fit:cover;border-radius:8px" onerror="this.remove()">` : ''}<div><b>${esc(p.name)}</b><div class="muted">${esc(p.sku || '')}</div></div></div></td><td>${esc(p.category_name || '—')}</td><td>${fmt(p.price)}</td><td>${p.stock === null ? '∞' : p.stock}</td>
      <td>${Object.entries(p.attributes).slice(0, 4).map(([k, v]) => `<span class="tag">${esc(k)}: ${esc(String(v).slice(0, 24))}</span>`).join('')}</td><td><button class="ghost small" data-edit="${p.id}">تعديل</button></td></tr>`).join('') || '<tr><td colspan="7" class="muted">لسه مفيش منتجات. استورد من شيت أو ضيف يدويًا.</td></tr>'}</tbody></table></div>
      <div class="row sp"><span class="muted">${r.total} منتج</span><div class="row"><button class="ghost small" id="prev" ${state.offset ? '' : 'disabled'}>السابق</button><button class="ghost small" id="next" ${state.offset + LIMIT < r.total ? '' : 'disabled'}>التالي</button></div></div>`;
    $$('[data-edit]', el).forEach((b) => { b.onclick = async () => productModal(await get(`/products/${b.dataset.edit}`)); });
    $$('[data-sel]', el).forEach((c) => { c.onchange = () => { c.checked ? sel.add(Number(c.dataset.sel)) : sel.delete(Number(c.dataset.sel)); bulk(); }; });
    $('#all', el).onchange = (e) => { $$('[data-sel]', el).forEach((c) => { c.checked = e.target.checked; c.onchange(); }); };
    $('#prev', el).onclick = () => { state.offset = Math.max(0, state.offset - LIMIT); load(); }; $('#next', el).onclick = () => { state.offset += LIMIT; load(); };
    bulk();
  };
  const bulk = () => {
    $('#bulk', el).innerHTML = sel.size ? `<span>${sel.size} محدد:</span><button class="ghost small" data-b="activate">تفعيل</button><button class="ghost small" data-b="deactivate">إيقاف</button><button class="ghost small" data-b="set_category">نقل لقسم</button><button class="danger small" data-b="delete">حذف</button>` : '';
    $$('[data-b]', el).forEach((b) => { b.onclick = async () => {
      let category_id; if (b.dataset.b === 'set_category') { const n = prompt('اسم القسم (من الأقسام الموجودة):'); category_id = cats.find((c) => c.name === n)?.id; if (!category_id) return toast('القسم مش موجود', true); }
      if (b.dataset.b === 'delete' && !confirmBox('متأكد من حذف المنتجات المحددة؟')) return;
      await post('/products/bulk', { ids: [...sel], action: b.dataset.b, category_id }); sel = new Set(); load();
    }; });
  };
  const productModal = (p = {}) => {
    const attrs = Object.entries(p.attributes || {});
    const row = (k = '', v = '') => `<div class="row attr" style="margin-bottom:4px"><input placeholder="الخاصية (مقاس، لون...)" value="${esc(k)}" style="flex:1"><input placeholder="القيم (افصل بفاصلة لو أكتر من اختيار)" value="${esc(v)}" style="flex:2"><button type="button" class="ghost small" data-x>✕</button></div>`;
    const m = modal(p.id ? 'تعديل منتج' : 'منتج جديد', `<div class="grid g2"><div><label>الاسم</label><input id="p_name" value="${esc(p.name)}"></div><div><label>الكود (SKU)</label><input id="p_sku" value="${esc(p.sku)}"></div>
      <div><label>القسم</label><select id="p_cat"><option value="">— بدون —</option>${cats.map((c) => `<option value="${c.id}" ${c.id === p.category_id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div><div><label>السعر</label><input type="number" id="p_price" value="${esc(p.price ?? '')}"></div>
      <div><label>السعر قبل الخصم (اختياري)</label><input type="number" id="p_cmp" value="${esc(p.compare_price ?? '')}"></div><div><label>المخزون (فاضي = غير محدود)</label><input type="number" id="p_stock" value="${p.stock ?? ''}"></div></div>
      <label>الوصف</label><textarea id="p_desc">${esc(p.description)}</textarea><label>تعليمات للبوت خاصة بالمنتج ده</label><textarea id="p_notes" style="min-height:60px" placeholder="مثلًا: ما تعرضش خصم على المنتج ده / المقاس بيصغر نمرة">${esc(p.notes)}</textarea>
      <label>روابط الصور (واحد في كل سطر)</label><textarea id="p_imgs" style="min-height:70px" dir="ltr">${esc((p.images || []).join('\n'))}</textarea><div class="row"><input type="file" id="p_file" accept="image/*" hidden><button type="button" class="ghost small" id="p_up">⬆ رفع صورة من جهازك</button></div>
      <label>الخصائص (أعمدة ديناميكية)</label><div id="attrs">${attrs.map(([k, v]) => row(k, v)).join('')}</div><button type="button" class="ghost small" id="addattr">+ خاصية</button>
      <label class="chk"><input type="checkbox" id="p_act" ${p.active === 0 ? '' : 'checked'}> فعّال (ظاهر للبوت)</label>${p.id ? '<div style="margin-top:8px"><button type="button" class="danger small" id="p_del">حذف المنتج</button></div>' : ''}`, {
      onSave: async (mm) => {
        const attributes = {}; $$('.attr', mm.el).forEach((r) => { const [k, v] = $$('input', r); if (k.value.trim() && v.value.trim()) attributes[k.value.trim()] = v.value.trim(); });
        const body = { name: $('#p_name', mm.el).value, sku: $('#p_sku', mm.el).value, category_id: $('#p_cat', mm.el).value || null, price: $('#p_price', mm.el).value, compare_price: $('#p_cmp', mm.el).value, stock: $('#p_stock', mm.el).value, description: $('#p_desc', mm.el).value, notes: $('#p_notes', mm.el).value, images: $('#p_imgs', mm.el).value.split('\n').map((s) => s.trim()).filter(Boolean), attributes, active: $('#p_act', mm.el).checked ? 1 : 0 };
        p.id ? await put(`/products/${p.id}`, body) : await post('/products', body); toast('اتحفظ ✓'); load();
      } });
    m.el.addEventListener('click', (e) => { if (e.target.closest('[data-x]')) e.target.closest('.attr').remove(); });
    $('#addattr', m.el).onclick = () => $('#attrs', m.el).insertAdjacentHTML('beforeend', row());
    $('#p_up', m.el).onclick = () => $('#p_file', m.el).click();
    $('#p_file', m.el).onchange = async (e) => { const f = e.target.files[0]; if (!f) return; const r = await api('POST', `/upload?name=${encodeURIComponent(f.name)}`, undefined, f); const ta = $('#p_imgs', m.el); ta.value = (ta.value ? ta.value + '\n' : '') + r.url; toast('اترفعت'); };
    $('#p_del', m.el)?.addEventListener('click', async () => { if (confirmBox('حذف المنتج؟')) { await del(`/products/${p.id}`); m.close(); load(); } });
  };
  $('#add', el).onclick = () => productModal();
  $('#fc', el).onchange = (e) => { state.category = e.target.value; state.offset = 0; load(); };
  $('#fa', el).onchange = (e) => { state.active = e.target.value; state.offset = 0; load(); };
  $('#fq', el).oninput = (e) => { state.q = e.target.value; state.offset = 0; clearTimeout(pages.products.t); pages.products.t = setTimeout(load, 300); };
  await load();
};

/* --- الأقسام --- */
pages.categories = async (el) => {
  const load = async () => {
    const cats = await get('/categories-with-counts');
    el.innerHTML = `<div class="row sp"><h2>الأقسام</h2><button id="add">+ قسم</button></div><div class="hint" style="margin-bottom:10px">الأقسام بتتعمل تلقائيًا من الشيت. هنا بتحدد تعليمات البوت لكل قسم وإيه اللي يسأل عنه العميل قبل الإضافة للسلة (مثلًا الأحذية: المقاس الأوروبي).</div>
    ${cats.map((c) => `<div class="card"><div class="row sp"><h3 style="margin:0">${esc(c.name)} <span class="tag">${c.product_count} منتج</span> ${c.active ? '' : '<span class="tag bad">متوقف</span>'}</h3><button class="ghost small" data-edit="${c.id}">تعديل</button></div>
      ${c.instructions ? `<div style="margin-top:6px">📝 ${esc(c.instructions)}</div>` : ''}${c.required_fields.length ? `<div style="margin-top:6px">يسأل عن: ${c.required_fields.map((f) => `<span class="tag">${esc(f)}</span>`).join('')}</div>` : ''}</div>`).join('') || '<div class="card muted">مفيش أقسام لسه</div>'}`;
    const edit = (c = {}) => modal(c.id ? 'تعديل قسم' : 'قسم جديد', `<label>الاسم</label><input id="c_n" value="${esc(c.name)}"><label>وصف</label><input id="c_d" value="${esc(c.description)}">
      <label>تعليمات للبوت في القسم ده</label><textarea id="c_i" placeholder="مثلًا: اسأل دايمًا عن المقاس الأوروبي، وانصح بمقاس أكبر لو العميل عنده قدم عريضة">${esc(c.instructions)}</textarea>
      <label>حقول لازم يسأل عنها قبل الإضافة للسلة</label><input id="c_f" value="${esc((c.required_fields || []).join('، '))}"><div class="hint">لازم تطابق أسماء أعمدة الشيت (مثلًا: المقاس، اللون). افصل بفاصلة.</div>
      <label>سياسة القسم (إرجاع/ضمان...)</label><textarea id="c_p" style="min-height:60px">${esc(c.policy)}</textarea><label class="chk"><input type="checkbox" id="c_a" ${c.active === 0 ? '' : 'checked'}> فعّال</label>${c.id ? '<button class="danger small" id="c_del" type="button">حذف القسم</button>' : ''}`, {
      onSave: async (m) => { const b = { name: $('#c_n', m.el).value, description: $('#c_d', m.el).value, instructions: $('#c_i', m.el).value, required_fields: $('#c_f', m.el).value.split(/[,،]/).map((s) => s.trim()).filter(Boolean), policy: $('#c_p', m.el).value, active: $('#c_a', m.el).checked }; c.id ? await put(`/categories/${c.id}`, b) : await post('/categories', b); toast('اتحفظ ✓'); load(); } });
    $('#add', el).onclick = () => edit();
    $$('[data-edit]', el).forEach((b) => { b.onclick = () => { const m = edit(cats.find((c) => c.id == b.dataset.edit)); $('#c_del', m.el)?.addEventListener('click', async () => { if (confirmBox('حذف القسم؟ المنتجات هتفضل بدون قسم.')) { await del(`/categories/${b.dataset.edit}`); m.close(); load(); } }); }; });
  };
  await load();
};

/* --- الاستيراد --- */
pages.import = async (el) => {
  const MAPF = [['name', 'اسم المنتج'], ['price', 'السعر'], ['category', 'القسم'], ['stock', 'الكمية'], ['description', 'الوصف'], ['images', 'الصور (روابط)'], ['sku', 'الكود'], ['compare_price', 'السعر قبل الخصم'], ['notes', 'ملاحظات للبوت'], ['active', 'فعّال؟']];
  const load = async () => {
    const sources = await get('/sources');
    el.innerHTML = `<div class="row sp"><h2>استيراد المنتجات (شيت / إكسل)</h2><button id="add">+ مصدر جديد</button></div>
    <div class="hint" style="margin-bottom:10px">الصق رابط Google Sheet (مشارك "أي شخص معاه الرابط") أو ارفع ملف Excel/CSV. أي عمود مش اسم/سعر/قسم/... بيتحول لخاصية للمنتج (مقاس، لون، خامة...) بدون ما تعمل حاجة. وممكن يتحدث تلقائيًا كل كام دقيقة.</div>
    ${sources.map((s) => `<div class="card"><div class="row sp"><h3 style="margin:0">${esc(s.name)} <span class="tag">${{ google_sheet: 'Google Sheet', url: 'رابط', file: 'ملف' }[s.type]}</span> <span class="tag">${s.product_count} منتج</span></h3><div class="row"><button class="small" data-sync="${s.id}">🔄 تحديث دلوقتي</button><button class="ghost small" data-map="${s.id}">ربط الأعمدة</button><button class="ghost small" data-cfg="${s.id}">إعدادات</button></div></div>
      <div class="muted" style="margin-top:6px">${esc(s.url || '')} ${s.last_sync ? `· آخر تحديث ${when(s.last_sync)} · ${esc(s.last_status)}` : '· لسه ما اتحدّثش'} ${s.sync_minutes ? `· تحديث تلقائي كل ${s.sync_minutes} دقيقة` : ''}</div></div>`).join('') || '<div class="card muted">لسه مفيش مصادر. دوس "مصدر جديد".</div>'}`;
    $('#add', el).onclick = () => srcModal();
    $$('[data-sync]', el).forEach((b) => { b.onclick = async () => { b.disabled = true; b.textContent = '...'; try { const r = await post(`/sources/${b.dataset.sync}/sync`); toast(`تم: ${r.created} جديد، ${r.updated} تحديث، ${r.deactivated} متوقف${r.errors.length ? ` — ${r.errors.length} تحذير` : ''}`); if (r.categories_created.length) toast(`أقسام جديدة: ${r.categories_created.join('، ')} — راجع تعليماتها من صفحة الأقسام`); if (r.errors.length) modal('تحذيرات الاستيراد', `<ul>${r.errors.slice(0, 50).map((e) => `<li>${esc(e)}</li>`).join('')}</ul>`); } catch {} load(); }; });
    $$('[data-cfg]', el).forEach((b) => { b.onclick = () => srcModal(sources.find((s) => s.id == b.dataset.cfg)); });
    $$('[data-map]', el).forEach((b) => { b.onclick = () => mapModal(sources.find((s) => s.id == b.dataset.map)); });
  };
  const srcModal = (s = {}) => {
    const m = modal(s.id ? 'إعدادات المصدر' : 'مصدر جديد', `<label>اسم المصدر</label><input id="s_n" value="${esc(s.name || '')}" placeholder="مثلًا: منتجات الملابس">
      <label>النوع</label><select id="s_t" ${s.id ? 'disabled' : ''}><option value="google_sheet" ${s.type === 'google_sheet' ? 'selected' : ''}>رابط Google Sheet</option><option value="file" ${s.type === 'file' ? 'selected' : ''}>ملف Excel / CSV</option><option value="url" ${s.type === 'url' ? 'selected' : ''}>رابط مباشر لـ CSV/XLSX</option></select>
      <div id="s_url_w"><label>الرابط</label><input id="s_u" dir="ltr" value="${esc(s.url || '')}" placeholder="https://docs.google.com/spreadsheets/d/..."></div>
      <div id="s_file_w"><label>الملف</label><input type="file" id="s_f" accept=".xlsx,.csv"></div>
      <label>القسم الافتراضي (لو الشيت مفيهوش عمود قسم)</label><input id="s_c" value="${esc(s.default_category || '')}" placeholder="مثلًا: أحذية">
      <label>تحديث تلقائي كل (دقيقة، 0 = يدوي)</label><input type="number" id="s_m" value="${s.sync_minutes ?? 0}">
      <label class="chk"><input type="checkbox" id="s_d" ${s.deactivate_missing === 0 ? '' : 'checked'}> المنتج اللي يتشال من الشيت يتوقف عند البوت</label>${s.id ? '<button class="danger small" id="s_del" type="button">حذف المصدر</button>' : ''}`, {
      saveText: s.id ? 'حفظ' : 'حفظ واستيراد', onSave: async (mm) => {
        const type = $('#s_t', mm.el).value; const body = { name: $('#s_n', mm.el).value, type, url: $('#s_u', mm.el).value.trim(), default_category: $('#s_c', mm.el).value, sync_minutes: Number($('#s_m', mm.el).value) || 0, deactivate_missing: $('#s_d', mm.el).checked };
        if (!body.name) { toast('اكتب اسم', true); return false; }
        const file = $('#s_f', mm.el).files[0];
        const src = s.id ? await put(`/sources/${s.id}`, body) : await post('/sources', body);
        if (type === 'file' && file) await api('POST', `/sources/${src.id}/file?name=${encodeURIComponent(file.name)}`, undefined, file);
        if (!s.id) { try { const r = await post(`/sources/${src.id}/sync`); toast(`اتستورد ${r.created} منتج`); if (r.categories_created.length) toast(`أقسام جديدة: ${r.categories_created.join('، ')}`); } catch { /* الخطأ ظهر */ } }
        load();
      } });
    const sync = () => { const t = $('#s_t', m.el).value; $('#s_url_w', m.el).style.display = t === 'file' ? 'none' : ''; $('#s_file_w', m.el).style.display = t === 'file' ? '' : 'none'; };
    $('#s_t', m.el).onchange = sync; sync();
    $('#s_del', m.el)?.addEventListener('click', async () => { const withP = confirmBox('تحذف المنتجات المستوردة من المصدر ده كمان؟ (OK = احذفها، Cancel = سيبها)'); if (confirmBox('تأكيد حذف المصدر؟')) { await del(`/sources/${s.id}?delete_products=${withP ? 1 : 0}`); m.close(); load(); } });
  };
  const mapModal = async (s) => {
    let prev; try { prev = await get(`/sources/${s.id}/preview`); } catch { return; }
    const cur = Object.keys(s.mapping).length ? s.mapping : prev.suggested_mapping;
    const opts = (sel) => `<option value="">— مفيش —</option>${prev.headers.map((h) => `<option ${h === sel ? 'selected' : ''}>${esc(h)}</option>`).join('')}`;
    modal('ربط أعمدة الشيت', `<div class="hint">حددنا الأعمدة تلقائيًا. عدّل لو في غلط. الأعمدة غير المربوطة بتتحول لخصائص.</div><div class="grid g2">${MAPF.map(([k, l]) => `<div><label>${l}</label><select data-m="${k}">${opts(cur[k])}</select></div>`).join('')}</div>
      <label>الأعمدة اللي تتحول لخصائص (مقاس، لون...)</label><div>${prev.headers.map((h) => `<label class="chk" style="display:inline-flex;margin-inline-end:12px"><input type="checkbox" data-a="${esc(h)}" ${(cur.attributes || []).includes(h) ? 'checked' : ''}> ${esc(h)}</label>`).join('')}</div>
      <h3>أول صفوف من الشيت (${prev.total_rows} صف)</h3><div class="tablewrap"><table><thead><tr>${prev.headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${prev.sample.map((r) => `<tr>${prev.headers.map((h) => `<td>${esc(r[h])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`, {
      wide: true, saveText: 'حفظ وتحديث', onSave: async (mm) => {
        const mapping = {}; $$('[data-m]', mm.el).forEach((x) => { if (x.value) mapping[x.dataset.m] = x.value; });
        if (!mapping.name) { toast('لازم تحدد عمود اسم المنتج', true); return false; }
        mapping.attributes = $$('[data-a]', mm.el).filter((x) => x.checked).map((x) => x.dataset.a);
        await put(`/sources/${s.id}`, { mapping }); const r = await post(`/sources/${s.id}/sync`); toast(`تم: ${r.created} جديد، ${r.updated} تحديث`); load();
      } });
  };
  await load();
};

/* --- الشحن --- */
pages.shipping = async (el) => {
  const load = async () => {
    const [rates, s] = await Promise.all([get('/shipping'), get('/settings')]);
    el.innerHTML = `<div class="row sp"><h2>الشحن حسب المحافظة</h2><button id="add" class="ghost">+ محافظة</button></div>
    <div class="grid g2"><div class="card"><label style="margin-top:0">سعر الشحن الافتراضي</label><input type="number" id="def" value="${s.shipping.default_price}"><label>شحن مجاني لو المبلغ فوق (0 = معطل)</label><input type="number" id="free" value="${s.shipping.free_over}"><button id="savegen" style="margin-top:10px" class="small">حفظ</button></div>
    <div class="card"><label style="margin-top:0">لصق سريع (سطر لكل محافظة: الاسم,السعر,مدة التوصيل)</label><textarea id="bulk" placeholder="القاهرة,45,1-2 يوم&#10;أسيوط,75,3-4 أيام" style="min-height:90px"></textarea><button id="dobulk" class="small" style="margin-top:6px">تطبيق</button></div></div>
    <div class="card tablewrap"><table><thead><tr><th>المحافظة</th><th>السعر</th><th>مدة التوصيل</th><th>أسماء بديلة</th><th>فعّال</th><th></th></tr></thead><tbody>${rates.map((r) => `<tr data-id="${r.id}"><td><input data-f="governorate" value="${esc(r.governorate)}"></td><td><input data-f="price" type="number" value="${r.price}" style="width:90px"></td><td><input data-f="eta" value="${esc(r.eta)}"></td><td><input data-f="aliases" value="${esc(r.aliases)}" dir="ltr"></td><td><input data-f="active" type="checkbox" ${r.active ? 'checked' : ''} style="width:auto"></td><td><button class="danger small" data-del="${r.id}">✕</button></td></tr>`).join('')}</tbody></table></div>`;
    $$('tr[data-id] [data-f]', el).forEach((i) => { i.onchange = async () => { const tr = i.closest('tr'); const b = {}; $$('[data-f]', tr).forEach((x) => { b[x.dataset.f] = x.type === 'checkbox' ? x.checked : x.value; }); await put(`/shipping/${tr.dataset.id}`, b); toast('اتحفظ'); }; });
    $$('[data-del]', el).forEach((b) => { b.onclick = async () => { if (confirmBox('حذف؟')) { await del(`/shipping/${b.dataset.del}`); load(); } }; });
    $('#savegen', el).onclick = async () => { await put('/settings', { shipping: { default_price: Number($('#def', el).value), free_over: Number($('#free', el).value) } }); toast('اتحفظ ✓'); };
    $('#dobulk', el).onclick = async () => { const r = await post('/shipping/bulk', { text: $('#bulk', el).value }); toast(`اتحدّث ${r.updated} محافظة`); load(); };
    $('#add', el).onclick = async () => { const n = prompt('اسم المحافظة/المنطقة:'); if (!n) return; const p = prompt('سعر الشحن:', s.shipping.default_price); await post('/shipping', { governorate: n, price: Number(p) || 0 }); load(); };
  };
  await load();
};

/* --- الخصومات والأوضاع --- */
pages.discounts = async (el) => {
  const load = async () => {
    const [rules, modes, s] = await Promise.all([get('/discounts'), get('/modes'), get('/settings')]);
    const TR = { retention: 'لما العميل يتردد/هيمشي', min_order: 'تلقائي فوق حد معين', coupon: 'كوبون', manual: 'يدوي فقط' };
    el.innerHTML = `<h2>أوضاع البوت</h2><div class="hint" style="margin-bottom:10px">الوضع بيحدد "طريقة شغل" البوت: هل ياخد أوردرات، هل يقترح منتجات مكمّلة، هل يقدر يعرض خصم لو العميل هيمشي. بدّل الوضع في أي وقت.</div>
    <div class="grid g2">${modes.map((m) => `<div class="card" style="${m.id === s.active_mode_id ? 'outline:2px solid var(--brand)' : ''}"><div class="row sp"><h3 style="margin:0">${esc(m.name)}</h3>${m.id === s.active_mode_id ? '<span class="tag ok">الوضع الحالي</span>' : `<button class="small" data-use="${m.id}">تفعيل</button>`}</div><div class="muted">${esc(m.description)}</div>
      <div style="margin-top:6px">${m.take_orders ? '<span class="tag">ياخد أوردرات</span>' : '<span class="tag bad">بدون أوردرات</span>'}${m.allow_retention_discount ? '<span class="tag warn">يعرض خصم للمتردد</span>' : ''}${m.allow_upsell ? '<span class="tag">يقترح مكمّلات</span>' : ''}${m.send_images ? '<span class="tag">يبعت صور</span>' : ''}</div><div class="row" style="margin-top:8px"><button class="ghost small" data-medit="${m.id}">تعديل</button></div></div>`).join('')}</div><button id="addmode" class="ghost" style="margin-top:6px">+ وضع جديد</button>
    <h2 style="margin-top:26px">قواعد الخصم</h2><div class="hint" style="margin-bottom:10px">البوت ما يقدرش يطلّع خصم من دماغه: بيستخدم القواعد دي بس، وبحدود اللي تحددها (وأقصى خصم عام من الإعدادات).</div>
    <div class="card tablewrap"><table><thead><tr><th>الاسم</th><th>الخصم</th><th>متى</th><th>شروط</th><th>فعّال</th><th></th></tr></thead><tbody>${rules.map((r) => `<tr><td>${esc(r.name)}${r.coupon_code ? `<div class="tag">${esc(r.coupon_code)}</div>` : ''}</td><td>${r.type === 'percent' ? r.value + '%' : fmt(r.value) + ' جنيه'}${r.max_discount ? `<div class="muted">حد أقصى ${fmt(r.max_discount)}</div>` : ''}</td><td>${TR[r.trigger]}</td><td>${r.min_order ? `فوق ${fmt(r.min_order)}` : ''}<div class="muted">${esc(r.instructions)}</div></td><td>${r.active ? '✅' : '⬜'}</td><td><button class="ghost small" data-redit="${r.id}">تعديل</button></td></tr>`).join('')}</tbody></table></div><button id="addrule">+ قاعدة خصم</button>`;
    $$('[data-use]', el).forEach((b) => { b.onclick = async () => { await put('/settings', { active_mode_id: Number(b.dataset.use) }); toast('اتفعّل الوضع'); load(); }; });
    const modeModal = (m = {}) => { const mm = modal(m.id ? 'تعديل وضع' : 'وضع جديد', `<label>الاسم</label><input id="m_n" value="${esc(m.name)}"><label>وصف</label><input id="m_d" value="${esc(m.description)}"><label>تعليمات الوضع للبوت</label><textarea id="m_i">${esc(m.instructions)}</textarea>
      <label class="chk"><input type="checkbox" id="m_o" ${m.take_orders === 0 ? '' : 'checked'}> ياخد أوردرات</label><label class="chk"><input type="checkbox" id="m_r" ${m.allow_retention_discount ? 'checked' : ''}> يقدر يعرض خصم لو العميل متردد/هيمشي (من قواعد الخصم)</label><label class="chk"><input type="checkbox" id="m_u" ${m.allow_upsell ? 'checked' : ''}> يقترح منتجات مكمّلة</label><label class="chk"><input type="checkbox" id="m_s" ${m.send_images === 0 ? '' : 'checked'}> يبعت صور المنتجات</label>${m.id ? '<button class="danger small" id="m_del" type="button">حذف</button>' : ''}`, {
      onSave: async (x) => { const b = { name: $('#m_n', x.el).value, description: $('#m_d', x.el).value, instructions: $('#m_i', x.el).value, take_orders: $('#m_o', x.el).checked, allow_retention_discount: $('#m_r', x.el).checked, allow_upsell: $('#m_u', x.el).checked, send_images: $('#m_s', x.el).checked }; m.id ? await put(`/modes/${m.id}`, b) : await post('/modes', b); load(); } });
      $('#m_del', mm.el)?.addEventListener('click', async () => { if (m.id === s.active_mode_id) return toast('ما ينفعش تحذف الوضع الحالي', true); await del(`/modes/${m.id}`); mm.close(); load(); }); };
    $('#addmode', el).onclick = () => modeModal(); $$('[data-medit]', el).forEach((b) => { b.onclick = () => modeModal(modes.find((m) => m.id == b.dataset.medit)); });
    const ruleModal = (r = {}) => { const mm = modal(r.id ? 'تعديل خصم' : 'قاعدة خصم جديدة', `<label>الاسم</label><input id="r_n" value="${esc(r.name)}"><div class="grid g2"><div><label>النوع</label><select id="r_t"><option value="percent" ${r.type !== 'fixed' ? 'selected' : ''}>نسبة %</option><option value="fixed" ${r.type === 'fixed' ? 'selected' : ''}>مبلغ ثابت</option></select></div><div><label>القيمة</label><input type="number" id="r_v" value="${r.value ?? 10}"></div>
      <div><label>متى يتطبق</label><select id="r_g">${Object.entries(TR).map(([k, v]) => `<option value="${k}" ${r.trigger === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div><div><label>حد أدنى للطلب</label><input type="number" id="r_m" value="${r.min_order || 0}"></div><div><label>أقصى مبلغ خصم (0 = بدون)</label><input type="number" id="r_x" value="${r.max_discount || 0}"></div><div><label>كود الكوبون (لو كوبون)</label><input id="r_c" dir="ltr" value="${esc(r.coupon_code)}"></div></div>
      <label>متى البوت يعرضه (تعليمات)</label><textarea id="r_i" style="min-height:60px">${esc(r.instructions)}</textarea><label class="chk"><input type="checkbox" id="r_a" ${r.active === 0 ? '' : 'checked'}> فعّال</label>${r.id ? '<button class="danger small" id="r_del" type="button">حذف</button>' : ''}`, {
      onSave: async (x) => { const b = { name: $('#r_n', x.el).value, type: $('#r_t', x.el).value, value: Number($('#r_v', x.el).value), trigger: $('#r_g', x.el).value, min_order: Number($('#r_m', x.el).value), max_discount: Number($('#r_x', x.el).value), coupon_code: $('#r_c', x.el).value, instructions: $('#r_i', x.el).value, active: $('#r_a', x.el).checked }; r.id ? await put(`/discounts/${r.id}`, b) : await post('/discounts', b); load(); } });
      $('#r_del', mm.el)?.addEventListener('click', async () => { await del(`/discounts/${r.id}`); mm.close(); load(); }); };
    $('#addrule', el).onclick = () => ruleModal(); $$('[data-redit]', el).forEach((b) => { b.onclick = () => ruleModal(rules.find((r) => r.id == b.dataset.redit)); });
  };
  await load();
};

/* --- المعرفة والأسئلة --- */
pages.knowledge = async (el) => {
  const load = async () => {
    const [kn, un] = await Promise.all([get('/knowledge'), get('/unanswered?status=open')]);
    el.innerHTML = `<h2>قاعدة المعرفة (البوت بيتعلم منها)</h2>
    <h3>❓ أسئلة العملاء اللي البوت ما عرفش يجاوبها (${un.length})</h3>
    ${un.map((u) => `<div class="card"><div class="row sp"><b>${esc(u.question)}</b><span class="muted">${esc(u.display_name || '')} · ${CH[u.channel] || ''} · ${when(u.created_at)}</span></div><div class="row" style="margin-top:8px"><textarea data-a="${u.id}" style="min-height:56px" placeholder="اكتب الإجابة مرة واحدة، والبوت هيعرفها بعد كده"></textarea></div><div class="row" style="margin-top:6px"><button class="small" data-send="${u.id}">رد على العميل وتعلّم</button><button class="ghost small" data-learn="${u.id}">تعلّم بس (بدون إرسال)</button><button class="ghost small" data-dis="${u.id}">تجاهل</button>${u.conversation_id ? `<a href="#/chats/${u.conversation_id}">المحادثة</a>` : ''}</div></div>`).join('') || '<div class="card muted">مفيش أسئلة معلّقة 👌</div>'}
    <div class="row sp" style="margin-top:20px"><h3>📚 المعلومات المحفوظة (${kn.length})</h3><button id="addk">+ معلومة</button></div>
    <div class="card tablewrap"><table><thead><tr><th>السؤال</th><th>الإجابة</th><th>الحالة</th><th></th></tr></thead><tbody>${kn.map((k) => `<tr><td>${esc(k.question)}</td><td>${esc(k.answer)}</td><td>${k.status === 'approved' ? '<span class="tag ok">معتمدة</span>' : '<span class="tag warn">تستنى موافقتك</span>'}${k.source === 'learned' ? '<span class="tag">متعلّمة</span>' : ''}<div class="muted">استُخدمت ${k.uses} مرة</div></td><td class="row">${k.status !== 'approved' ? `<button class="small" data-ok="${k.id}">اعتماد</button>` : ''}<button class="ghost small" data-kedit="${k.id}">تعديل</button><button class="danger small" data-kdel="${k.id}">✕</button></td></tr>`).join('') || '<tr><td colspan="4" class="muted">فاضية</td></tr>'}</tbody></table></div>`;
    const act = (sel, fn) => $$(sel, el).forEach((b) => { b.onclick = () => fn(b); });
    act('[data-send]', async (b) => { const a = $(`[data-a="${b.dataset.send}"]`, el).value.trim(); if (!a) return; await post(`/unanswered/${b.dataset.send}/answer`, { answer: a, send: true }); toast('اتبعت واتحفظ ✓'); load(); });
    act('[data-learn]', async (b) => { const a = $(`[data-a="${b.dataset.learn}"]`, el).value.trim(); if (!a) return; await post(`/unanswered/${b.dataset.learn}/answer`, { answer: a, send: false }); toast('اتحفظ ✓'); load(); });
    act('[data-dis]', async (b) => { await post(`/unanswered/${b.dataset.dis}/dismiss`); load(); });
    act('[data-ok]', async (b) => { await put(`/knowledge/${b.dataset.ok}`, { status: 'approved' }); load(); });
    act('[data-kdel]', async (b) => { if (confirmBox('حذف؟')) { await del(`/knowledge/${b.dataset.kdel}`); load(); } });
    const kmodal = (k = {}) => modal(k.id ? 'تعديل معلومة' : 'معلومة جديدة', `<label>السؤال / الموضوع</label><input id="k_q" value="${esc(k.question)}" placeholder="مثلًا: الضمان على الأحذية"><label>الإجابة</label><textarea id="k_a">${esc(k.answer)}</textarea>`, { onSave: async (m) => { const b = { question: $('#k_q', m.el).value, answer: $('#k_a', m.el).value, status: 'approved' }; if (!b.question || !b.answer) { toast('املأ الاتنين', true); return false; } k.id ? await put(`/knowledge/${k.id}`, b) : await post('/knowledge', { ...b, source: 'manual' }); load(); } });
    $('#addk', el).onclick = () => kmodal(); act('[data-kedit]', (b) => kmodal(kn.find((k) => k.id == b.dataset.kedit)));
  };
  await load();
};

/* --- الإعدادات / الشخصية / القنوات --- */
pages.persona = async (el) => {
  el.innerHTML = `<div class="row sp"><h2>الشخصية والتعليمات</h2><button class="ghost" id="seeprompt">شوف البرومبت الكامل اللي بيوصل للبوت</button></div><div id="form"></div>`;
  await settingsForm($('#form', el), ['persona', 'business']);
  $('#seeprompt', el).onclick = async () => { const p = await get('/prompt-preview'); modal(`البرومبت الكامل (وضع: ${p.mode})`, `<pre class="prompt">${esc(p.prompt)}</pre>`, { wide: true }); };
};
pages.behavior = async (el) => { el.innerHTML = '<div class="pagehead"><h2>سلوك البوت</h2></div><div id="form"></div>'; await settingsForm($('#form', el), ['ai', 'bot', 'hours']); };
pages.settings = async (el) => {
  el.innerHTML = '<div class="pagehead"><h2>إعدادات عامة</h2></div><div id="form"></div>';
  await settingsForm($('#form', el), ['orders', 'shipping', 'notifications']);
};
pages.account = async (el) => {
  el.innerHTML = `<div class="pagehead"><h2>حسابي</h2></div><div class="card"><div class="row sp"><div><b>${esc(ME.user.name || ME.user.email)}</b><div class="muted">${esc(ME.user.email)} · ${ME.role === 'owner' ? 'مالك' : 'موظف'}</div></div></div></div>
  <div class="card"><h3>تغيير كلمة السر</h3><div class="row"><input type="password" id="pw0" placeholder="الحالية" autocomplete="current-password" style="max-width:220px"><input type="password" id="pw1" placeholder="الجديدة (8+ حروف)" autocomplete="new-password" style="max-width:220px"><button id="chpw">تغيير</button></div></div>`;
  $('#chpw', el).onclick = async () => { await post('/auth/change-password', { current: $('#pw0', el).value, password: $('#pw1', el).value }); toast('اتغيّرت ✓'); $('#pw0', el).value = ''; $('#pw1', el).value = ''; };
};
pages.channels = async (el) => {
  const info = await get('/channels/info');
  el.innerHTML = `<div class="pagehead"><h2>القنوات</h2></div><div class="card"><h3>بيانات تحطها في Meta for Developers</h3><label>Callback URL (Webhook) الخاص بمتجرك</label><input readonly dir="ltr" value="${esc(info.webhook_url)}" onclick="this.select()">${info.base_is_public ? '' : '<div class="hint" style="color:var(--warn)">⚠️ ده رابط محلي. ميتا محتاجة رابط https عام.</div>'}<label>Verify Token</label><input readonly dir="ltr" value="${esc(info.verify_code)}" onclick="this.select()"><div class="hint">خطوات الربط بالتفصيل في صفحة "دليل الربط" (docs/SETUP.md).</div></div><div id="form"></div>
  <div class="card"><h3>اختبار الاتصال</h3><div class="row"><button class="ghost small" data-t="messenger">ماسنجر</button><button class="ghost small" data-t="instagram">إنستجرام</button><button class="ghost small" data-t="whatsapp">واتساب</button></div><div id="tres" class="hint" style="margin-top:8px"></div></div>`;
  await settingsForm($('#form', el), ['channels']);
  $$('[data-t]', el).forEach((b) => { b.onclick = async () => { const r = await post(`/channels/${b.dataset.t}/test`); $('#tres', el).innerHTML = r.ok ? `✅ شغالة: ${esc(JSON.stringify(r.info))}` : `❌ ${esc(r.error)}`; }; });
};

/* --- الاشتراك والاستهلاك --- */
pages.billing = async (el) => {
  const b = await get('/billing'); const u = b.usage; const lim = b.limits; const t = b.tenant;
  const st = { active: ['فعّال', 'ok'], expired: ['منتهي', 'bad'], suspended: ['موقوف', 'bad'] }[t.status] || [t.status, ''];
  el.innerHTML = `<div class="pagehead"><h2>الاشتراك والاستهلاك</h2></div>
  <div class="card"><div class="row sp"><div><h3 style="margin:0">باقة ${esc(t.plan.name)} <span class="tag ${st[1]}">${st[0]}</span></h3><div class="muted" style="margin-top:4px">${t.days_left !== null ? (t.days_left >= 0 ? `باقي ${t.days_left} يوم` : 'انتهت') : 'بدون تاريخ انتهاء'}${t.plan.price ? ` · ${fmt(t.plan.price)} جنيه / شهر` : ''}</div></div></div>
  ${meter('ردود البوت الذكية هذا الشهر', u.ai_replies, lim.ai_replies ?? -1)}${meter('المنتجات', ME.usage.products, lim.products ?? -1)}</div>
  ${b.open_request ? '<div class="banner" style="border-radius:12px;margin-bottom:16px">طلب الترقية اتسجّل وهنتواصل معاك لتأكيد الدفع.</div>' : ''}
  <h3>الباقات</h3><div class="grid g4">${b.plans.map((p) => `<div class="card" style="${p.slug === t.plan.slug ? 'border-color:var(--action);border-width:2px' : ''}"><h3 style="margin-top:0">${esc(p.name)}</h3><div class="stat"><b style="font-size:28px">${p.price ? fmt(p.price) : 'مجانًا'}</b><span>${p.price ? 'جنيه / شهر' : ''}</span></div><div class="hint" style="margin:8px 0">${esc(p.description)}</div>
    <div style="font-size:14px;line-height:1.9">${fmt(p.limits.ai_replies < 0 ? 0 : p.limits.ai_replies)} رد ذكي/شهر<br>${p.limits.products < 0 ? 'منتجات بلا حد' : fmt(p.limits.products) + ' منتج'}<br>${p.limits.channels} قنوات · ${p.limits.staff} موظف</div>
    ${p.slug === t.plan.slug ? '<div class="tag ok" style="margin-top:12px">باقتك الحالية</div>' : `<button class="small" style="margin-top:12px" data-up="${p.id}">اطلب الترقية</button>`}</div>`).join('')}</div>
  ${b.payment_instructions ? `<div class="card"><h3>طريقة الدفع</h3><div style="white-space:pre-wrap">${esc(b.payment_instructions)}</div></div>` : ''}
  ${b.support?.whatsapp || b.support?.email ? `<div class="hint">للدعم: ${esc(b.support.whatsapp || '')} ${esc(b.support.email || '')}</div>` : ''}
  ${b.payments.length ? `<h3>المدفوعات</h3><div class="card tablewrap"><table><tbody>${b.payments.map((p) => `<tr><td>${day(p.created_at)}</td><td>${fmt(p.amount)} ${esc(p.currency)}</td><td>${esc(p.method)}</td><td>${p.months} شهر</td></tr>`).join('')}</tbody></table></div>` : ''}`;
  $$('[data-up]', el).forEach((x) => { x.onclick = async () => { const note = prompt('ملاحظة (اختياري):') ?? ''; await post('/billing/upgrade', { plan_id: Number(x.dataset.up), note }); toast('اتسجّل طلبك ✓'); pages.billing(el); }; });
};

/* --- فريق العمل --- */
pages.team = async (el) => {
  const load = async () => {
    const users = await get('/team');
    el.innerHTML = `<div class="pagehead"><h2>فريق العمل</h2><button id="add">+ موظف</button></div><div class="hint" style="margin-bottom:12px">الموظف بيشوف الأوردرات والمحادثات ويرد على أسئلة البوت فقط، من غير الإعدادات أو الاشتراك.</div>
    <div class="card tablewrap"><table><thead><tr><th>الاسم</th><th>الإيميل</th><th>الدور</th><th>آخر دخول</th><th></th></tr></thead><tbody>${users.map((u) => `<tr><td>${esc(u.name || '—')}</td><td dir="ltr" style="text-align:start">${esc(u.email)}</td><td>${u.role === 'owner' ? 'مالك' : 'موظف'}${u.active ? '' : ' <span class="tag bad">معطّل</span>'}</td><td>${when(u.last_login)}</td><td>${u.role === 'staff' ? `<button class="ghost small" data-pw="${u.id}">كلمة سر جديدة</button> <button class="ghost small" data-tg="${u.id}" data-a="${u.active ? 0 : 1}">${u.active ? 'تعطيل' : 'تفعيل'}</button> <button class="danger small" data-rm="${u.id}">حذف</button>` : ''}</td></tr>`).join('')}</tbody></table></div>`;
    $('#add', el).onclick = () => modal('موظف جديد', `<label>الاسم</label><input id="u_n"><label>الإيميل</label><input id="u_e" type="email" dir="ltr"><label>كلمة السر (8+ حروف)</label><input id="u_p" type="text" dir="ltr"><div class="hint">سلّمها للموظف بنفسك. يقدر يغيّرها بعد الدخول.</div>`, { onSave: async (m) => { await post('/team', { name: $('#u_n', m.el).value, email: $('#u_e', m.el).value, password: $('#u_p', m.el).value }); load(); } });
    $$('[data-pw]', el).forEach((b) => { b.onclick = async () => { const p = prompt('كلمة السر الجديدة (8+ حروف):'); if (p) { await patch(`/team/${b.dataset.pw}`, { password: p }); toast('اتغيّرت ✓'); } }; });
    $$('[data-tg]', el).forEach((b) => { b.onclick = async () => { await patch(`/team/${b.dataset.tg}`, { active: b.dataset.a === '1' }); load(); }; });
    $$('[data-rm]', el).forEach((b) => { b.onclick = async () => { if (confirmBox('حذف الموظف؟')) { await del(`/team/${b.dataset.rm}`); load(); } }; });
  };
  await load();
};

/* --- حالة الخدمة --- */
pages.health = async (el) => {
  const h = await get('/health');
  const lamp = (ok) => (ok ? '<span class="tag ok">متوصلة</span>' : '<span class="tag bad">غير متوصلة</span>');
  el.innerHTML = `<div class="pagehead"><h2>حالة الخدمة</h2></div><div class="grid g4">
    <div class="card stat"><b>${h.bot_enabled && h.status === 'active' ? 'شغال' : 'متوقف'}</b><span>البوت</span></div>
    <div class="card stat"><b>${h.queue_pending}</b><span>رسائل في الطابور</span></div>
    <div class="card stat"><b>${h.failed_messages}</b><span>رسائل ما اتبعتش</span></div></div>
  <div class="card"><h3>القنوات</h3>${Object.entries(h.channels).map(([k, c]) => `<div class="row sp" style="padding:6px 0"><b>${CH[k]}</b><span>${c.enabled ? 'مفعّلة' : 'مقفولة'} · ${lamp(c.enabled && c.configured)}</span></div>`).join('')}
  <div class="hint" style="margin-top:8px">${h.webhook_signature_check ? '🔒 التحقق من توقيع ميتا شغال' : '⚠️ App Secret مش مضبوط: حطه من صفحة القنوات عشان الـ webhook يرفض أي طلب مش جاي من ميتا.'}</div></div>
  ${h.recent_errors ? `<div class="card tablewrap"><h3>آخر الأخطاء (للإدارة فقط)</h3><table><tbody>${h.recent_errors.map((l) => `<tr><td>${when(l.created_at)}</td><td>${esc(l.scope)}</td><td dir="auto">${esc(l.message)}</td></tr>`).join('') || '<tr><td class="muted">مفيش</td></tr>'}</tbody></table></div>` : ''}`;
};

/* ---------------- الإطار + التوجيه ---------------- */
let ME = null;
const NAV_OWNER = [
  ['', [['home', 'نظرة عامة'], ['orders', 'الأوردرات', 'ordersBadge'], ['chats', 'المحادثات', 'chatsBadge']]],
  ['الكتالوج', [['products', 'المنتجات'], ['categories', 'الأقسام'], ['import', 'استيراد من شيت'], ['shipping', 'الشحن']]],
  ['البوت', [['sim', 'تجربة البوت'], ['persona', 'الشخصية والتعليمات'], ['behavior', 'سلوك البوت'], ['discounts', 'الخصومات والأوضاع'], ['knowledge', 'قاعدة المعرفة', 'qBadge']]],
  ['الحساب', [['channels', 'القنوات'], ['settings', 'إعدادات عامة'], ['team', 'فريق العمل'], ['billing', 'الاشتراك'], ['health', 'حالة الخدمة']]],
];
const NAV_STAFF = [['', [['home', 'نظرة عامة'], ['orders', 'الأوردرات', 'ordersBadge'], ['chats', 'المحادثات', 'chatsBadge'], ['knowledge', 'أسئلة البوت', 'qBadge'], ['sim', 'تجربة البوت']]]];
const allowed = () => new Set((ME.role === 'owner' ? NAV_OWNER : NAV_STAFF).flatMap(([, items]) => items.map((i) => i[0])).concat(['account']));
let badges = {}; let currentPage = ''; let cleanup = null;
const main = () => $('#main');

async function refreshBadges() {
  try { const o = await get('/overview'); badges = { ordersBadge: o.new_orders, chatsBadge: o.needs_human, qBadge: o.open_questions + o.pending_knowledge }; drawNav(); } catch { /* */ }
}
function drawNav() {
  const nav = $('#nav'); if (!nav) return;
  const groups = ME.role === 'owner' ? NAV_OWNER : NAV_STAFF;
  nav.innerHTML = `<div class="brand"><span class="mark" aria-hidden="true">${esc((ME.brand || 'I')[0])}</span><span>${esc(ME.tenant.name)}</span></div>`
    + groups.map(([g, items]) => `${g ? `<div class="group">${g}</div>` : ''}${items.map(([k, l, b]) => `<a href="#/${k}" ${currentPage === k ? 'aria-current="page"' : ''}>${l}${badges[b] ? `<span class="badge">${badges[b]}</span>` : ''}</a>`).join('')}`).join('')
    + `<div class="foot"><a href="#/account" ${currentPage === 'account' ? 'aria-current="page"' : ''}>${esc(ME.user.name || ME.user.email)}</a><a href="#" id="logout">تسجيل خروج</a></div>`;
  $('#logout').onclick = async (e) => { e.preventDefault(); await post('/auth/logout'); location.hash = '#/'; renderAuth('login'); };
}
function banners() {
  const out = [];
  const t = ME.tenant;
  if (ME.impersonating) out.push(`<div class="banner admin"><span>أنت داخل كمدير للمنصة على متجر "${esc(t.name)}". كل حاجة هنا حقيقية.</span><button class="small" id="stopimp">رجوع للوحة الإدارة</button></div>`);
  if (ME.announcement) out.push(`<div class="banner ${ME.announcement.level === 'warn' ? 'warn' : ''}"><span>${esc(ME.announcement.text)}</span></div>`);
  if (t.status === 'suspended') out.push(`<div class="banner bad"><span>الحساب موقوف: البوت متوقف والتعديل مقفول. تواصل مع الدعم.</span></div>`);
  else if (t.status === 'expired') out.push(`<div class="banner bad"><span>الاشتراك انتهى: البوت متوقف ولا يرد على عملائك.</span>${ME.role === 'owner' ? '<a class="btn small" href="#/billing" style="min-height:32px">جدّد دلوقتي</a>' : ''}</div>`);
  else if (t.days_left !== null && t.days_left <= 5) out.push(`<div class="banner warn"><span>${t.plan.price ? 'اشتراكك' : 'فترتك التجريبية'} بتخلص خلال ${Math.max(t.days_left, 0)} يوم.</span>${ME.role === 'owner' ? '<a class="btn small" href="#/billing" style="min-height:32px">الباقات</a>' : ''}</div>`);
  const q = ME.limits.ai_replies;
  if (t.status === 'active' && q >= 0 && ME.usage.ai_replies >= q) out.push(`<div class="banner bad"><span>خلصت حصة الردود الذكية لهذا الشهر: البوت بيحوّلك المحادثات الجديدة.</span>${ME.role === 'owner' ? '<a class="btn small" href="#/billing" style="min-height:32px">رقّي الباقة</a>' : ''}</div>`);
  else if (t.status === 'active' && q >= 0 && ME.usage.ai_replies >= q * 0.85) out.push(`<div class="banner warn"><span>استهلكت ${Math.round((ME.usage.ai_replies / q) * 100)}% من ردود الشهر.</span></div>`);
  return out.join('');
}
async function route() {
  const [, page = 'home', arg] = location.hash.split('/');
  const ok = allowed();
  if (!pages[page] || !ok.has(page)) return (location.hash = '#/home');
  cleanup?.(); cleanup = null; currentPage = page; drawNav();
  const el = main(); el.innerHTML = '<div class="muted">جاري التحميل...</div>';
  try { await pages[page](el, arg); } catch (e) { if (!$('.auth')) el.innerHTML = `<div class="card">حصل خطأ: ${esc(e.message)}</div>`; }
}
let es;
function startEvents() {
  es?.close(); es = new EventSource('/api/events');
  es.onmessage = (m) => {
    const ev = JSON.parse(m.data);
    if (ev.type === 'order') { toast(`🛒 أوردر جديد ${ev.data.number}`); beep(); window.onOrderEvent?.(); refreshBadges(); }
    else if (ev.type === 'order_updated') window.onOrderEvent?.();
    else if (ev.type === 'alert') { toast(`🔔 عميل محتاج تدخلك: ${String(ev.data.question || '').slice(0, 60)}`); beep(); refreshBadges(); }
    else if (ev.type === 'message' || ev.type === 'message_status' || ev.type === 'conversation') { window.onMsgEvent?.(ev); if (ev.type === 'message') refreshBadges(); }
  };
}

async function renderShell() {
  ME = await get('/me');
  $('#app').innerHTML = `<a class="skip-link" href="#main">تخطي للمحتوى</a><div id="banners">${banners()}</div><div class="layout"><nav class="side" id="nav" aria-label="القائمة الرئيسية"></nav><main id="main" tabindex="-1"></main></div>`;
  $('#stopimp')?.addEventListener('click', async () => { const r = await post('/auth/stop-impersonating'); location.href = r.home; });
  startEvents(); refreshBadges(); route();
}

function renderAuth(mode = 'login') {
  es?.close();
  const signup = mode === 'signup';
  $('#app').innerHTML = `<div class="auth"><div class="side-art"><div class="row"><span class="mark" style="background:var(--p-inv-ink);color:var(--p-inv-bg)">I</span><b>Instinct Messenger</b></div>
    <div><h1>بوت بيرد على عملائك ويقفل الأوردر</h1><p style="margin-top:16px">ماسنجر وإنستجرام وواتساب في مكان واحد. منتجاتك من الشيت، وردوده بلهجتك، وأوردراتك قدامك لحظيًا.</p></div><div class="muted" style="color:var(--p-inv-ink);opacity:.7;font-size:14px">تجربة مجانية 14 يوم، من غير كارت.</div></div>
    <div class="form"><form id="f" novalidate><h2>${signup ? 'ابدأ تجربتك المجانية' : 'سجّل دخولك'}</h2><p class="muted" style="margin:0 0 8px">${signup ? 'دقيقة واحدة وبوتك يبقى جاهز للتجربة.' : 'ادخل بإيميلك وكلمة السر.'}</p>
    ${signup ? '<label for="bn">اسم المتجر</label><input id="bn" autocomplete="organization">' : ''}
    <label for="em">الإيميل</label><input id="em" type="email" dir="ltr" autocomplete="email" autofocus>
    <label for="pw">كلمة السر</label><input id="pw" type="password" autocomplete="${signup ? 'new-password' : 'current-password'}" placeholder="${signup ? '8 حروف على الأقل' : ''}">
    <p class="form__status" id="err" role="alert" style="color:var(--bad);min-height:22px;margin:8px 0 0;font-size:14px"></p>
    <button class="primary" id="go" type="submit">${signup ? 'إنشاء الحساب' : 'دخول'}</button>
    <p class="alt">${signup ? 'عندك حساب؟ <a href="#/login">سجّل دخولك</a>' : 'متجر جديد؟ <a href="#/signup">ابدأ تجربة مجانية</a>'}</p></form></div></div>`;
  $('#f').onsubmit = async (e) => {
    e.preventDefault(); $('#err').textContent = ''; $('#go').disabled = true;
    try {
      const body = { email: $('#em').value, password: $('#pw').value };
      if (signup) body.businessName = $('#bn').value;
      const r = await post(signup ? '/auth/signup' : '/auth/login', body);
      if (r.home && !r.home.startsWith('/app')) { location.href = r.home; return; }
      location.hash = '#/home'; renderShell();
    } catch (err) { $('#err').textContent = err.message; } finally { $('#go').disabled = false; }
  };
}

window.addEventListener('hashchange', () => {
  if ($('#main')) return route();
  if ($('.auth')) renderAuth(location.hash.includes('signup') ? 'signup' : 'login');
});
setUnauthorizedHandler(() => renderAuth('login'));
(async () => {
  const s = await fetch('/api/auth/status').then((r) => r.json());
  if (!s.authed) return renderAuth(location.hash.includes('signup') ? 'signup' : 'login');
  if (s.role === 'superadmin') { location.href = '/admin/'; return; }
  renderShell();
})();
