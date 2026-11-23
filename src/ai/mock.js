import { getConversation, saveConversation } from '../conversations.js';
import { missingCustomerFields } from '../cart.js';
import { normalizeAr, toLatinDigits, money } from '../util.js';
import { getSetting } from '../db.js';

/**
 * بوت تجريبي بدون ذكاء اصطناعي (قواعد بسيطة) عشان تجرب الدنيا كلها محليًا من غير مفتاح Claude.
 * مش للاستخدام الفعلي مع العملاء: ضيف مفتاح Claude من الإعدادات.
 */
const YES = /(^| )(ايوه|ايوا|اه|تمام|اكد|موافق|اوكي|ok|yes|ماشي|اكيد)( |$)/;
const NO = /(^| )(لا|لأ|مش|الغي|no|cancel)( |$)/;
const ORDER = /(اطلب|هاخد|اخد|اشتري|اشتريه|ضيف|ابغي|اريد|order|buy|عايزه|عاوزه|هاخدها|هاخده)/;
const PHOTO = /(صور|صوره|ابعت|شكل|photo|pic)/;
const HESITATE = /(غالي|هفكر|خصم|اغلي|مش عارف|هشوف|expensive)/;
const GREET = /^(سلام|السلام|اهلا|مرحبا|هاي|صباح|مساء|hello|hi|hey|ازيك|ازاي)/;

export async function runMock({ messages, executeTool, ctx }) {
  const lastMsg = [...messages].reverse().find((m) => m.role === 'user');
  const raw = (Array.isArray(lastMsg.content) ? lastMsg.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ') : lastMsg.content) || '';
  const hasImage = Array.isArray(lastMsg.content) && lastMsg.content.some((b) => b.type === 'image');
  const t = normalizeAr(raw);
  const get = () => getConversation(ctx.convId);
  const m = { ...(get().state.mock || {}) };
  const done = (text) => { saveConversation(ctx.convId, { state: { ...get().state, mock: m } }); return { text, usage: { input: 0, output: 0 } }; };
  const askNext = async () => {
    const missing = missingCustomerFields(get());
    if (!missing.length) {
      const s = await executeTool('order_summary', {});
      m.stage = 'confirm'; m.expect = null;
      const lines = s.items.map((i) => `- ${i.qty}× ${i.name}${Object.keys(i.options).length ? ` (${Object.values(i.options).join('، ')})` : ''}: ${money(i.line_total)}`).join('\n');
      return done(`ملخص طلبك:\n${lines}\nالمجموع: ${money(s.subtotal)}${s.discount ? `\nالخصم: -${money(s.discount.amount)}` : ''}\nالشحن: ${money(s.shipping)}\nالإجمالي: ${money(s.total)}\nالدفع: ${s.payment_methods[0] || ''}\nأأكد الأوردر؟`);
    }
    m.stage = 'collect'; m.expect = missing[0].key;
    return done(`تمام ✅ ${missing[0].label}؟${missing[0].hint ? ` (${missing[0].hint})` : ""}`);
  };

  if (m.stage === 'confirm') {
    if (YES.test(t)) {
      const r = await executeTool('confirm_order', { customer_confirmed: true });
      m.stage = null;
      return done(r.ok ? `تم تسجيل طلبك ✅ رقم الأوردر ${r.order_number}. شكرًا ليك 🌷` : `معلش في مشكلة: ${r.error}`);
    }
    if (NO.test(t)) { m.stage = null; return done('تمام، قولي تحب نعدل إيه؟'); }
  }
  if (m.stage === 'option' && m.pending) {
    m.pending.options[m.pending.field] = raw.trim();
    const r = await executeTool('cart_add', m.pending);
    if (r.error) {
      const miss = r.missing_options?.[0] || r.invalid_options?.[0];
      if (miss) { m.pending.field = miss.field; return done(`اختار ${miss.field}${miss.available_values ? ` (${miss.available_values.join(' / ')})` : ''}؟`); }
      m.stage = null; return done(r.error);
    }
    m.pending = null; return askNext();
  }
  if (m.stage === 'collect' && m.expect) {
    const r = await executeTool('save_customer_details', { fields: { [m.expect]: m.expect === 'phone' ? (toLatinDigits(raw).match(/[\d+][\d\s-]{8,}/)?.[0] || raw) : raw.trim() } });
    if (r.errors?.length) return done(r.errors[0].error);
    return askNext();
  }

  if (hasImage) {
    const q = await executeTool('search_products', { query: '' });
    m.last_product = q.results?.[0]?.id;
    return done(q.results?.length ? `شفت الصورة 👀 أقرب حاجة عندنا: ${q.results[0].name} بسعر ${money(q.results[0].price)}` : 'استلمت الصورة، هراجع الفريق وأرد عليك.');
  }
  if (HESITATE.test(t)) {
    const d = await executeTool('check_discounts', {});
    if (d.available?.length) {
      const a = await executeTool('apply_discount', { rule_id: d.available[0].rule_id });
      if (a.ok) return done(`عشان خاطرك هديلك ${a.discount_name} 🎁 الخصم ${money(a.discount_amount)} جنيه.`);
    }
    return done('فاهم حضرتك، سعرنا مناسب للجودة. تحب أرشحلك بديل أرخص؟');
  }
  if (ORDER.test(t) && m.last_product) {
    m.pending = { product_id: m.last_product, quantity: 1, options: {} };
    const r = await executeTool('cart_add', m.pending);
    if (r.error) {
      const miss = r.missing_options?.[0] || r.invalid_options?.[0];
      if (miss) { m.stage = 'option'; m.pending.field = miss.field; return done(`تمام! اختار ${miss.field}${miss.available_values ? ` (${miss.available_values.join(' / ')})` : ''}؟`); }
      return done(r.error);
    }
    return askNext();
  }
  if (PHOTO.test(t) && m.last_product) {
    const r = await executeTool('send_product_images', { product_id: m.last_product, count: 2 });
    return done(r.ok ? 'دي صور المنتج 📸 تحب أطلبه لحضرتك؟' : (r.error || 'مفيش صور متاحة للمنتج ده.'));
  }
  if (GREET.test(t) && t.split(' ').length <= 3) return done(`أهلاً بحضرتك في ${getSetting('business.name')} 🌷 اتفضل أقدر أساعدك إزاي؟`);
  const found = await executeTool('search_products', { query: raw });
  if (found.results?.length) {
    m.last_product = found.results[0].id;
    const top = found.results.slice(0, 3).map((p) => `- ${p.name}: ${money(p.price)} جنيه${p.in_stock ? '' : ' (غير متاح)'}`).join('\n');
    return done(`ده المتاح:\n${top}\nتحب أطلب لك واحد منهم؟ ولو عايز صور قولي.`);
  }
  await executeTool('ask_human', { question: raw, reason: 'unknown_answer' });
  return done('ثواني أتأكدلك من الفريق وأرد عليك 🙏');
}
