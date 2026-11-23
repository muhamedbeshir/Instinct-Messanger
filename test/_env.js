import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// لازم يتحمّل قبل أي ملف من src عشان قاعدة بيانات الاختبار تبقى مؤقتة
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'im-test-'));
process.env.QUIET = '1';
process.env.ANTHROPIC_API_KEY = '';
process.env.IM_DEFAULT_TENANT = '1'; // الاختبارات بتشتغل كعميل رقم 1 لما مفيش سياق
