import './helpers.js';
import { CSV } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

/** سيرفر Anthropic مزيّف: بيتأكد إن شكل الطلب صح (أدوات، tool_result، صور، كاش) من غير مفتاح حقيقي */
const requests = [];
const fake = http.createServer((req, res) => {
  let body = ''; req.on('data', (d) => { body += d; });
  req.on('end', () => {
    const r = JSON.parse(body); requests.push(r);
    const lastUser = r.messages.at(-1);
    const hasToolResult = Array.isArray(lastUser.content) && lastUser.content.some((b) => b.type === 'tool_result');
    const out = hasToolResult
      ? { id: 'm2', type: 'message', role: 'assistant', model: r.model, stop_reason: 'end_turn', content: [{ type: 'text', text: '**حذاء رياضي** بـ 900 جنيه 👟 تحب أطلبه؟' }], usage: { input_tokens: 10, output_tokens: 5 } }
      : { id: 'm1', type: 'message', role: 'assistant', model: r.model, stop_reason: 'tool_use', content: [{ type: 'text', text: 'بدور...' }, { type: 'tool_use', id: 'tu_1', name: 'search_products', input: { query: 'حذاء' } }], usage: { input_tokens: 10, output_tokens: 5 } };
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out));
  });
});

test('Claude: حلقة الأدوات + شكل البرومبت + تنظيف الماركداون', async () => {
  await new Promise((r) => fake.listen(0, r));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${fake.address().port}`;
  const { q, updateSettings } = await import('../src/db.js');
  const { applyImport, parseBuffer, autoMapping } = await import('../src/importer.js');
  const { registerJobs } = await import('../src/server.js');
  const { startWorker, stopWorker, drain, enqueueReply } = await import('../src/queue.js');
  const { findOrCreateConversation, addMessage, listMessages } = await import('../src/conversations.js');
  registerJobs();
  const table = await parseBuffer(Buffer.from(CSV), 'x.csv');
  const sid = Number(q.run(`INSERT INTO sources(name,type) VALUES('t','file')`).lastInsertRowid);
  applyImport({ id: sid, mapping: autoMapping(table.headers), deactivate_missing: 1 }, table);
  q.run(`UPDATE categories SET instructions='اسأل عن المقاس الأوروبي' WHERE name='أحذية'`);
  updateSettings({ ai: { provider: 'anthropic', api_key: 'test-key' }, bot: { debounce_ms: 0 }, persona: { extra_instructions: 'اذكر إن التوصيل سريع' } });

  startWorker();
  const conv = findOrCreateConversation('simulator', 'claude1', 'x');
  addMessage(conv.id, { direction: 'in', sender: 'customer', text: 'عايز حذاء' });
  enqueueReply(conv.id, 0); await drain(); stopWorker();

  assert.equal(requests.length, 2);
  const [r1, r2] = requests;
  assert.equal(r1.model, 'claude-sonnet-5-5');
  assert.ok(r1.tools.some((t) => t.name === 'search_products') && r1.tools.some((t) => t.name === 'confirm_order'));
  const sys = r1.system.map((b) => b.text).join('\n');
  assert.match(sys, /HARD RULES/); assert.match(sys, /اسأل عن المقاس الأوروبي/); assert.match(sys, /اذكر إن التوصيل سريع/);
  assert.equal(r1.system[0].cache_control.type, 'ephemeral');
  // الجولة التانية فيها نتيجة الأداة بالمنتج الحقيقي
  const tr = r2.messages.at(-1).content[0];
  assert.equal(tr.type, 'tool_result'); assert.equal(tr.tool_use_id, 'tu_1'); assert.match(tr.content, /900/);
  const reply = listMessages(conv.id).filter((m) => m.direction === 'out').at(-1);
  assert.equal(reply.text, 'حذاء رياضي بـ 900 جنيه 👟 تحب أطلبه؟'); // اتشال الـ **
  assert.equal(reply.meta.trace[0].tool, 'search_products');
  fake.close();
});
