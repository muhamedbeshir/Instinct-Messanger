/** عنوان Graph API (قابل للتبديل بـ META_GRAPH_BASE للاختبارات) */
export const graphUrl = (p, version = 'v21.0') => `${process.env.META_GRAPH_BASE || 'https://graph.facebook.com'}/${version}${p}`;
