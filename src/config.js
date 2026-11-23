import fs from 'node:fs';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '..');
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* مفيش .env - عادي */ }

export const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
fs.mkdirSync(DATA_DIR, { recursive: true });

export const PORT = Number(process.env.PORT || 3000);
export const ENV_SUPERADMIN_EMAIL = process.env.SUPERADMIN_EMAIL || '';
export const ENV_SUPERADMIN_PASSWORD = process.env.SUPERADMIN_PASSWORD || '';
export const IS_PROD = process.env.NODE_ENV === 'production';
export const ENV_ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
