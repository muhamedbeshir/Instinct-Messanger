import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { q, hydrate, hydrateAll } from './db.js';
import { findOrCreateCategory, invalidateProducts } from './catalog.js';
import { normalizeAr, toLatinDigits, now, parseJSON } from './util.js';
import { normalizeImageUrl } from './images.js';
import * as logger from './logger.js';

/* ---------------- قراءة CSV ---------------- */
export function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const first = text.split(/\r?\n/, 1)[0] || '';
  const delim = [',', ';', '\t'].map((d) => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = []; let row = []; let cell = ''; let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else inQ = false; } else cell += c;
    } else if (c === '"') inQ = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

async function parseXlsx(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error('الملف مفيهوش ورقة بيانات');
  const rows = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const cells = [];
    row.eachCell({ includeEmpty: true }, (cell, n) => {
      let v = cell.value;
      if (v && typeof v === 'object') {
        if (v.text !== undefined) v = v.text;               // رابط / rich text
        else if (v.richText) v = v.richText.map((r) => r.text).join('');
        else if (v.result !== undefined) v = v.result;      // معادلة
        else if (v instanceof Date) v = v.toISOString();
      }
      cells[n - 1] = v == null ? '' : String(v);
    });
    rows.push(Array.from(cells, (c) => c ?? ''));
  });
  return rows;
}

/** يحوّل أي مصدر لجدول: {headers, rows:[{header:value}]} */
export function tableFromRows(rows) {
  if (!rows.length) throw new Error('الجدول فاضي');
  const headers = rows[0].map((h, i) => String(h ?? '').trim() || `عمود ${i + 1}`);
  const seen = new Map();
  const uniq = headers.map((h) => { const n = (seen.get(h) || 0) + 1; seen.set(h, n); return n > 1 ? `${h} (${n})` : h; });
  const data = rows.slice(1).map((r) => Object.fromEntries(uniq.map((h, i) => [h, String(r[i] ?? '').trim()])));
  return { headers: uniq, rows: data.filter((r) => Object.values(r).some(Boolean)) };
}

export async function parseBuffer(buffer, nameOrType = '') {
  const isXlsx = /\.xlsx$/i.test(nameOrType) || (buffer[0] === 0x50 && buffer[1] === 0x4b); // PK zip
  return tableFromRows(isXlsx ? await parseXlsx(buffer) : parseCsv(buffer.toString('utf8')));
}

export function googleSheetCsvUrl(url) {
  const m = String(url).match(/spreadsheets\/d\/([\w-]+)/);
  if (!m) return null;
  const gid = String(url).match(/[?#&]gid=(\d+)/)?.[1] || '0';
  return `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv&gid=${gid}`;
}

export async function loadSource(source) {
  if (source.type === 'file') {
    if (!source.file_path || !fs.existsSync(source.file_path)) throw new Error('الملف مش موجود. ارفعه تاني.');
    return parseBuffer(fs.readFileSync(source.file_path), source.file_path);
  }
  const url = source.type === 'google_sheet' ? googleSheetCsvUrl(source.url) : source.url;
  if (!url) throw new Error('الرابط مش صحيح');
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`مقدرتش أفتح الرابط (HTTP ${res.status}). تأكد إن الشيت مشارك "أي شخص معاه الرابط يقدر يشوف".`);
  const buf = Buffer.from(await res.arrayBuffer());
  const head = buf.subarray(0, 200).toString('utf8').toLowerCase();
  if (head.includes('<html') || head.includes('<!doctype')) throw new Error('الرابط رجّع صفحة تسجيل دخول مش بيانات. افتح الشيت > Share > "Anyone with the link" (Viewer).');
  return parseBuffer(buf, url);
}

/* ---------------- ربط الأعمدة تلقائيًا ---------------- */
const SYNONYMS = {
  name: ['name', 'title', 'product', 'اسم', 'الاسم', 'اسم المنتج', 'المنتج', 'الصنف', 'اسم الصنف', 'البيان'],
  price: ['price', 'سعر', 'السعر', 'سعر البيع', 'سعر المنتج', 'sale price', 'selling price'],
  compare_price: ['compare price', 'old price', 'السعر قبل الخصم', 'السعر القديم', 'سعر قبل'],
  stock: ['stock', 'qty', 'quantity', 'inventory', 'الكمية', 'المخزون', 'المتاح', 'الرصيد', 'كمية'],
  category: ['category', 'type', 'collection', 'قسم', 'القسم', 'الفئة', 'التصنيف', 'النوع', 'تصنيف', 'الصنف الرئيسي'],
  description: ['description', 'desc', 'details', 'وصف', 'الوصف', 'تفاصيل', 'التفاصيل', 'وصف المنتج'],
  images: ['image', 'images', 'photo', 'photos', 'picture', 'img', 'صورة', 'صوره', 'الصورة', 'صور', 'الصور', 'رابط الصورة', 'روابط الصور', 'image url'],
  sku: ['sku', 'code', 'barcode', 'كود', 'الكود', 'باركود', 'كود المنتج', 'رقم المنتج', 'id'],
  notes: ['notes', 'note', 'bot notes', 'ملاحظات', 'ملاحظات للبوت', 'تعليمات'],
  active: ['active', 'enabled', 'status', 'فعال', 'نشط', 'الحالة', 'متاح؟'],
};

export function autoMapping(headers) {
  const used = new Set(); const mapping = {};
  for (const [field, words] of Object.entries(SYNONYMS)) {
    const set = new Set(words.map(normalizeAr));
    const hit = headers.find((h) => !used.has(h) && set.has(normalizeAr(h)));
    if (hit) { mapping[field] = hit; used.add(hit); }
  }
  if (!mapping.name) { const h = headers.find((x) => !used.has(x)); if (h) { mapping.name = h; used.add(h); } }
  mapping.attributes = headers.filter((h) => !used.has(h)); // أي عمود تاني = خاصية ديناميكية (مقاس، لون، خامة...)
  return mapping;
}

const SEP = /[,،/|؛;\n]+/;
const parseNum = (v) => { const s = toLatinDigits(v).replace(/[^\d.\-]/g, ''); const n = parseFloat(s); return Number.isFinite(n) ? n : null; };
const splitList = (v) => String(v || '').split(/[\n|،;]+|(?<=\S)\s{2,}|,\s*(?=https?:)/).map((s) => s.trim()).filter(Boolean);
const truthy = (v) => !/^(0|false|no|لا|غير متاح|مخفي|inactive|disabled|مش متاح|hidden)$/i.test(String(v).trim());

/** يطبّق الاستيراد: بيعمل upsert للمنتجات، بيعمل الأقسام تلقائيًا، وبيوقف اللي اتشال من الشيت */
export function applyImport(source, table) {
  const mapping = source.mapping && Object.keys(source.mapping).length ? source.mapping : autoMapping(table.headers);
  const stats = { created: 0, updated: 0, deactivated: 0, skipped: 0, categories_created: [], errors: [] };
  const seen = new Set();
  const newCats = new Map(); // category_id -> {attr: hasMultiValues}
  const attrCols = Array.isArray(mapping.attributes) ? mapping.attributes : [];

  table.rows.forEach((row, idx) => {
    try {
      const name = String(row[mapping.name] ?? '').trim();
      if (!name) { stats.skipped++; return; }
      const price = mapping.price ? parseNum(row[mapping.price]) : 0;
      if (price === null) { stats.errors.push(`صف ${idx + 2}: السعر مش مفهوم ("${row[mapping.price]}")`); stats.skipped++; return; }
      const catName = (mapping.category && row[mapping.category]) || source.default_category || 'عام';
      const { category, created } = findOrCreateCategory(catName);
      if (created) { stats.categories_created.push(category.name); newCats.set(category.id, new Set()); }
      const attributes = {};
      for (const c of attrCols) { const v = String(row[c] ?? '').trim(); if (v) attributes[c] = v; }
      if (newCats.has(category.id)) for (const [k, v] of Object.entries(attributes)) if (v.split(SEP).filter((x) => x.trim()).length > 1) newCats.get(category.id).add(k);
      const images = mapping.images ? splitList(row[mapping.images]).map(normalizeImageUrl) : [];
      const stockRaw = mapping.stock ? String(row[mapping.stock] ?? '').trim() : '';
      const stock = stockRaw === '' ? null : parseNum(stockRaw);
      const sku = mapping.sku ? String(row[mapping.sku] ?? '').trim() : '';
      const key = sku || normalizeAr(name);
      if (seen.has(key)) { stats.skipped++; stats.errors.push(`صف ${idx + 2}: "${name}" مكرر في الشيت (اتجاهل)`); return; }
      seen.add(key);
      const active = mapping.active && row[mapping.active] !== '' ? (truthy(row[mapping.active]) ? 1 : 0) : 1;
      const values = [sku, category.id, name, mapping.description ? row[mapping.description] || '' : '', price || 0,
        mapping.compare_price ? parseNum(row[mapping.compare_price]) : null, stock, JSON.stringify(images), JSON.stringify(attributes),
        mapping.notes ? row[mapping.notes] || '' : '', active, now()];
      const existing = q.get('SELECT id, notes FROM products WHERE source_id=? AND source_key=?', source.id, key);
      if (existing) {
        // ملاحظات البوت اللي اتكتبت من اللوحة ما نمسحهاش لو عمود الملاحظات مش في الشيت
        const notes = mapping.notes ? values[9] : existing.notes;
        q.run(`UPDATE products SET sku=?, category_id=?, name=?, description=?, price=?, compare_price=?, stock=?, images=?, attributes=?, notes=?, active=?, updated_at=? WHERE id=?`, ...values.slice(0, 9), notes, active, now(), existing.id);
        stats.updated++;
      } else {
        q.run(`INSERT INTO products(sku,category_id,name,description,price,compare_price,stock,images,attributes,notes,active,updated_at,source_id,source_key) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, ...values, source.id, key);
        stats.created++;
      }
    } catch (e) { stats.errors.push(`صف ${idx + 2}: ${e.message}`); stats.skipped++; }
  });

  // الأقسام الجديدة: نقترح "اسأل العميل عن" من الأعمدة اللي فيها اختيارات متعددة (تتعدل من لوحة التحكم)
  for (const [catId, set] of newCats) if (set.size) q.run(`UPDATE categories SET required_fields=? WHERE id=?`, JSON.stringify([...set]), catId);

  if (source.deactivate_missing) {
    const rows = q.all('SELECT id, source_key FROM products WHERE source_id=? AND active=1', source.id);
    for (const r of rows) if (!seen.has(r.source_key)) { q.run('UPDATE products SET active=0 WHERE id=?', r.id); stats.deactivated++; }
  }
  invalidateProducts();
  return stats;
}

export async function syncSource(id) {
  const source = hydrate('sources', q.get('SELECT * FROM sources WHERE id=?', id));
  if (!source) throw new Error('المصدر مش موجود');
  try {
    const table = await loadSource(source);
    if (!Object.keys(source.mapping).length) {
      source.mapping = autoMapping(table.headers);
      q.run('UPDATE sources SET mapping=? WHERE id=?', JSON.stringify(source.mapping), id);
    }
    const stats = applyImport(source, table);
    q.run('UPDATE sources SET last_sync=?, last_status=? WHERE id=?', now(), `تم: ${stats.created} جديد، ${stats.updated} تحديث، ${stats.deactivated} إيقاف${stats.errors.length ? ` (${stats.errors.length} تحذير)` : ''}`, id);
    logger.info('import', `مصدر ${source.name}: ${JSON.stringify({ ...stats, errors: stats.errors.length })}`);
    return stats;
  } catch (e) {
    q.run('UPDATE sources SET last_sync=?, last_status=? WHERE id=?', now(), `فشل: ${e.message}`, id);
    throw e;
  }
}

export function startSourceScheduler() {
  const t = setInterval(async () => {
    for (const s of q.all('SELECT * FROM sources WHERE active=1 AND sync_minutes>0')) {
      if (now() - s.last_sync >= s.sync_minutes * 60000) {
        try { await syncSource(s.id); } catch (e) { logger.warn('import', `مزامنة ${s.name}: ${e.message}`); }
      }
    }
  }, 60000);
  t.unref();
}
