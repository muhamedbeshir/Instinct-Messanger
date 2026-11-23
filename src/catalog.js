import { q, hydrate, hydrateAll } from './db.js';
import { normalizeAr, tokens, now } from './util.js';

/* ---------- الأقسام ---------- */
export function listCategories({ activeOnly = false } = {}) {
  const rows = q.all(`SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category_id=c.id AND p.active=1) AS product_count
    FROM categories c ${activeOnly ? 'WHERE c.active=1' : ''} ORDER BY c.sort, c.id`);
  return hydrateAll('categories', rows);
}
export function getCategory(id) { return hydrate('categories', q.get('SELECT * FROM categories WHERE id=?', id)); }

export function findOrCreateCategory(name) {
  const clean = String(name || '').trim() || 'عام';
  const norm = normalizeAr(clean);
  const existing = q.all('SELECT * FROM categories').find((c) => normalizeAr(c.name) === norm);
  if (existing) return { category: hydrate('categories', existing), created: false };
  const r = q.run('INSERT INTO categories(name) VALUES(?)', clean);
  return { category: getCategory(Number(r.lastInsertRowid)), created: true };
}

/* ---------- المنتجات ---------- */
export function getProduct(id) {
  const p = hydrate('products', q.get(`SELECT p.*, c.name AS category_name FROM products p LEFT JOIN categories c ON c.id=p.category_id WHERE p.id=?`, id));
  return p || null;
}

let productCache = null;
export function invalidateProducts() { productCache = null; }
function allActiveProducts() {
  if (!productCache) {
    productCache = hydrateAll('products', q.all(`SELECT p.*, c.name AS category_name, c.active AS category_active
      FROM products p LEFT JOIN categories c ON c.id=p.category_id WHERE p.active=1`))
      .filter((p) => p.category_active !== 0)
      .map((p) => ({
        ...p,
        _name: normalizeAr(p.name),
        _cat: normalizeAr(p.category_name || ''),
        _text: normalizeAr([p.description, p.sku, ...Object.entries(p.attributes).flatMap(([k, v]) => [k, v])].join(' ')),
      }));
  }
  return productCache;
}

export function inStock(p, qty = 1) { return p.stock === null || p.stock === undefined || p.stock >= qty; }

export function publicProduct(p) {
  return {
    id: p.id, sku: p.sku || undefined, name: p.name, category: p.category_name || undefined,
    price: p.price, compare_price: p.compare_price || undefined,
    in_stock: inStock(p), stock: p.stock === null ? 'غير محدد (متاح)' : p.stock,
    description: p.description || undefined,
    attributes: Object.keys(p.attributes || {}).length ? p.attributes : undefined,
    images_count: (p.images || []).length,
    notes_for_bot: p.notes || undefined,
  };
}

export function searchProducts({ query = '', category = '', max_price, min_price, in_stock_only = false, limit = 8 } = {}) {
  const toks = tokens(query);
  const catNorm = normalizeAr(category);
  const results = [];
  for (const p of allActiveProducts()) {
    if (catNorm && !(p._cat.includes(catNorm) || catNorm.includes(p._cat))) continue;
    if (max_price != null && p.price > Number(max_price)) continue;
    if (min_price != null && p.price < Number(min_price)) continue;
    if (in_stock_only && !inStock(p)) continue;
    let score = 0;
    if (toks.length) {
      for (const t of toks) {
        if (p._name.includes(t)) score += 3;
        else if (p._cat.includes(t)) score += 2;
        else if (p._text.includes(t)) score += 1;
      }
      if (score === 0) continue;
    } else score = 1;
    results.push({ p, score });
  }
  results.sort((a, b) => b.score - a.score || a.p.price - b.p.price);
  return results.slice(0, limit).map((r) => r.p);
}

export function catalogOverview() {
  return listCategories({ activeOnly: true }).filter((c) => c.product_count > 0);
}

export function saveProduct(input, id = null) {
  const images = Array.isArray(input.images) ? input.images.filter(Boolean) : [];
  const attributes = input.attributes && typeof input.attributes === 'object' ? input.attributes : {};
  const stock = input.stock === '' || input.stock === null || input.stock === undefined ? null : Number(input.stock);
  const compare = input.compare_price === '' || input.compare_price == null ? null : Number(input.compare_price);
  const vals = [input.sku || '', input.category_id || null, String(input.name || '').trim(), input.description || '', Number(input.price) || 0,
    compare, Number.isFinite(stock) ? stock : null, JSON.stringify(images), JSON.stringify(attributes), input.notes || '', input.active === 0 || input.active === false ? 0 : 1, now()];
  if (!vals[2]) throw new Error('اسم المنتج مطلوب');
  if (id) {
    q.run(`UPDATE products SET sku=?, category_id=?, name=?, description=?, price=?, compare_price=?, stock=?, images=?, attributes=?, notes=?, active=?, updated_at=? WHERE id=?`, ...vals, id);
  } else {
    const r = q.run(`INSERT INTO products(sku,category_id,name,description,price,compare_price,stock,images,attributes,notes,active,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, ...vals);
    id = Number(r.lastInsertRowid);
  }
  invalidateProducts();
  return getProduct(id);
}
