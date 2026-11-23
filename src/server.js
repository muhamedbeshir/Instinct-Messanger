import path from 'node:path';
import express from 'express';
import { ROOT, PORT, UPLOAD_DIR } from './config.js';
import { q, getSetting } from './db.js';
import * as logger from './logger.js';
import { api } from './routes/api.js';
import { registerHandler, startWorker, queueStats } from './queue.js';
import { respond, replyFailed } from './ai/agent.js';
import { retrySend, deliver } from './channels/index.js';
import { handleWebhook, verifySignature, verifyChallenge } from './channels/meta.js';
import { notifyOrder, exportOrder, alertOwner } from './notify.js';
import { startSourceScheduler } from './importer.js';
import { getOrder } from './orders.js';
import { providerName } from './ai/agent.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '5mb', verify: (req, res, buf) => { req.rawBody = buf; } }));

  app.get('/healthz', (req, res) => res.json({ ok: true, queue: queueStats() }));
  app.use('/media', express.static(UPLOAD_DIR, { maxAge: '7d' }));

  // Meta webhook (Messenger + Instagram + WhatsApp)
  app.get('/webhooks/meta', (req, res) => {
    const challenge = verifyChallenge(req.query);
    challenge !== null ? res.status(200).send(challenge) : res.sendStatus(403);
  });
  app.post('/webhooks/meta', (req, res) => {
    if (!verifySignature(req.rawBody || Buffer.from(''), req.get('x-hub-signature-256'))) return res.sendStatus(401);
    res.sendStatus(200); // نرد بسرعة، والشغل بيتم في الخلفية (Meta بتعيد الإرسال لو اتأخرنا)
    handleWebhook(req.body).catch((e) => logger.error('webhook', e.message, e));
  });

  app.use('/api', api);
  app.use(express.static(path.join(ROOT, 'public')));
  return app;
}

export function registerJobs() {
  registerHandler('reply', ({ }, job) => respond(job.conversation_id), { onFail: replyFailed, timeoutMs: 180000 });
  registerHandler('send', (p) => retrySend(p), { onFail: (p) => { logger.error('send', `إرسال الرسالة ${p.message_id} فشل نهائيًا`); alertOwner(`⚠️ رسالة ما اتبعتش للعميل (id ${p.message_id}). راجع صفحة الصحة.`); } });
  registerHandler('order_notify', (p) => notifyOrder(p));
  registerHandler('order_export', (p) => exportOrder(p), { onFail: (p) => alertOwner(`⚠️ تعذّر إرسال الأوردر ${getOrder(p.order_id)?.number} للـ webhook/الشيت. تقدر تعيد المحاولة من صفحة الطلبات.`) });
  registerHandler('alert_owner', (p) => alertOwner(p.text));
  registerHandler('status_notify', async (p) => {
    const o = getOrder(p.order_id);
    const tpl = getSetting('notifications.status_messages', {})[o?.status];
    if (o?.conversation_id && tpl) await deliver(o.conversation_id, { text: tpl.replace('{number}', o.number), sender: 'bot' });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  registerJobs();
  startWorker();
  startSourceScheduler();
  createApp().listen(PORT, () => {
    logger.info('server', `شغال على http://localhost:${PORT}  (AI: ${providerName()})`);
    if (providerName() === 'mock') logger.warn('server', 'مفيش مفتاح Claude: البوت شغال بالوضع التجريبي (قواعد بسيطة). ضيف المفتاح من الإعدادات > الذكاء الاصطناعي.');
  });
  process.on('unhandledRejection', (e) => logger.error('process', `unhandledRejection: ${e?.message || e}`, e));
}
