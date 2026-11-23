import Anthropic from '@anthropic-ai/sdk';
import { aiConfig } from './config.js';
import * as logger from '../logger.js';

const clients = new Map();
function getClient(cfg) {
  const k = `${cfg.apiKey}|${cfg.timeout_ms}`;
  if (!clients.has(k)) clients.set(k, new Anthropic({ apiKey: cfg.apiKey, timeout: cfg.timeout_ms, maxRetries: 2 }));
  return clients.get(k);
}

const toolResultContent = (out) => (out && out.__content ? out.__content : JSON.stringify(out));

export async function runAnthropic({ system, messages, tools, executeTool, maxRounds }) {
  const cfg = aiConfig();
  const { model, max_tokens } = cfg;
  const convo = [...messages];
  const sys = [
    { type: 'text', text: system.stable, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: system.dynamic },
  ];
  let usage = { input: 0, output: 0 };
  for (let round = 0; round < maxRounds; round++) {
    const res = await getClient(cfg).messages.create({ model, max_tokens, system: sys, tools, messages: convo });
    usage.input += res.usage?.input_tokens || 0; usage.output += res.usage?.output_tokens || 0;
    convo.push({ role: 'assistant', content: res.content });
    if (res.stop_reason !== 'tool_use') {
      return { text: res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim(), usage };
    }
    const results = [];
    for (const block of res.content.filter((b) => b.type === 'tool_use')) {
      try {
        const out = await executeTool(block.name, block.input);
        results.push({ type: 'tool_result', tool_use_id: block.id, content: toolResultContent(out) });
      } catch (e) {
        logger.error('tool', `${block.name}: ${e.message}`);
        results.push({ type: 'tool_result', tool_use_id: block.id, is_error: true, content: `Tool error: ${e.message}` });
      }
    }
    convo.push({ role: 'user', content: results });
  }
  // وصلنا لحد الجولات: اطلب رد نهائي بدون أدوات
  const res = await getClient(cfg).messages.create({ model, max_tokens, system: sys, tools, tool_choice: { type: 'none' }, messages: convo });
  return { text: res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim(), usage };
}
