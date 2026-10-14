import * as W from './workday.js';
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : (fail++, console.log('FAIL', n, x ?? '')); };
const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0);
const X = { start: '23:30', end: '04:00' };     // نافذة تعبر منتصف الليل
const S = { start: '08:00', end: '23:00' };     // نافذة داخل اليوم

// ---- تحليل الأوقات
ok('toMinutes', W.toMinutes('00:00') === 0 && W.toMinutes('23:59') === 1439 && W.toMinutes('02:30') === 150);
ok('toMinutes bad', W.toMinutes('') === null && W.toMinutes('24:00') === null && W.toMinutes('7:5') === null && W.toMinutes(undefined) === null);
ok('cross detect', W.isCrossMidnight('23:30', '04:00') && !W.isCrossMidnight('08:00', '23:00') && !W.isCrossMidnight('', '04:00'));
ok('kinds', W.windowKind('23:30', '04:00') === 'cross-midnight' && W.windowKind('08:00', '23:00') === 'same-day' && W.windowKind('', '') === 'none' && W.windowKind('10:00', '10:00') === 'empty');

// ---- المثال المطلوب حرفيًا: دخل 13 أكتوبر 02:30 ينسب إلى 12 أكتوبر
ok('example 13 Oct 02:30 -> 12 Oct', W.accountingDate(at(2026, 10, 13, 2, 30), X) === '2026-10-12');
ok('03:30 also previous day', W.accountingDate(at(2026, 10, 13, 3, 30), X) === '2026-10-12');

// ---- حدود النافذة العابرة لمنتصف الليل 23:30 → 04:00 (قبل المنتصف وبعده، عند البداية وعند النهاية)
const crossCases = [
  [at(2026, 10, 12, 10, 0), '2026-10-12'], [at(2026, 10, 12, 23, 29), '2026-10-12'],
  [at(2026, 10, 12, 23, 30), '2026-10-12'], [at(2026, 10, 12, 23, 59), '2026-10-12'],
  [at(2026, 10, 13, 0, 0), '2026-10-12'], [at(2026, 10, 13, 1, 15), '2026-10-12'],
  [at(2026, 10, 13, 3, 59), '2026-10-12'], [at(2026, 10, 13, 4, 0), '2026-10-13'],
  [at(2026, 10, 13, 10, 0), '2026-10-13'], [at(2026, 10, 13, 23, 30), '2026-10-13'],
];
for (const [d, want] of crossCases) ok(`cross ${d.toISOString().slice(0, 10)} ${d.getHours()}:${d.getMinutes()}`, W.accountingDate(d, X) === want, W.accountingDate(d, X));
const crossOpen = [[at(2026, 10, 12, 23, 29), false], [at(2026, 10, 12, 23, 30), true], [at(2026, 10, 13, 0, 0), true], [at(2026, 10, 13, 3, 59), true], [at(2026, 10, 13, 4, 0), false], [at(2026, 10, 13, 12, 0), false]];
for (const [d, want] of crossOpen) ok(`cross window open ${d.getHours()}:${d.getMinutes()}`, W.inIncomeWindow(X.start, X.end, d) === want);

// ---- نافذة داخل اليوم 08:00 → 23:00 (السلوك السابق محفوظ: النهاية = بداية اليوم التالي)
const sameCases = [[at(2026, 10, 12, 0, 30), '2026-10-12'], [at(2026, 10, 12, 7, 0), '2026-10-12'], [at(2026, 10, 12, 8, 0), '2026-10-12'], [at(2026, 10, 12, 22, 59), '2026-10-12'], [at(2026, 10, 12, 23, 0), '2026-10-13'], [at(2026, 10, 12, 23, 30), '2026-10-13']];
for (const [d, want] of sameCases) ok(`same-day ${d.getHours()}:${d.getMinutes()}`, W.accountingDate(d, S) === want);
const sameOpen = [[at(2026, 10, 12, 7, 59), false], [at(2026, 10, 12, 8, 0), true], [at(2026, 10, 12, 22, 59), true], [at(2026, 10, 12, 23, 0), false]];
for (const [d, want] of sameOpen) ok(`same-day open ${d.getHours()}:${d.getMinutes()}`, W.inIncomeWindow(S.start, S.end, d) === want);

// ---- بلا نافذة: اليوم الميلادي، والنافذة غير المحددة مفتوحة دائمًا
ok('no window = calendar day', W.accountingDate(at(2026, 10, 13, 2, 30), {}) === '2026-10-13' && W.accountingDate(at(2026, 10, 13, 23, 59), { start: '', end: '' }) === '2026-10-13');
ok('no window open', W.inIncomeWindow('', '', at(2026, 10, 13, 12, 0)) && W.inIncomeWindow('08:00', '', at(2026, 10, 13, 12, 0)));
// نهاية فقط (بيانات قديمة): السلوك السابق (بعد النهاية = اليوم التالي)
ok('end only keeps legacy', W.accountingDate(at(2026, 10, 12, 23, 30), { start: '', end: '23:00' }) === '2026-10-13');

// ---- عبور حدود الشهر والسنة والسنة الكبيسة
ok('month boundary', W.accountingDate(at(2026, 11, 1, 2, 30), X) === '2026-10-31');
ok('year boundary', W.accountingDate(at(2027, 1, 1, 1, 0), X) === '2026-12-31');
ok('leap day', W.accountingDate(at(2028, 3, 1, 1, 0), X) === '2028-02-29' && W.accountingDate(at(2027, 3, 1, 1, 0), X) === '2027-02-28');
ok('forward boundary same-day', W.accountingDate(at(2026, 12, 31, 23, 30), S) === '2027-01-01');

// ---- تغيير الإعدادات: التاريخ المحاسبي يُحسب لحظة التسجيل فقط ويُخزَّن نصًا، فلا يتغير بعده
const stored = W.accountingDate(at(2026, 10, 13, 2, 30), X);                // سُجّل تحت النافذة القديمة
const underNewWindow = W.accountingDate(at(2026, 10, 13, 2, 30), { start: '20:00', end: '23:00' });
ok('same instant, different window may differ (new records only)', stored === '2026-10-12' && underNewWindow === '2026-10-13');
ok('stored value is a plain string (no recompute on read)', typeof stored === 'string' && stored === '2026-10-12');

// ---- معرّف الدخل اليومي: 23:45 و02:30 لنفس ليلة العمل ← نفس المعرّف (لا تكرار)
const id1 = W.incomeDocId('storeA', W.accountingDate(at(2026, 10, 12, 23, 45), X));
const id2 = W.incomeDocId('storeA', W.accountingDate(at(2026, 10, 13, 2, 30), X));
const id3 = W.incomeDocId('storeA', W.accountingDate(at(2026, 10, 13, 23, 45), X));
ok('same night same doc id', id1 === id2 && id1 === 'storeA_2026-10-12' && id3 === 'storeA_2026-10-13' && id1 !== id3);

// ---- لحظة إغلاق اليوم (تنبيه الدخل المنسي)
let c = W.closeInstant('2026-10-12', X);
ok('close cross', c.getFullYear() === 2026 && c.getMonth() === 9 && c.getDate() === 13 && c.getHours() === 4 && c.getMinutes() === 0);
c = W.closeInstant('2026-10-12', S);
ok('close same-day', c.getDate() === 12 && c.getHours() === 23 && c.getMinutes() === 0);
c = W.closeInstant('2026-12-31', X);
ok('close crosses year', c.getFullYear() === 2027 && c.getMonth() === 0 && c.getDate() === 1 && c.getHours() === 4);
ok('close invalid', W.closeInstant('x', X) === null && W.closeInstant('2026-10-12', { start: '', end: '' }) === null);
// الإغلاق متسق مع التصنيف: لحظة الإغلاق تنتمي لليوم التالي، وقبلها بدقيقة تنتمي لليوم نفسه
for (const win of [X, S]) {
  const cl = W.closeInstant('2026-10-12', win);
  ok(`close consistent ${win.start}-${win.end}`, W.accountingDate(cl, win) === '2026-10-13' && W.accountingDate(new Date(cl.getTime() - 60000), win) === '2026-10-12');
}

// ---- نص التلميح
ok('hints', /تعبر منتصف الليل/.test(W.windowHint('23:30', '04:00')) && /اليوم التالي/.test(W.windowHint('08:00', '23:00')) && /متطابقان/.test(W.windowHint('10:00', '10:00')) && /الميلادي/.test(W.windowHint('', '')));

console.log(`workday.js: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
