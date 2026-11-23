import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import fs from 'node:fs';
import { DATA_DIR } from './config.js';

/**
 * كل عميل (tenant) له قاعدة بيانات وملفات منفصلة تمامًا: data/tenants/<id>/
 * والكود كله بيشتغل "جوه سياق عميل" (AsyncLocalStorage) فأي استعلام بيروح لقاعدة العميل الصح تلقائيًا،
 * ومستحيل عميل يشوف داتا عميل تاني.
 */
export const als = new AsyncLocalStorage();

export function currentTenantId() {
  const s = als.getStore();
  if (s && s.tenantId != null) return s.tenantId;
  // للاختبارات فقط: عميل افتراضي لما مفيش سياق
  if (process.env.IM_DEFAULT_TENANT) return Number(process.env.IM_DEFAULT_TENANT);
  return null;
}
export function requireTenantId() {
  const id = currentTenantId();
  if (id == null) throw new Error('no tenant context');
  return id;
}
export const runInTenant = (tenantId, fn) => als.run({ tenantId: Number(tenantId) }, fn);

export const tenantDir = (id = requireTenantId()) => path.join(DATA_DIR, 'tenants', String(Number(id)));
function sub(name, id) { const d = path.join(tenantDir(id), name); fs.mkdirSync(d, { recursive: true }); return d; }
export const uploadDir = (id) => sub('uploads', id);   // صور المنتجات (عامة)
export const inboundDir = (id) => sub('inbound', id);  // صور العملاء (خاصة)
export const importDir = (id) => sub('imports', id);
