import { EventEmitter } from 'node:events';
import { currentTenantId } from './tenancy.js';
export const bus = new EventEmitter();
bus.setMaxListeners(500);
/** حدث لحظي بيوصل للوحات التحكم الخاصة بنفس العميل بس (طلب جديد، رسالة...) */
export const emit = (type, data = {}) => bus.emit('event', { type, data, tenantId: currentTenantId(), at: Date.now() });
