// نظام الألوان: ثوابت الألوان + دوال التباين (دوال نقية قابلة للاختبار بـ: node colors.test.mjs)
// القاعدة: لا يُترك أي نص فوق خلفية دون التحقق من مقروءيته؛ الكارد يحسب لون نصه تلقائيًا من لون خلفيته.

const HEX6 = /^#?([0-9a-fA-F]{6})$/;
export const isHex = (v) => HEX6.test(String(v || "").trim());
const toRGB = (hex) => { const n = parseInt(HEX6.exec(String(hex).trim())[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const toHex = (r) => "#" + r.map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, "0")).join("").toUpperCase();

// #RRGGBB + شفافية ← rgba(...)
export function hexA(hex, a) {
  if (!isHex(hex)) return `rgba(24,38,32,${a})`;
  const [r, g, b] = toRGB(hex); return `rgba(${r},${g},${b},${a})`;
}
// إضاءة نسبية (WCAG)
export function lum(hex) {
  if (!isHex(hex)) return null;
  const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const [r, g, b] = toRGB(hex); return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
export function contrast(a, b) {
  const x = lum(a), y = lum(b);
  if (x === null || y === null) return 1;
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
export const isLight = (hex) => (lum(hex) ?? 1) > 0.42;
export function mix(a, b, t) { const A = toRGB(a), B = toRGB(b); return toHex(A.map((v, i) => v + (B[i] - v) * t)); }

export const DARK_TEXT = "#14142B", LIGHT_TEXT = "#F8FAFC";
// أبيض/داكن حسب الخلفية فقط
export const readableOn = (bg, dark = DARK_TEXT, light = LIGHT_TEXT) => (isHex(bg) ? (isLight(bg) ? dark : light) : dark);
// يُبقي اللون المفضّل إن حقّق التباين المطلوب فوق الخلفية، وإلا يختار الأعلى تباينًا من الداكن/الفاتح
export function textOn(bg, preferred, min = 4.5) {
  if (!isHex(bg)) return preferred;
  if (isHex(preferred) && contrast(preferred, bg) >= min) return preferred;
  return contrast(DARK_TEXT, bg) >= contrast(LIGHT_TEXT, bg) ? DARK_TEXT : LIGHT_TEXT;
}
// للأزرار والعناوين الكبيرة (تباين 3 يكفي)
export const legibleOn = (bg, preferred) => textOn(bg, preferred, 3);
// النص الثانوي: يقترب تدريجيًا من النص الرئيسي حتى يبلغ التباين المطلوب فوق الخلفية
export function softOn(bg, ink, preferredSoft, min = 4.5) {
  if (!isHex(bg) || !isHex(ink)) return preferredSoft;
  if (isHex(preferredSoft) && contrast(preferredSoft, bg) >= min) return preferredSoft;
  const from = isHex(preferredSoft) ? preferredSoft : ink;
  for (let t = 0.1; t <= 1.0001; t += 0.1) { const c = mix(from, ink, t); if (contrast(c, bg) >= min) return c; }
  return ink;
}
// ألوان النص داخل كارد خلفيته bg
export function cardTone(bg, ink, soft) {
  const i = textOn(bg, ink, 7);
  const sBase = i === ink ? soft : mix(i, bg, 0.22);
  return { ink: i, soft: softOn(bg, i, sBase, 4.5) };
}

// ---------- خلفيات متعددة (تدرج): يجب أن يُقرأ النص فوق كل نقطة منه ----------
export const worstContrast = (fg, bgs) => { const l = (bgs || []).filter(isHex); return l.length ? Math.min(...l.map((b) => contrast(fg, b))) : 1; };
export function textOnAll(bgs, preferred, min = 4.5) {
  const l = (bgs || []).filter(isHex);
  if (!l.length) return preferred;
  if (isHex(preferred) && worstContrast(preferred, l) >= min) return preferred;
  return worstContrast(DARK_TEXT, l) >= worstContrast(LIGHT_TEXT, l) ? DARK_TEXT : LIGHT_TEXT;
}
export function softOnAll(bgs, ink, preferredSoft, min = 4.5) {
  const l = (bgs || []).filter(isHex);
  if (!l.length || !isHex(ink)) return preferredSoft;
  if (isHex(preferredSoft) && worstContrast(preferredSoft, l) >= min) return preferredSoft;
  const from = isHex(preferredSoft) ? preferredSoft : ink;
  for (let t = 0.1; t <= 1.0001; t += 0.1) { const c = mix(from, ink, t); if (worstContrast(c, l) >= min) return c; }
  return ink;
}
// مثل cardTone تمامًا لخلفية واحدة؛ ولعدة خلفيات يختار نصًا يحقق التباين فوق أسوأها
export function cardToneAll(bgs, ink, soft) {
  const l = (bgs || []).filter(isHex);
  if (l.length === 1) return cardTone(l[0], ink, soft);
  if (!l.length) return { ink, soft };
  const i = textOnAll(l, ink, 7);
  const sBase = i === ink ? soft : mix(i, l[0], 0.22);
  return { ink: i, soft: softOnAll(l, i, sBase, 4.5) };
}

// ---------- تدقيق الثيم وإصلاحه ----------
export function auditTheme(t) {
  const dark = t.mode === "dark";
  const rows = [
    ["الخط الرئيسي على الخلفية", t.ink, t.bg, 7], ["الخط الرئيسي على الكاردات", t.ink, t.card, 7],
    ["الخط الثانوي على الخلفية", t.inkSoft, t.bg, 4.5], ["الخط الثانوي على الكاردات", t.inkSoft, t.card, 4.5],
    ["خط فصل الأسابيع على الخلفية", t.weekLine, t.bg, 7], ["الحدود على الخلفية", t.line, t.bg, dark ? 1.4 : 3],
  ];
  return rows.map(([label, fg, bg, min]) => { const ratio = contrast(fg, bg); return { label, fg, bg, min, ratio, ok: ratio >= min }; });
}
export function autoFixTheme(t) {
  const out = { ...t };
  const dark = t.mode === "dark";
  // خلفية متوسطة الإضاءة لا يوجد نص يبلغ 7:1 فوقها: نقرّبها من الفاتح أو الداكن حتى يصبح ذلك ممكنًا
  const settle = (c) => {
    if (!isHex(c) || Math.max(contrast(DARK_TEXT, c), contrast(LIGHT_TEXT, c)) >= 7) return c;
    const toLight = (lum(c) ?? 0) > 0.18;
    for (let k = 0.1; k <= 1.0001; k += 0.1) { const m = mix(c, toLight ? "#FFFFFF" : "#000000", k); if (Math.max(contrast(DARK_TEXT, m), contrast(LIGHT_TEXT, m)) >= 7) return m; }
    return toLight ? "#FFFFFF" : "#000000";
  };
  out.bg = settle(t.bg); out.card = settle(t.card);
  const bgs = [out.bg, out.card].filter(isHex);
  const worst = (c) => Math.min(...bgs.map((b) => contrast(c, b)));
  const bright = isLight(out.bg);
  if (worst(t.ink) < 7) out.ink = bright ? DARK_TEXT : LIGHT_TEXT;
  const pull = (start, min) => { if (worst(start) >= min) return start; for (let k = 0.1; k <= 1.0001; k += 0.1) { const c = mix(start, out.ink, k); if (worst(c) >= min) return c; } return out.ink; };
  out.inkSoft = pull(t.inkSoft, 4.5);
  out.weekLine = worst(t.weekLine) >= 7 ? t.weekLine : (bright ? "#1A1A2E" : LIGHT_TEXT);
  out.line = pull(t.line, dark ? 1.4 : 3);
  return out;
}

export const BASE_COLORS = {
  bg: "#F6F3EC",
  card: "#F8F7F2",
  ink: "#182620",
  inkSoft: "#4F5F56",
  line: "#7A8396",
  income: "#2F6F4E",
  expense: "#A6403B",
  receivable: "#2B6C8F",
  payable: "#B5721E",
  gold: "#876A14",
  goldBg: "#FBF3DF",
  netBg: "#DDF4D8",
  debtTotalBg: "#FFE8B8",
  paymentBg: "#DDF4D8",
  incomeBg: "#D8EAF9",
  debtBtn: "#E4B429",
  paymentBtn: "#2563C7",
  expenseLight: "#F7D9D7",
  invoiceCard: "#EEECE5",
  bar: "#0E4D4D",
  button: "#182620",
  buttonText: "#FFFFFF",
  inputBg: "#FFFFFF",
  shopIcon: "د",
  incomeCard: "#EAF5EE",
  expenseCard: "#FBEAE9",
  debtCard: "#FFF3D8",
  paymentCard: "#EAF0F8",
  supplierCard: "#FFFFFF",
  navButton: "#145A58",
  // ----- الأزرار العلوية والعلامات والظلال (تُحفظ ضمن الثيم وتتوافق مع الثيمات القديمة عبر الدمج مع الافتراضي) -----
  tabBg: "#FFFFFF",              // خلفية هادئة للأزرار الرئيسية العلوية
  tabMarkPos: "top",             // موضع علامة الزر: top | side
  markReports: "#6631DB", markIncomes: "#2F6F4E", markExpenses: "#A6403B", markDebts: "#B5721E", markPayments: "#2563C7", markSuppliers: "#2B6C8F",
  txMarkIncome: "", txMarkExpense: "", txMarkDebt: "", txMarkPayment: "", // فارغ = يتبع لون علامة الزر المقابل
  cardShadowOn: true, cardShadowColor: "#182620",
  btnShadowOn: false, btnShadowColor: "#182620",
  weekLine: "#1A1A2E",           // خط الفصل بين الأسابيع: كحلي داكن ليظهر على أي خلفية
  // رموز تتبدّل مع الوضع الداكن
  surface: "#FFFFFF",       // سطح أبيض (قوائم/ملاحظات)
  solid: "#182620",         // خلفية داكنة لعناصر نصها أبيض (شعار، تبويب نشط، إشعار منبثق)
  onGold: "#FFFFFF",
  dangerBg: "#FBEAE9",
  infoBg: "#EAF0F8",
  okBg: "#E9F8EE",
  okText: "#168A45",
  avatarBg: "#EEF3F0",
  glass: "rgba(255,255,255,0.7)",
  glass2: "rgba(255,255,255,0.5)",
  netText: "#3F7D38",
  incomeText: "#3476A6",
  debtText: "#A87518",
};

export const DARK_PALETTE = {
  bg: "#0F1514", card: "#1C2825", ink: "#F1F5F2", inkSoft: "#AEBBB4", line: "#3E4F49", inputBg: "#22302C", bar: "#092F2E", weekLine: "#E2E8F0",
  surface: "#24332F", tabBg: "#1C2825", solid: "#2C5F58", onGold: "#1B1405", button: "#2F7F73", buttonText: "#FFFFFF", navButton: "#1C6F6B",
  income: "#3B9467", expense: "#CF5A53", receivable: "#3E8FB8", payable: "#C98228", gold: "#C9A23F", paymentBtn: "#3B72D6",
  goldBg: "#3A311B", netBg: "#1F3A28", debtTotalBg: "#3F3418", paymentBg: "#1F3A28", incomeBg: "#1B3347", expenseLight: "#3C2321", invoiceCard: "#202D29",
  incomeCard: "#1B3326", expenseCard: "#3A2220", debtCard: "#3A3119", paymentCard: "#1C2B40", supplierCard: "#1C2825",
  dangerBg: "#3A2220", infoBg: "#1C2B40", okBg: "#1B3326", okText: "#5FD08C", avatarBg: "#24312C", glass: "rgba(255,255,255,0.08)", glass2: "rgba(0,0,0,0.22)",
  netText: "#7CCB78", incomeText: "#7DB8E0", debtText: "#E3B25A",
  reportCards: ["#1F3A28", "#3A2220", "#1B3347", "#3F3418"],
  supplierPaletteA: ["#1C2B40", "#1B3347", "#1C2825"],
  supplierPaletteB: ["#1E3A36", "#223F3A", "#1C2825"],
};

export const THEME_PRESETS = {
  purple: { label: "بنفسجي", colors: {
    bg: "#F3EEFF", card: "#FFFFFF", ink: "#1A1038", inkSoft: "#4A4A6A", line: "#4A4A6A", weekLine: "#1A1A2E",
    bar: "#34117E", button: "#491AB1", buttonText: "#FFFFFF", navButton: "#6631DB", tabBg: "#FFFFFF", markReports: "#6631DB",
    reportCards: ["#E9DEFF", "#E0D2FF", "#D6C4FF", "#CBB6FE"],
    supplierPaletteA: ["#F1E9FF", "#EADFFF", "#F8F4FF"], supplierPaletteB: ["#E3D6FF", "#DCCCFF", "#F0E8FF"],
  } },
  blue: { label: "أزرق", colors: {
    bg: "#EAF7FC", card: "#FFFFFF", ink: "#03045E", inkSoft: "#3D4F6B", line: "#3D4F6B", weekLine: "#1A1A2E",
    bar: "#03045E", button: "#0077B6", buttonText: "#FFFFFF", navButton: "#0077B6", tabBg: "#FFFFFF", markReports: "#0077B6",
    reportCards: ["#DDF4FA", "#CAF0F8", "#B8E9F5", "#A5E1F2"],
    supplierPaletteA: ["#E3F6FB", "#D4F1F9", "#F3FBFE"], supplierPaletteB: ["#CAF0F8", "#BDEBF6", "#E3F6FB"],
  } },
  classic: { label: "الأصلي", colors: {
    bg: "#F6F3EC", card: "#F8F7F2", ink: "#182620", inkSoft: "#4F5F56", line: "#7A8396", weekLine: "#1A1A2E",
    bar: "#0E4D4D", button: "#182620", buttonText: "#FFFFFF", navButton: "#145A58", tabBg: "#FFFFFF", markReports: "#6631DB",
    reportCards: ["#DDF4D8", "#FBEAE9", "#D8EAF9", "#FFE8B8"],
    supplierPaletteA: ["#EAF0F8", "#D8EAF9", "#FFFFFF"], supplierPaletteB: ["#FBF3DF", "#FBEAE9", "#E9F8EE"],
  } },
};


// مجموعات الألوان المتدرجة (كلها فاتحة وقريبة في الإضاءة فلا يظهر كارد أسود بجانب كارد أبيض)
export const BASE_GROUPS = {
  reportCards: [BASE_COLORS.netBg, "#FBEAE9", BASE_COLORS.incomeBg, BASE_COLORS.debtTotalBg],
  supplierPaletteA: ["#EAF0F8", "#D8EAF9", "#FFFFFF"],
  supplierPaletteB: ["#FBF3DF", "#FBEAE9", "#E9F8EE"],
};
