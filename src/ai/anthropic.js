import Anthropic from '@anthropic-ai/sdk';
import { getSetting } from '../db.js';
import { ENV_ANTHROPIC_KEY } from '../config.js';
import * as logger from '../logger.js';

export const apiKey = () => getSetting('ai.api_key') || ENV_ANTHROPIC_KEY;

let client = null; let clientKey = '';
function getClient() {
  const key = apiKey();
  if (!client || clientKey !== key) {
    client = new Anthropic({ apiKey: key, timeout: getSetting('ai.timeout_ms', 45000), maxRetries: 2 });
    clientKey = key;
  }
  return client;
}

const toolResultContent = (out) => (out && out.__content ? out.__content : JSON.stringify(out));

export async function runAnthropic({ system, messages, tools, executeTool, maxRounds }) {
  const model = getSetting('ai.model', 'claude-sonnet-5-5');
  const max_tokens = getSetting('ai.max_tokens', 1024);
  const convo = [...messages];
  const sys = [
    { type: 'text', text: system.stable, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: system.dynamic },
  ];
  let usage = { input: 0, output: 0 };
  for (let round = 0; round < maxRounds; round++) {
    const res = await getClient().messages.create({ model, max_tokens, system: sys, tools, messages: convo });
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
  const res = await getClient().messages.create({ model, max_tokens, system: sys, tools, tool_choice: { type: 'none' }, messages: convo });
  return { text: res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim(), usage };
}
