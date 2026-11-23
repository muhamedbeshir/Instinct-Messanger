import { getSetting } from '../db.js';
import { getPlatformSettings, tenantInfo, hasFeature } from '../platform.js';
import { ENV_ANTHROPIC_KEY, IS_PROD } from '../config.js';

/**
 * إعدادات الذكاء الاصطناعي بتتحدد من المنصة (السوبر أدمن) مش من العميل:
 * المفتاح والموديل والحدود. العميل على باقة "byok" بس يقدر يستخدم مفتاحه الخاص.
 */
export function aiConfig() {
  const ps = getPlatformSettings().ai;
  const own = hasFeature(tenantInfo(), 'byok') ? getSetting('ai.api_key') : '';
  const apiKey = own || ps.api_key || ENV_ANTHROPIC_KEY;
  let provider = ps.provider;
  if (provider === 'auto') provider = apiKey ? 'anthropic' : 'mock';
  if (provider === 'anthropic' && !apiKey) provider = 'mock';
  return {
    provider, apiKey, model: ps.model, max_tokens: ps.max_tokens, timeout_ms: ps.timeout_ms,
    allow_mock: Boolean(ps.allow_mock) || !IS_PROD, // في الإنتاج الوضع التجريبي ممنوع يرد على عملاء حقيقيين إلا بإذن صريح
    understand_images: getSetting('ai.understand_images', true),
  };
}

/** حالة الذكاء الاصطناعي على مستوى المنصة (بدون سياق عميل) للوحة الإدارة */
export function platformAiStatus() {
  const ps = getPlatformSettings().ai;
  const apiKey = ps.api_key || ENV_ANTHROPIC_KEY;
  let provider = ps.provider;
  if (provider === 'auto') provider = apiKey ? 'anthropic' : 'mock';
  if (provider === 'anthropic' && !apiKey) provider = 'mock';
  return { provider, key_set: Boolean(apiKey), model: ps.model, mock_allowed: Boolean(ps.allow_mock) || !IS_PROD };
}
