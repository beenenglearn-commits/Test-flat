// اليوم المحاسبي (يوم العمل) ونافذة تسجيل الدخل — دوال نقية بلا React ولا Firebase (تُختبر بـ: node workday.test.mjs)
//
// القاعدة الوحيدة: «نهاية نافذة الدخل = بداية يوم عمل جديد». الأوقات تأتي دائمًا من إعداد المتجر الذي يحدده الأدمن
// (incomeStart / incomeEnd)، فلا توجد ساعة ثابتة في الكود.
//   • نافذة داخل اليوم نفسه (08:00 → 23:00): ما يُسجَّل عند النهاية أو بعدها يتبع اليوم التالي.
//   • نافذة تعبر منتصف الليل (23:30 → 04:00): ما يُسجَّل من 00:00 حتى وقت النهاية يتبع اليوم السابق،
//     فدخل 13 أكتوبر الساعة 02:30 يُحتسب ليوم 12 أكتوبر.
//   • بلا نافذة: اليوم الميلادي المحلي.
// التاريخ المحاسبي يُحسب لحظة إنشاء السجل ويُخزَّن في حقل date؛ لا يُعاد حسابه عند القراءة، فتغيير النافذة لاحقًا
// لا يمسّ العمليات القديمة (إعادة التصنيف لا تتم إلا بتعديل صريح من الأدمن).
import { pad2 } from "./periods.js";

export const HM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

// "HH:MM" → دقائق منذ منتصف الليل، أو null إن لم يكن الوقت صالحًا
export const toMinutes = (hm) => {
  const m = HM_RE.exec(String(hm || ""));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

// هل تعبر النافذة منتصف الليل؟ (البداية بعد النهاية)
export const isCrossMidnight = (start, end) => {
  const a = toMinutes(start), b = toMinutes(end);
  return a !== null && b !== null && a > b;
};

// نوع النافذة: none (غير محددة) | same-day | cross-midnight | empty (البداية = النهاية؛ نافذة فارغة غير مقبولة)
export function windowKind(start, end) {
  const a = toMinutes(start), b = toMinutes(end);
  if (b === null) return "none";
  if (a !== null && a === b) return "empty";
  return a !== null && a > b ? "cross-midnight" : "same-day";
}

const localISO = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const minutesOf = (d) => d.getHours() * 60 + d.getMinutes();

// هل الوقت الآن داخل نافذة تسجيل الدخل؟ (النافذة غير المحددة = مفتوحة دائمًا)
export function inIncomeWindow(start, end, now = new Date()) {
  const a = toMinutes(start), b = toMinutes(end);
  if (a === null || b === null) return true;
  const m = minutesOf(now);
  return a <= b ? m >= a && m < b : m >= a || m < b;
}

// التاريخ المحاسبي (YYYY-MM-DD) للحظة now
export function accountingDate(now = new Date(), { start = "", end = "" } = {}) {
  const e = toMinutes(end);
  if (e === null) return localISO(now);
  // الظهيرة تتجنب أي انزياح بسبب تغيّر التوقيت الصيفي عند إضافة يوم أو طرحه
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0, 0);
  const m = minutesOf(now);
  if (isCrossMidnight(start, end)) { if (m < e) d.setDate(d.getDate() - 1); }
  else if (m >= e) d.setDate(d.getDate() + 1);
  return localISO(d);
}

// اللحظة التي يُغلق عندها يوم العمل dayISO (تستعملها تنبيهات «لم يُسجَّل دخل يوم كذا»)
export function closeInstant(dayISO, { start = "", end = "" } = {}) {
  const e = toMinutes(end);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dayISO || ""));
  if (e === null || !m) return null;
  const add = isCrossMidnight(start, end) ? 1 : 0;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + add, Math.floor(e / 60), e % 60, 0, 0);
}

// معرّف مستند الدخل اليومي: متجر + يوم محاسبي (يمنع تكرار دخل اليوم الواحد حتى لو تجاوز التسجيل منتصف الليل)
export const incomeDocId = (storeId, dayISO) => `${storeId}_${dayISO}`;

// جملة توضيحية تظهر للأدمن تحت حقلي الوقت
export function windowHint(start, end) {
  const k = windowKind(start, end);
  if (k === "cross-midnight") return `الفترة تعبر منتصف الليل: ما يُسجَّل بين 00:00 و${end} يُنسب إلى اليوم السابق، ويبدأ يوم جديد عند ${end}.`;
  if (k === "same-day") return `عند ${end} يبدأ يوم جديد: ما يُسجَّل بعد هذا الوقت يُنسب إلى اليوم التالي.`;
  if (k === "empty") return "وقت البداية والنهاية متطابقان؛ اختر وقتين مختلفين.";
  return "بلا تحديد: اليوم = اليوم الميلادي.";
}
