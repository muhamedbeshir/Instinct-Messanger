import { q } from './db.js';
import { now } from './util.js';
import { currentTenantId } from './tenancy.js';
import { platformLog } from './platform.js';

export function log(level, scope, message, extra) {
  const tid = currentTenantId();
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()}${tid != null ? ` t${tid}` : ''} ${scope}: ${message}`;
  if (level === 'error') console.error(line, extra ?? ''); else if (process.env.QUIET !== '1') console.log(line);
  if (level === 'error' || level === 'warn') platformLog(level, scope, message, tid);
  if (tid == null) return;
  try {
    q.run('INSERT INTO logs(level,scope,message,extra,created_at) VALUES(?,?,?,?,?)', level, scope, String(message).slice(0, 2000),
      extra === undefined ? null : JSON.stringify(extra instanceof Error ? { message: extra.message, stack: extra.stack } : extra).slice(0, 4000), now());
    q.run('DELETE FROM logs WHERE id < (SELECT MAX(id) - 5000 FROM logs)');
  } catch { /* ما نوقفش الشغل بسبب اللوج */ }
}
export const info = (s, m, e) => log('info', s, m, e);
export const warn = (s, m, e) => log('warn', s, m, e);
export const error = (s, m, e) => log('error', s, m, e);
