import { getPlatformSettings, hasFeature } from './platform.js';
import { clone, isPlainObject } from './util.js';

/**
 * اللي العميل (صاحب المتجر/الموظف) ما ينفعش يشوفه أو يعدّله: تفاصيل الذكاء الاصطناعي (المفتاح، الموديل،
 * الحدود)، وإعدادات الأداء الداخلية. السوبر أدمن (وهو داخل كعميل) بيشوف كل حاجة.
 * الفلترة بتتم في السيرفر، مش في الواجهة بس.
 */
export function hiddenPaths(info) {
  const paths = ['ai.understand_images', 'bot.max_tool_rounds', 'bot.max_attempts', 'bot.history_limit', 'bot.debounce_ms', 'channels.graph_version'];
  if (hasFeature(info, 'byok')) paths.push('ai.provider', 'ai.model', 'ai.max_tokens', 'ai.timeout_ms');
  else paths.push('ai');
  if (getPlatformSettings().public_url) paths.push('channels.public_base_url'); // المنصة بتحدده
  return paths;
}
function del(o, p) {
  const ks = p.split('.'); let c = o;
  for (const k of ks.slice(0, -1)) { if (!isPlainObject(c?.[k])) return; c = c[k]; }
  delete c[ks.at(-1)];
}
export function redactSettings(settings, info, isAdmin) {
  const out = clone(settings);
  if (isAdmin) return out;
  for (const p of hiddenPaths(info)) del(out, p);
  return out;
}
export function stripHiddenPatch(patch, info, isAdmin) {
  const out = clone(patch);
  if (isAdmin) return out;
  for (const p of hiddenPaths(info)) del(out, p);
  return out;
}

const STEP_LABELS = {
  search_products: 'بحث في المنتجات', get_product: 'تفاصيل منتج', view_product_images: 'مقارنة الصور', send_product_images: 'إرسال صور',
  shipping_quote: 'حساب الشحن', search_knowledge: 'بحث في قاعدة المعرفة', ask_human: 'تحويل لك', lookup_order: 'استعلام عن أوردر',
  cart_add: 'إضافة للسلة', cart_update: 'تعديل السلة', cart_view: 'عرض السلة', cart_clear: 'تفريغ السلة', save_customer_details: 'حفظ بيانات العميل',
  order_summary: 'ملخص الأوردر', confirm_order: 'تسجيل الأوردر', check_discounts: 'فحص الخصومات', apply_discount: 'تطبيق خصم',
};
/** رسالة للعميل: بدون أسماء الأدوات ولا مدخلاتها ولا مخرجاتها، بس خطوات بسيطة بالعربي */
export function publicMessage(m, isAdmin) {
  if (isAdmin || !m.meta) return m;
  const steps = (m.meta.trace || []).map((t) => STEP_LABELS[t.tool] || 'خطوة');
  return { ...m, meta: steps.length ? { steps } : {} };
}
