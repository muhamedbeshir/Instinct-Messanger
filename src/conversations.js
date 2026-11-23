import { q, db, hydrate, hydrateAll } from './db.js';
import { now } from './util.js';
import { emit } from './events.js';

export function getConversation(id) { return hydrate('conversations', q.get('SELECT * FROM conversations WHERE id=?', id)); }

export function saveConversation(id, patch) {
  const cols = []; const vals = [];
  for (const [k, v] of Object.entries(patch)) {
    cols.push(`${k}=?`);
    vals.push(v !== null && typeof v === 'object' ? JSON.stringify(v) : v);
  }
  if (!cols.length) return getConversation(id);
  q.run(`UPDATE conversations SET ${cols.join(', ')} WHERE id=?`, ...vals, id);
  return getConversation(id);
}

export function findOrCreateConversation(channel, externalId, displayName = '') {
  let row = q.get('SELECT * FROM conversations WHERE channel=? AND external_id=?', channel, String(externalId));
  if (!row) {
    const r = q.run('INSERT INTO conversations(channel, external_id, display_name, created_at, last_message_at) VALUES(?,?,?,?,?)',
      channel, String(externalId), displayName || '', now(), now());
    row = q.get('SELECT * FROM conversations WHERE id=?', r.lastInsertRowid);
  } else if (displayName && !row.display_name) {
    q.run('UPDATE conversations SET display_name=? WHERE id=?', displayName, row.id);
    row.display_name = displayName;
  }
  return hydrate('conversations', row);
}

/** يضيف رسالة. بيرجع null لو الرسالة مكررة (نفس external_id) */
export function addMessage(conversationId, { direction, sender, text = '', attachments = [], meta = {}, external_id = null, status = 'sent' }) {
  try {
    const r = q.run(`INSERT INTO messages(conversation_id,direction,sender,text,attachments,meta,external_id,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)`,
      conversationId, direction, sender, text, JSON.stringify(attachments), JSON.stringify(meta), external_id, status, now());
    q.run('UPDATE conversations SET last_message_at=? WHERE id=?', now(), conversationId);
    const msg = hydrate('messages', q.get('SELECT * FROM messages WHERE id=?', r.lastInsertRowid));
    emit('message', { conversation_id: conversationId, message: msg });
    return msg;
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return null;
    throw e;
  }
}

export function listMessages(conversationId, { limit = 200, afterId = 0 } = {}) {
  const rows = q.all('SELECT * FROM (SELECT * FROM messages WHERE conversation_id=? AND id>? ORDER BY id DESC LIMIT ?) ORDER BY id', conversationId, afterId, limit);
  return hydrateAll('messages', rows);
}

export function listConversations({ limit = 100, filter = '' } = {}) {
  let where = '';
  if (filter === 'needs_human') where = 'WHERE c.needs_human=1';
  else if (filter === 'paused') where = 'WHERE c.bot_paused=1';
  const rows = q.all(`SELECT c.*, (SELECT text FROM messages m WHERE m.conversation_id=c.id ORDER BY m.id DESC LIMIT 1) AS last_text,
      (SELECT COUNT(*) FROM orders o WHERE o.conversation_id=c.id) AS orders_count
    FROM conversations c ${where} ORDER BY c.last_message_at DESC LIMIT ?`, limit);
  return hydrateAll('conversations', rows);
}

export function botIsPausedFor(conv) {
  return Boolean(conv.bot_paused) || (conv.paused_until && conv.paused_until > now());
}

export function withTransaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}
