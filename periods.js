// منطق الفترات والتقارير (دوال نقية بلا واجهة، قابلة للاختبار).
// كل التواريخ نصوص ISO بصيغة YYYY-MM-DD وتُحسب بالتقويم دون أي تحويل UTC.

export const pad2 = (n) => String(n).padStart(2, "0");
export const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
export const daysInMonth = (y, m) => [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
export const daysInYear = (y) => (isLeap(y) ? 366 : 365);
export const isoOf = (y, m, d) => `${y}-${pad2(m)}-${pad2(d)}`;
export const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseISO(s) {
  const m = ISO_RE.exec(String(s || ""));
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
  return { y, m: mo, d };
}
// رقم اليوم المتسلسل (لحساب الفروق بين تاريخين بدقة، بما فيها السنوات الكبيسة)
export function dayNumber(s) {
  const p = parseISO(s);
  if (!p) return NaN;
  return Math.floor(Date.UTC(p.y, p.m - 1, p.d) / 86400000);
}
export const addDays = (s, n) => {
  const p = parseISO(s);
  const t = new Date(Date.UTC(p.y, p.m - 1, p.d + n));
  return isoOf(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
};
export const dayOfWeek = (s) => { const p = parseISO(s); return new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay(); }; // 0 = الأحد

// بداية الأسبوع: الأحد (أسبوع العمل في الجزائر). مفتاح الأسبوع = تاريخ أحده.
export const WEEK_START = 0;
export function weekKey(s) {
  const k = (dayOfWeek(s) - WEEK_START + 7) % 7;
  return addDays(s, -k);
}

// ---------- الفلتر ----------
// { mode: "month", month: 1..12, year } | { mode: "year", year } | { mode: "custom", from, to }
export function defaultFilter(today) {
  const p = parseISO(today);
  return { mode: "month", month: p.m, year: p.y, from: today, to: today };
}
export function validateFilter(f) {
  if (!f) return "اختر الفترة";
  if (f.mode === "month") {
    if (!(f.month >= 1 && f.month <= 12)) return "اختر الشهر";
    if (!(f.year >= 2000 && f.year <= 2200)) return "اختر السنة";
    return "";
  }
  if (f.mode === "year") return f.year >= 2000 && f.year <= 2200 ? "" : "اختر السنة";
  if (f.mode === "custom") {
    if (!parseISO(f.from) || !parseISO(f.to)) return "حدّد تاريخ البداية وتاريخ النهاية";
    if (f.from > f.to) return "تاريخ البداية يجب ألا يكون بعد تاريخ النهاية";
    return "";
  }
  return "اختر الفترة";
}

// يرجع { from, to, days (كل أيام الفترة), elapsed (الأيام المحسوبة في المتوسط), partial }
// الفترة التي تشمل اليوم الحالي تُحسب أيامها حتى اليوم فقط (لا معنى لقسمة الشهر الجاري على أيام لم تأتِ بعد)،
// أما الفترات المنتهية فتُحسب بكل أيامها التقويمية بما فيها الأيام الخالية من العمليات.
export function rangeOf(f, today) {
  let from, to;
  if (f.mode === "month") { from = isoOf(f.year, f.month, 1); to = isoOf(f.year, f.month, daysInMonth(f.year, f.month)); }
  else if (f.mode === "year") { from = isoOf(f.year, 1, 1); to = isoOf(f.year, 12, 31); }
  else { from = f.from; to = f.to; }
  const days = dayNumber(to) - dayNumber(from) + 1;
  let elapsed = days, partial = false;
  if (today && today >= from && today <= to) { elapsed = dayNumber(today) - dayNumber(from) + 1; partial = elapsed < days; }
  if (today && today < from) { elapsed = 0; }
  return { mode: f.mode, from, to, days, elapsed, partial };
}
export const inRange = (date, r) => typeof date === "string" && date >= r.from && date <= r.to;

// ---------- تجميع ----------
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

export function summarize(records, r, { amount = (x) => x.amount, date = (x) => x.date } = {}) {
  let total = 0, count = 0;
  for (const x of records) { if (inRange(date(x), r)) { total += num(amount(x)); count++; } }
  return { total, count, avgDaily: r.elapsed > 0 ? total / r.elapsed : 0 };
}

// مجموعات الأيام مرتبة من الأحدث إلى الأقدم: [{ date, items, total }]
export function groupByDay(records, r, { amount = (x) => x.amount, date = (x) => x.date, order = (a, b) => 0 } = {}) {
  const map = new Map();
  for (const x of records) {
    const d = date(x);
    if (!inRange(d, r)) continue;
    if (!map.has(d)) map.set(d, { date: d, items: [], total: 0 });
    const g = map.get(d); g.items.push(x); g.total += num(amount(x));
  }
  const out = [...map.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  out.forEach((g) => g.items.sort(order));
  return out;
}

// يضيف علامة فاصل أسبوعي: group.weekBreakBefore = true عند أول مجموعة من أسبوع جديد (غير الأولى في القائمة)
export function markWeekBreaks(groups) {
  let prev = null;
  return groups.map((g) => {
    const k = weekKey(g.date);
    const out = { ...g, weekKey: k, weekBreakBefore: prev !== null && prev !== k };
    prev = k;
    return out;
  });
}

// ---------- الديون ----------
// الأصلي (amount) والمسدَّد (paidAmount) والمتبقي (remainingAmount) قيم منفصلة ولا تُخلط.
export function debtSummary(debts, r, { dir = "all", status = "all" } = {}) {
  const list = debts.filter((d) => inRange(d.date, r) && (dir === "all" || d.type === dir) && (status === "all" || normStatus(d) === status));
  const s = { count: list.length, original: 0, paid: 0, remaining: 0, byStatus: { unpaid: 0, partial: 0, paid: 0 }, byDir: { receivable: { count: 0, original: 0, remaining: 0 }, payable: { count: 0, original: 0, remaining: 0 } } };
  for (const d of list) {
    const st = normStatus(d);
    s.original += num(d.amount); s.paid += num(d.paidAmount); s.remaining += num(d.remainingAmount);
    s.byStatus[st]++;
    const bd = s.byDir[d.type === "receivable" ? "receivable" : "payable"];
    bd.count++; bd.original += num(d.amount); bd.remaining += num(d.remainingAmount);
  }
  return { ...s, list, avgDaily: r.elapsed > 0 ? s.original / r.elapsed : 0 };
}
export function normStatus(d) {
  if (d.status === "paid") return "paid";
  if (d.status === "partial") return "partial";
  return "unpaid";
}

// ---------- السداد ----------
// الإجمالي من سجلات السداد المؤكدة فقط (لا من قيمة الدين الأصلي)
export function paymentSummary(payments, r) {
  const inP = payments.filter((p) => inRange(p.date, r));
  const confirmed = inP.filter((p) => p.status === "confirmed");
  const total = confirmed.reduce((t, p) => t + num(p.amount), 0);
  return {
    total, count: confirmed.length,
    pending: inP.filter((p) => p.status === "pending").length,
    rejected: inP.filter((p) => p.status === "rejected").length,
    avgDaily: r.elapsed > 0 ? total / r.elapsed : 0,
    list: inP,
  };
}
