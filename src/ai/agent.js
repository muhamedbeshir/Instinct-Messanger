import { q, getSetting, getSettings, hydrateAll } from '../db.js';
import { getConversation, saveConversation, botIsPausedFor, listMessages } from '../conversations.js';
import { buildSystem } from './prompt.js';
import { toolDefinitions, executeTool } from './tools.js';
import { runAnthropic, apiKey } from './anthropic.js';
import { runMock } from './mock.js';
import { deliver, typing } from '../channels/index.js';
import { markUsed } from '../knowledge.js';
import { loadImageBase64 } from '../images.js';
import { normalizeAr, now, withTimeout } from '../util.js';
import { emit } from '../events.js';
import { enqueue } from '../queue.js';
import * as logger from '../logger.js';

export function providerName() {
  const p = getSetting('ai.provider', 'auto');
  if (p === 'mock') return 'mock';
  if (p === 'anthropic') return 'anthropic';
  return apiKey() ? 'anthropic' : 'mock';
}

function inWorkingHours() {
  const wh = getSetting('working_hours');
  if (!wh?.enabled) return true;
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: wh.timezone || 'Africa/Cairo', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date()).split(':').map(Number);
  const cur = parts[0] * 60 + parts[1];
  const [sh, sm] = wh.start.split(':').map(Number); const [eh, em] = wh.end.split(':').map(Number);
  const s = sh * 60 + sm; const e = eh * 60 + em;
  return s <= e ? cur >= s && cur < e : cur >= s || cur < e;
}

async function buildMessages(conv, pending) {
  const limit = getSetting('bot.history_limit', 30);
  const history = listMessages(conv.id, { limit });
  const pendingIds = new Set(pending.map((m) => m.id));
  const out = [];
  const push = (role, content) => {
    const last = out[out.length - 1];
    if (last && last.role === role) {
      if (typeof last.content === 'string' && typeof content === 'string') last.content += `\n${content}`;
      else { const a = Array.isArray(last.content) ? last.content : [{ type: 'text', text: last.content }]; const b = Array.isArray(content) ? content : [{ type: 'text', text: content }]; last.content = [...a, ...b]; }
    } else out.push({ role, content });
  };
  for (const m of history) {
    if (m.direction === 'in') {
      const blocks = [];
      const hasImg = (m.attachments || []).some((a) => a.type === 'image');
      if (hasImg && pendingIds.has(m.id) && getSetting('ai.understand_images', true) && providerName() === 'anthropic') {
        for (const a of m.attachments.filter((x) => x.type === 'image')) {
          const img = a.local ? await loadImageBase64({ local: a.local }) : (a.url ? await loadImageBase64(a.url) : null);
          if (img) blocks.push({ type: 'image', source: { type: 'base64', media_type: img.media_type, data: img.data } });
        }
      } else if (hasImg && providerName() === 'mock' && pendingIds.has(m.id)) {
        blocks.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: '' } });
      }
      const text = m.text || (hasImg ? '[العميل بعت صورة]' : '');
      if (blocks.length) push('user', [...blocks, { type: 'text', text: text || '[صورة]' }]);
      else push('user', text || '[رسالة فاضية]');
    } else if (m.text || m.attachments?.length) {
      const label = m.sender === 'human' ? '[رد من موظف المتجر] ' : '';
      push('assistant', `${label}${m.text || '[أرسل صورة المنتج]'}`);
    }
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

export async function respond(convId) {
  let conv = getConversation(convId);
  if (!conv) return;
  if (!getSetting('bot.enabled', true) || botIsPausedFor(conv)) return;

  const repliedUpto = conv.state?.replied_upto || 0;
  const pending = hydrateAll('messages', q.all(`SELECT * FROM messages WHERE conversation_id=? AND direction='in' AND id>? ORDER BY id`, convId, repliedUpto));
  if (!pending.length) return;
  const maxId = pending[pending.length - 1].id;
  const text = pending.map((m) => m.text).filter(Boolean).join('\n');
  const markDone = () => { const c = getConversation(convId); saveConversation(convId, { state: { ...c.state, replied_upto: Math.max(maxId, c.state?.replied_upto || 0) } }); };

  // تحويل لإنسان بكلمات مفتاحية (قبل ما نستهلك AI)
  const handoff = getSettings().handoff;
  const norm = normalizeAr(text);
  if (handoff.keywords.some((k) => k && norm.includes(normalizeAr(k)))) {
    q.run('INSERT INTO unanswered(conversation_id, question, reason, created_at) VALUES(?,?,?,?)', convId, text.slice(0, 500), 'human_requested', now());
    saveConversation(convId, { needs_human: 1, needs_human_reason: 'human_requested', ...(handoff.pause_bot ? { bot_paused: 1 } : {}) });
    markDone();
    emit('alert', { conversation_id: convId, question: text, reason: 'human_requested' });
    enqueue({ kind: 'alert_owner', payload: { text: `🔔 عميل طلب موظف (${conv.display_name || conv.external_id} / ${conv.channel})\n${text.slice(0, 300)}` } });
    await deliver(convId, { text: handoff.message });
    return;
  }

  // مواعيد العمل
  if (!inWorkingHours()) {
    const wh = getSettings().working_hours;
    const last = conv.state?.offhours_at || 0;
    if (now() - last > 6 * 3600 * 1000) {
      saveConversation(convId, { state: { ...conv.state, offhours_at: now() } });
      await deliver(convId, { text: wh.off_hours_message });
    }
    if (!wh.bot_replies_off_hours) { markDone(); return; }
  }

  typing(convId).catch(() => {});
  const { stable, dynamic, knowledgeIds, mode } = buildSystem(conv, text);
  const messages = await buildMessages(conv, pending);
  if (!messages.length) { markDone(); return; }
  const tools = toolDefinitions(mode);
  const ctx = { convId, channel: conv.channel, mode, outbox: [], conv };
  const trace = [];
  const exec = async (name, input) => {
    ctx.conv = getConversation(convId);
    const started = Date.now();
    let out;
    try { out = await executeTool(name, input, ctx); } catch (e) { out = { error: e.message }; logger.error('tool', `${name}: ${e.message}`); }
    trace.push({ tool: name, input, output: out?.__content ? '[images]' : out, ms: Date.now() - started });
    return out;
  };

  const provider = providerName();
  const run = provider === 'anthropic'
    ? runAnthropic({ system: { stable, dynamic }, messages, tools, executeTool: exec, maxRounds: getSetting('bot.max_tool_rounds', 8) })
    : runMock({ messages, executeTool: exec, ctx });
  const result = await withTimeout(run, getSetting('ai.timeout_ms', 45000) * 3, 'AI reply');

  // لو الموظف أو الإعدادات وقفوا البوت أثناء التفكير، منبعتش
  conv = getConversation(convId);
  if (botIsPausedFor(conv)) { markDone(); return; }

  if (!result.text && !ctx.outbox.length) throw new Error('AI returned an empty reply');
  markUsed(knowledgeIds);
  await deliver(convId, { text: result.text, images: ctx.outbox, meta: { trace, provider, usage: result.usage } });
  markDone();

  // لو العميل كتب حاجة تانية وإحنا بنرد، نكمّل
  const more = q.get(`SELECT COUNT(*) AS n FROM messages WHERE conversation_id=? AND direction='in' AND id>?`, convId, maxId).n;
  if (more) enqueue({ kind: 'reply', conversationId: convId, delayMs: 300 });
}

/** لو الرد فشل كل المحاولات: اعتذار + تحويل لإنسان */
export async function replyFailed(payload, job, err) {
  const convId = job.conversation_id;
  const conv = getConversation(convId);
  if (!conv) return;
  saveConversation(convId, { needs_human: 1, needs_human_reason: 'bot_error' });
  emit('alert', { conversation_id: convId, question: 'البوت فشل في الرد', reason: 'bot_error' });
  enqueue({ kind: 'alert_owner', payload: { text: `⚠️ البوت فشل يرد على ${conv.display_name || conv.external_id} (${conv.channel}): ${err.message}` } });
  await deliver(convId, { text: getSetting('bot.fallback_message') });
  const c = getConversation(convId);
  const last = q.get(`SELECT MAX(id) AS id FROM messages WHERE conversation_id=? AND direction='in'`, convId).id || 0;
  saveConversation(convId, { state: { ...c.state, replied_upto: last } });
}
