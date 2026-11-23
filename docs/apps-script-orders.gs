/**
 * استقبال الأوردرات من Instinct Messenger وإضافتها كصفوف في Google Sheet.
 * الخطوات في docs/SETUP.md (قسم "ربط الأوردرات بشيت").
 */
const SECRET = ''; // لو حطيت "كلمة سر الـ Webhook" في لوحة التحكم، اكتب نفس الكلمة هنا
const SHEET_NAME = 'الأوردرات';

function doPost(e) {
  const data = JSON.parse(e.postData.contents);
  if (SECRET && data.secret !== SECRET) return ContentService.createTextOutput('forbidden');

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
  if (sh.getLastRow() === 0) {
    sh.appendRow(['رقم الأوردر', 'التاريخ', 'القناة', 'الاسم', 'الموبايل', 'المحافظة', 'العنوان',
                  'المنتجات', 'المجموع', 'الخصم', 'الشحن', 'الإجمالي', 'الدفع', 'الحالة', 'ملاحظات']);
    sh.setFrozenRows(1);
  }
  // لو الأوردر اتبعت قبل كده (إعادة محاولة) ما نكرّرهوش
  const ids = sh.getRange(2, 1, Math.max(sh.getLastRow() - 1, 1), 1).getValues().flat();
  if (ids.indexOf(data.number) !== -1) return ContentService.createTextOutput('duplicate');

  const c = data.customer || {};
  sh.appendRow([data.number, new Date(data.created_at), data.channel, c.name, "'" + c.phone, c.governorate, c.address,
                data.items_text, data.subtotal, data.discount, data.shipping, data.total, data.payment_method, data.status, data.notes]);
  return ContentService.createTextOutput('ok');
}
