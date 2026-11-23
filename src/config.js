import fs from 'node:fs';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '..');
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* مفيش .env - عادي */ }

export const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');   // صور المنتجات (عامة)
export const INBOUND_DIR = path.join(DATA_DIR, 'inbound');  // صور العملاء (خاصة)
export const IMPORT_DIR = path.join(DATA_DIR, 'imports');   // ملفات الإكسيل
for (const d of [DATA_DIR, UPLOAD_DIR, INBOUND_DIR, IMPORT_DIR]) fs.mkdirSync(d, { recursive: true });

export const PORT = Number(process.env.PORT || 3000);
export const ENV_ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
export const ENV_ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
