import { q, getSetting } from '../db.js';
import { searchProducts, getProduct, publicProduct } from '../catalog.js';
import { cartAdd, cartUpdate, cartClear, viewCart, saveCustomerFields, orderSummary, createOrder, computeTotals } from '../cart.js';
import { quote, listRates } from '../shipping.js';
import { amountFor, findCoupon } from '../discounts.js';
import { getConversation, saveConversation } from '../conversations.js';
import { searchKnowledge, markUsed } from '../knowledge.js';
import { loadImageBase64, absoluteUrl, normalizeImageUrl } from '../images.js';
import { getOrder } from '../orders.js';
import { enqueue } from '../queue.js';
import { emit } from '../events.js';
import { now, normalizeAr } from '../util.js';
import { hydrateAll } from '../db.js';

const obj = (properties, required = []) => ({ type: 'object', properties, required });

export function toolDefinitions(mode) {
  const defs = [
    { name: 'search_products', description: 'Search the store catalog by keywords (name, type, color, ...). Returns matching products with real price and stock. Call it whenever the customer asks about a product or category.',
      input_schema: obj({ query: { type: 'string', description: 'search words in the customer language' }, category: { type: 'string' }, max_price: { type: 'number' }, min_price: { type: 'number' }, in_stock_only: { type: 'boolean' } }) },
    { name: 'get_product', description: 'Get full details of one product (attributes, options, notes).', input_schema: obj({ product_id: { type: 'integer' } }, ['product_id']) },
    { name: 'view_product_images', description: 'Look at the photos of up to 4 products yourself (to compare with a photo the customer sent). Does not send anything to the customer.', input_schema: obj({ product_ids: { type: 'array', items: { type: 'integer' } } }, ['product_ids']) },
    { name: 'shipping_quote', description: 'Shipping fee and delivery time for a governorate.', input_schema: obj({ governorate: { type: 'string' } }, ['governorate']) },
    { name: 'search_knowledge', description: 'Search the store owner\'s approved Q&A/policies knowledge base.', input_schema: obj({ query: { type: 'string' } }, ['query']) },
    { name: 'ask_human', description: 'Escalate to the store team: use when you do not know the answer, for complaints/refunds/payment proofs, or when the customer wants a human. The question is saved for the owner who will answer it (and the bot learns from the answer).',
      input_schema: obj({ question: { type: 'string', description: 'The customer\'s question or issue, self-contained' }, reason: { type: 'string', description: 'unknown_answer | complaint | refund | payment_proof | human_requested | other' }, pause_bot: { type: 'boolean', description: 'true to stop the bot replying until a human takes over' } }, ['question']) },
    { name: 'lookup_order', description: 'Find the status of this customer\'s orders (by order number, or the latest ones of this chat).', input_schema: obj({ order_number: { type: 'string' } }) },
  ];
  if (mode.send_images) defs.push({ name: 'send_product_images', description: 'Send the product photos to the customer in the chat.', input_schema: obj({ product_id: { type: 'integer' }, count: { type: 'integer', description: 'how many photos, default 1, max 3' } }, ['product_id']) });
  if (mode.take_orders) {
    defs.push(
      { name: 'cart_add', description: 'Add a product to the cart. Include the options the customer chose (e.g. {"المقاس":"42","اللون":"أسود"}). If options are missing the tool tells you what to ask.', input_schema: obj({ product_id: { type: 'integer' }, quantity: { type: 'integer' }, options: { type: 'object', additionalProperties: { type: 'string' } } }, ['product_id']) },
      { name: 'cart_update', description: 'Change quantity of a cart line (quantity 0 removes it).', input_schema: obj({ line_id: { type: 'integer' }, quantity: { type: 'integer' } }, ['line_id', 'quantity']) },
      { name: 'cart_view', description: 'Show the cart with totals.', input_schema: obj({}) },
      { name: 'cart_clear', description: 'Empty the cart.', input_schema: obj({}) },
      { name: 'save_customer_details', description: 'Save delivery/customer details the customer gave you (only the keys you actually received). Keys come from the store config (name, phone, governorate, address, ...).', input_schema: obj({ fields: { type: 'object', additionalProperties: { type: 'string' } } }, ['fields']) },
      { name: 'order_summary', description: 'Build the final order summary to show the customer. Must be called (and shown) before confirm_order, and again after any change.', input_schema: obj({}) },
      { name: 'confirm_order', description: 'Create the order. ONLY after order_summary was shown and the customer\'s latest message clearly confirms.', input_schema: obj({ customer_confirmed: { type: 'boolean' }, notes: { type: 'string', description: 'customer notes for the order' }, payment_method: { type: 'string' } }, ['customer_confirmed']) },
    );
  }
  const hasDiscounts = q.get(`SELECT COUNT(*) AS n FROM discount_rules WHERE active=1 AND trigger IN ('retention','coupon')`).n > 0;
  if (hasDiscounts && mode.take_orders) {
    defs.push(
      { name: 'check_discounts', description: 'See which discount (if any) you are currently allowed to offer. Call it when the customer hesitates, says it is expensive, or says they will leave/think about it.', input_schema: obj({}) },
      { name: 'apply_discount', description: 'Apply a discount rule from check_discounts (rule_id), or a coupon code the customer gave you.', input_schema: obj({ rule_id: { type: 'integer' }, coupon_code: { type: 'string' } }) },
    );
  }
  return defs;
}

/* ---------------- المنفّذ ---------------- */
export async function executeTool(name, input, ctx) {
  const { convId, mode } = ctx;
  input = input || {};
  switch (name) {
    case 'search_products': {
      const res = searchProducts({ ...input, limit: 8 });
      if (!res.length) return { results: [], note: 'No matching products. Try other words or ask the customer; if nothing fits, say it is not available and call ask_human if unsure.' };
      return { results: res.map(publicProduct) };
    }
    case 'get_product': {
      const p = getProduct(Number(input.product_id));
      return p && p.active ? publicProduct(p) : { error: 'product not found' };
    }
    case 'view_product_images': {
      const blocks = [];
      for (const id of (input.product_ids || []).slice(0, 4)) {
        const p = getProduct(Number(id));
        const first = p?.images?.[0];
        if (!first) { blocks.push({ type: 'text', text: `Product ${id}: no image.` }); continue; }
        const img = await loadImageBase64(first);
        blocks.push({ type: 'text', text: `Product ${p.id} - ${p.name}:` });
        if (img) blocks.push({ type: 'image', source: { type: 'base64', media_type: img.media_type, data: img.data } });
        else blocks.push({ type: 'text', text: '(image could not be loaded)' });
      }
      return { __content: blocks.length ? blocks : [{ type: 'text', text: 'no products given' }] };
    }
    case 'send_product_images': {
      const p = getProduct(Number(input.product_id));
      if (!p || !p.images?.length) return { error: 'This product has no photos.' };
      const sent = new Set(ctx.conv.state?.sent_images || []);
      const n = Math.min(3, Math.max(1, Number(input.count) || 1));
      const picks = p.images.slice(0, n).map(normalizeImageUrl);
      const fresh = picks.filter((u) => !sent.has(`${p.id}|${u}`));
      if (!fresh.length) return { ok: true, note: 'Photos of this product were already sent in this chat.' };
      try { if (ctx.channel !== 'simulator') fresh.forEach(absoluteUrl); } catch (e) { return { error: e.message }; }
      for (const u of fresh) ctx.outbox.push({ url: u, caption: fresh.indexOf(u) === 0 ? p.name : '' });
      const conv = getConversation(convId);
      saveConversation(convId, { state: { ...conv.state, sent_images: [...(conv.state.sent_images || []), ...fresh.map((u) => `${p.id}|${u}`)] } });
      return { ok: true, queued: fresh.length };
    }
    case 'shipping_quote': {
      const r = quote(input.governorate);
      if (!r?.known) return { known: false, message: 'Governorate not recognized.', valid: listRates().filter((x) => x.active).map((x) => x.governorate) };
      const freeOver = Number(getSetting('shipping.free_over', 0));
      return { governorate: r.governorate, shipping_fee: r.price, delivery_time: r.eta || undefined, free_shipping_over: freeOver > 0 ? freeOver : undefined };
    }
    case 'search_knowledge': {
      const hits = searchKnowledge(input.query || '');
      markUsed(hits.map((h) => h.id));
      return hits.length ? { results: hits.map((h) => ({ question: h.question, answer: h.answer })) } : { results: [], note: 'Nothing found. If you still do not know, call ask_human.' };
    }
    case 'ask_human': {
      const conv = getConversation(convId);
      const question = String(input.question || '').trim() || '(no text)';
      const dup = q.get(`SELECT id FROM unanswered WHERE conversation_id=? AND status='open' AND question=?`, convId, question);
      if (!dup) q.run('INSERT INTO unanswered(conversation_id, question, reason, created_at) VALUES(?,?,?,?)', convId, question, String(input.reason || 'unknown_answer'), now());
      const pause = Boolean(input.pause_bot);
      saveConversation(convId, { needs_human: 1, needs_human_reason: String(input.reason || 'unknown_answer'), ...(pause ? { bot_paused: 1 } : {}) });
      emit('alert', { conversation_id: convId, question, reason: input.reason });
      enqueue({ kind: 'alert_owner', payload: { text: `🔔 محتاج رد منك (${conv.display_name || conv.external_id} / ${conv.channel})\n${question}` } });
      return { ok: true, instruction: pause ? 'The chat is handed to a human. Tell the customer politely that a team member will follow up shortly.' : 'Tell the customer politely that you are confirming with the team and will get back to them soon. Do not guess the answer.' };
    }
    case 'lookup_order': {
      const conv = getConversation(convId);
      let rows;
      if (input.order_number) rows = q.all('SELECT * FROM orders WHERE number=? AND (conversation_id=? OR (phone<>\'\' AND phone=?))', String(input.order_number).trim(), convId, conv.customer?.phone || '');
      else rows = q.all('SELECT * FROM orders WHERE conversation_id=? OR (phone<>\'\' AND phone=?) ORDER BY id DESC LIMIT 3', convId, conv.customer?.phone || '');
      rows = hydrateAll('orders', rows);
      return rows.length ? { orders: rows.map((o) => ({ number: o.number, status: o.status, total: o.total, items: o.items.map((i) => `${i.qty}x ${i.name}`), created: new Date(o.created_at).toISOString() })) } : { orders: [], note: 'No orders found for this customer.' };
    }
    case 'cart_add': return cartAdd(convId, input);
    case 'cart_update': return cartUpdate(convId, input);
    case 'cart_view': return viewCart(convId);
    case 'cart_clear': return cartClear(convId);
    case 'save_customer_details': return saveCustomerFields(convId, input.fields || {});
    case 'order_summary': return orderSummary(convId);
    case 'confirm_order': {
      if (!mode.take_orders) return { error: 'Orders are disabled right now.' };
      if (getSetting('orders.require_confirmation', true) && input.customer_confirmed !== true) return { error: 'Need explicit customer confirmation first.' };
      return createOrder(convId, { notes: input.notes, payment_method: input.payment_method });
    }
    case 'check_discounts': {
      const conv = getConversation(convId);
      const cart = viewCart(convId);
      if (!cart.items.length) return { available: [], note: 'No items in cart, no discount can be offered.' };
      const out = [];
      if (mode.allow_retention_discount && !conv.state?.retention_offered) {
        for (const r of q.all(`SELECT * FROM discount_rules WHERE active=1 AND trigger='retention'`)) {
          if (cart.subtotal >= (r.min_order || 0)) out.push({ rule_id: r.id, name: r.name, saves: Math.round(amountFor(r, cart.subtotal)), when_to_offer: r.instructions || undefined });
        }
      }
      return { available: out, note: out.length ? 'Offer at most one, only if the customer is hesitating. Never mention a discount you are not allowed to give.' : 'No discount available now. Do not offer or imply any.' };
    }
    case 'apply_discount': {
      const conv = getConversation(convId);
      const cart = viewCart(convId);
      if (!cart.items.length) return { error: 'Cart is empty.' };
      let rule = null; let source = '';
      if (input.coupon_code) {
        rule = findCoupon(input.coupon_code); source = 'coupon';
        if (!rule) return { error: 'Coupon code is not valid.' };
      } else if (input.rule_id) {
        rule = q.get(`SELECT * FROM discount_rules WHERE id=? AND active=1`, Number(input.rule_id)); source = 'retention';
        if (!rule || rule.trigger !== 'retention') return { error: 'This discount cannot be applied by the bot.' };
        if (!mode.allow_retention_discount) return { error: 'Discounts are not allowed in the current sales mode.' };
        if (conv.state?.retention_offered) return { error: 'A retention discount was already offered in this chat.' };
      } else return { error: 'Provide rule_id or coupon_code.' };
      if (cart.subtotal < (rule.min_order || 0)) return { error: `Minimum order for this discount is ${rule.min_order}.` };
      saveConversation(convId, { discount: { id: rule.id, name: rule.name, type: rule.type, value: rule.value, max_discount: rule.max_discount, source }, state: { ...conv.state, ...(source === 'retention' ? { retention_offered: true } : {}) } });
      const after = computeTotals(getConversation(convId));
      return { ok: true, discount_name: rule.name, discount_amount: after.discount_amount, new_subtotal_after_discount: after.subtotal - after.discount_amount, cart: viewCart(convId) };
    }
    default: return { error: `unknown tool ${name}` };
  }
}
