import { EventEmitter } from 'node:events';
export const bus = new EventEmitter();
bus.setMaxListeners(100);
/** يبعت حدث لكل لوحات التحكم المفتوحة (طلب جديد، رسالة جديدة...) */
export const emit = (type, data = {}) => bus.emit('event', { type, data, at: Date.now() });
