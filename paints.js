// نموذج «الطلاء»: لون واحد بشفافية، أو تدرج خطي متعدد النقاط (لكل نقطة لون وشفافية وموضع).
// دوال نقية بلا React ولا DOM (تُختبر بـ: node paints.test.mjs).
//
// الشكل المخزَّن داخل الثيم:   theme.paints[key] = { kind:"solid", color:"#RRGGBB", alpha:0..1 }
//                                               أو { kind:"linear", angle:0..360, stops:[{ color, alpha, pos:0..100 }, ...≥2] }
// وتبقى theme[key] نفسها لونًا #RRGGBB «فعليًا» (محسوبًا من الطلاء) كي تعمل حسابات التباين والثيمات القديمة كما كانت.
// لا يُخزَّن شيء في paints إلا إذا كان تدرجًا أو لونًا شفافًا، فالثيمات المحفوظة قبل هذا التحديث تبقى صالحة بلا ترحيل.

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const r255 = (x) => clamp(Math.round(x), 0, 255);
const hex2 = (x) => r255(x).toString(16).padStart(2, "0").toUpperCase();

// ---------- تحويلات الألوان ----------
// يقبل #RGB و#RGBA و#RRGGBB و#RRGGBBAA (مع # أو بدونها) وrgb()/rgba()؛ يرجع {r,g,b,a} أو null
export function parseColor(input) {
  const s = String(input ?? "").trim();
  if (!s) return null;
  let m = /^rgba?\(\s*(\d{1,3}(?:\.\d+)?)\s*[, ]\s*(\d{1,3}(?:\.\d+)?)\s*[, ]\s*(\d{1,3}(?:\.\d+)?)\s*(?:[,/]\s*(\d*\.?\d+)(%?)\s*)?\)$/i.exec(s);
  if (m) {
    const a = m[4] === undefined ? 1 : (m[5] ? num(m[4]) / 100 : num(m[4], 1));
    return { r: r255(num(m[1])), g: r255(num(m[2])), b: r255(num(m[3])), a: clamp(a, 0, 1) };
  }
  m = /^#?([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(s);
  if (!m) return null;
  let h = m[1];
  if (h.length <= 4) h = h.split("").map((c) => c + c).join("");
  const n = (i) => parseInt(h.slice(i, i + 2), 16);
  return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
}
export const isColor = (v) => parseColor(v) !== null;
export const toHex6 = ({ r, g, b }) => `#${hex2(r)}${hex2(g)}${hex2(b)}`;
export const toHex8 = (c) => toHex6(c) + hex2(clamp(num(c.a, 1), 0, 1) * 255);
// قيمة CSS: #RRGGBB إن كان معتمًا، وإلا rgba(...)
export function rgbaCss({ r, g, b, a = 1 }) {
  const A = clamp(num(a, 1), 0, 1);
  return A >= 0.999 ? toHex6({ r, g, b }) : `rgba(${r255(r)},${r255(g)},${r255(b)},${+A.toFixed(3)})`;
}

export function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) {
    if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return { h, s: mx ? d / mx : 0, v: mx };
}
export function hsvToRgb(h, s, v) {
  h = ((num(h) % 360) + 360) % 360; s = clamp(num(s), 0, 1); v = clamp(num(v), 0, 1);
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0]; else if (h < 120) [r, g, b] = [x, c, 0]; else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c]; else if (h < 300) [r, g, b] = [x, 0, c]; else [r, g, b] = [c, 0, x];
  return { r: r255((r + m) * 255), g: r255((g + m) * 255), b: r255((b + m) * 255) };
}
export const hsvToHex = (h, s, v) => toHex6(hsvToRgb(h, s, v));
export const hexToHsv = (hex) => { const c = parseColor(hex) || { r: 0, g: 0, b: 0 }; return rgbToHsv(c.r, c.g, c.b); };

export const lerpColor = (c1, c2, t) => ({
  r: c1.r + (c2.r - c1.r) * t, g: c1.g + (c2.g - c1.g) * t, b: c1.b + (c2.b - c1.b) * t, a: num(c1.a, 1) + (num(c2.a, 1) - num(c1.a, 1)) * t,
});
export const mixHex = (a, b, t) => toHex6(lerpColor(parseColor(a) || { r: 0, g: 0, b: 0 }, parseColor(b) || { r: 0, g: 0, b: 0 }, t));

// يضع لونًا (بشفافية) فوق خلفية معتمة ← #RRGGBB الفعلي الذي تراه العين
export function blendOver(fg, alpha, backdrop = "#FFFFFF") {
  const f = parseColor(fg) || { r: 0, g: 0, b: 0, a: 1 };
  const b = parseColor(backdrop) || { r: 255, g: 255, b: 255, a: 1 };
  const A = clamp(num(alpha, 1) * num(f.a, 1), 0, 1);
  return toHex6({ r: f.r * A + b.r * (1 - A), g: f.g * A + b.g * (1 - A), b: f.b * A + b.b * (1 - A) });
}

// ---------- نموذج الطلاء ----------
export const MIN_STOPS = 2, MAX_STOPS = 8;
const normAngle = (a) => ((num(a, 135) % 360) + 360) % 360;

export function solidPaint(color = "#000000", alpha) {
  const c = parseColor(color) || { r: 0, g: 0, b: 0, a: 1 };
  return { kind: "solid", color: toHex6(c), alpha: clamp(alpha === undefined ? num(c.a, 1) : num(alpha, 1), 0, 1) };
}
const normStop = (s) => {
  const c = parseColor(s && s.color) || { r: 0, g: 0, b: 0, a: 1 };
  return { color: toHex6(c), alpha: clamp(s && s.alpha !== undefined ? num(s.alpha, 1) : num(c.a, 1), 0, 1), pos: clamp(num(s && s.pos, 0), 0, 100) };
};
const sortStops = (stops) => stops.map((s, i) => ({ s, i })).sort((a, b) => a.s.pos - b.s.pos || a.i - b.i).map((x) => x.s);

// stops: [[color, pos, alpha?], ...]
export function gradientPaint(angle, stops) {
  return { kind: "linear", angle: normAngle(angle), stops: sortStops(stops.slice(0, MAX_STOPS).map(([color, pos, alpha]) => normStop({ color, pos, alpha }))) };
}

// أي مدخل (نص، كائن قديم، بيانات تالفة) ← طلاء صالح دائمًا
export function normalizePaint(p, fallback = "#000000") {
  if (typeof p === "string") return solidPaint(isColor(p) ? p : fallback);
  if (!p || typeof p !== "object") return solidPaint(fallback);
  if (p.kind === "linear" && Array.isArray(p.stops) && p.stops.length >= MIN_STOPS) {
    return { kind: "linear", angle: normAngle(p.angle), stops: sortStops(p.stops.slice(0, MAX_STOPS).map(normStop)) };
  }
  return solidPaint(isColor(p.color) ? p.color : fallback, p.alpha);
}
export const isGradient = (p) => !!p && p.kind === "linear";
export const isPlainSolid = (p) => { const n = normalizePaint(p); return n.kind === "solid" && n.alpha >= 0.999; };
export const samePaint = (a, b) => JSON.stringify(normalizePaint(a)) === JSON.stringify(normalizePaint(b));

// قيمة CSS لخاصية background
export function paintToCss(p) {
  const n = normalizePaint(p);
  if (n.kind === "solid") return rgbaCss({ ...parseColor(n.color), a: n.alpha });
  const parts = n.stops.map((s) => `${rgbaCss({ ...parseColor(s.color), a: s.alpha })} ${+s.pos.toFixed(2)}%`);
  return `linear-gradient(${+n.angle.toFixed(2)}deg, ${parts.join(", ")})`;
}

// ألوان النقاط كما تُرى فعليًا فوق الخلفية (للتحقق من أسوأ تباين)
export function paintStopHexes(p, backdrop = "#FFFFFF") {
  const n = normalizePaint(p);
  return n.kind === "solid" ? [blendOver(n.color, n.alpha, backdrop)] : n.stops.map((s) => blendOver(s.color, s.alpha, backdrop));
}
const colorAtSorted = (hs, pos) => {
  if (pos <= hs[0].pos) return hs[0].c;
  if (pos >= hs[hs.length - 1].pos) return hs[hs.length - 1].c;
  for (let i = 0; i < hs.length - 1; i++) {
    if (pos <= hs[i + 1].pos) { const span = hs[i + 1].pos - hs[i].pos || 1; return lerpColor(hs[i].c, hs[i + 1].c, (pos - hs[i].pos) / span); }
  }
  return hs[hs.length - 1].c;
};
// لون واحد ممثِّل للطلاء (متوسط التدرج على امتداده): يُخزَّن في theme[key] لتعمل به حسابات التباين
export function paintHex(p, backdrop = "#FFFFFF") {
  const n = normalizePaint(p);
  if (n.kind === "solid") return blendOver(n.color, n.alpha, backdrop);
  const hs = n.stops.map((s) => ({ pos: s.pos, c: parseColor(blendOver(s.color, s.alpha, backdrop)) }));
  let r = 0, g = 0, b = 0; const N = 100;
  for (let i = 0; i <= N; i++) { const c = colorAtSorted(hs, i); r += c.r; g += c.g; b += c.b; }
  return toHex6({ r: r / (N + 1), g: g / (N + 1), b: b / (N + 1) });
}

// ---------- عمليات التدرج (كلها ترجع نسخة جديدة) ----------
// لون التدرج (وشفافيته) عند موضع معيّن، دون مزجه مع خلفية
export function colorAtPos(p, pos) {
  const n = normalizePaint(p);
  if (n.kind === "solid") return { ...parseColor(n.color), a: n.alpha };
  const hs = n.stops.map((s) => ({ pos: s.pos, c: { ...parseColor(s.color), a: s.alpha } }));
  return colorAtSorted(hs, clamp(num(pos), 0, 100));
}
// يضيف نقطة (في أوسع فراغ بين نقطتين إن لم يُحدَّد الموضع) بلون التدرج عندها. يرجع { paint, index } (index = -1 إن امتلأ الحد الأعلى)
export function addStop(p, pos) {
  const n = normalizePaint(p);
  if (n.kind !== "linear" || n.stops.length >= MAX_STOPS) return { paint: n, index: -1 };
  let at = pos;
  if (at === undefined || at === null) {
    let best = -1, gap = -1;
    for (let i = 0; i < n.stops.length - 1; i++) { const g = n.stops[i + 1].pos - n.stops[i].pos; if (g > gap) { gap = g; best = i; } }
    at = best >= 0 ? (n.stops[best].pos + n.stops[best + 1].pos) / 2 : 50;
  }
  at = clamp(Math.round(num(at)), 0, 100);
  const c = colorAtPos(n, at);
  const stops = [...n.stops.map((s) => ({ ...s, __t: false })), { color: toHex6(c), alpha: clamp(num(c.a, 1), 0, 1), pos: at, __t: true }];
  const sorted = stops.map((s, i) => ({ s, i })).sort((a, b) => a.s.pos - b.s.pos || a.i - b.i).map((x) => x.s);
  return { paint: { ...n, stops: sorted.map(({ __t, ...s }) => s) }, index: sorted.findIndex((s) => s.__t) };
}
export function removeStop(p, index) {
  const n = normalizePaint(p);
  if (n.kind !== "linear" || n.stops.length <= MIN_STOPS || index < 0 || index >= n.stops.length) return n;
  return { ...n, stops: n.stops.filter((_, i) => i !== index) };
}
// يعدّل نقطة (color/alpha/pos) ويرجع { paint, index } حيث index هو موضع النقطة الجديد بعد إعادة الترتيب
export function updateStop(p, index, patch) {
  const n = normalizePaint(p);
  if (n.kind !== "linear" || index < 0 || index >= n.stops.length) return { paint: n, index };
  const merged = normStop({ ...n.stops[index], ...patch });
  const stops = n.stops.map((s, i) => (i === index ? { ...merged, __t: true } : { ...s, __t: false }));
  const sorted = stops.map((s, i) => ({ s, i })).sort((a, b) => a.s.pos - b.s.pos || a.i - b.i).map((x) => x.s);
  return { paint: { ...n, stops: sorted.map(({ __t, ...s }) => s) }, index: sorted.findIndex((s) => s.__t) };
}
export const setAngle = (p, deg) => { const n = normalizePaint(p); return n.kind === "linear" ? { ...n, angle: normAngle(deg) } : n; };

// لون واحد ← تدرج من نقطتين (اللون نفسه ثم درجة أفتح/أغمق منه)
export function toGradient(p) {
  const n = normalizePaint(p);
  if (n.kind === "linear") return n;
  const c = parseColor(n.color);
  const light = (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255 > 0.55;
  const second = light ? mixHex(n.color, "#000000", 0.28) : mixHex(n.color, "#FFFFFF", 0.38);
  return gradientPaint(135, [[n.color, 0, n.alpha], [second, 100, n.alpha]]);
}
// تدرج ← لون واحد من إحدى نقاطه
export function toSolid(p, index = 0) {
  const n = normalizePaint(p);
  if (n.kind === "solid") return n;
  const s = n.stops[clamp(index, 0, n.stops.length - 1)];
  return solidPaint(s.color, s.alpha);
}

// ---------- لوحات جاهزة (من لوحتي الألوان البنفسجية والزرقاء المرفقتين) ----------
export const PALETTE_SWATCHES = [
  "#49225B", "#6E3482", "#A56ABD", "#E7DBEF", "#F5EBFA",
  "#34117E", "#491AB1", "#6631DB", "#7B45F0", "#A981FF", "#B796FE", "#D0BCFC",
  "#03045E", "#0077B6", "#00B4D8", "#90E0EF", "#CAF0F8",
  "#FFFFFF", "#182620", "#000000",
];
export const GRADIENT_PRESETS = [
  { id: "plum", label: "عنبي", paint: gradientPaint(135, [["#49225B", 0], ["#6E3482", 50], ["#A56ABD", 100]]) },
  { id: "royal", label: "ملكي", paint: gradientPaint(135, [["#34117E", 0], ["#6631DB", 55], ["#A981FF", 100]]) },
  { id: "dusk", label: "غسق", paint: gradientPaint(45, [["#34117E", 0], ["#6E3482", 40], ["#A56ABD", 70], ["#E7DBEF", 100]]) },
  { id: "lavender", label: "لافندر", paint: gradientPaint(180, [["#D0BCFC", 0], ["#E7DBEF", 100]]) },
  { id: "mist", label: "ضباب", paint: gradientPaint(180, [["#F5EBFA", 0], ["#E7DBEF", 50], ["#D0BCFC", 100]]) },
  { id: "ocean", label: "محيط", paint: gradientPaint(135, [["#03045E", 0], ["#0077B6", 55], ["#00B4D8", 100]]) },
  { id: "sky", label: "سماء", paint: gradientPaint(180, [["#CAF0F8", 0], ["#90E0EF", 100]]) },
  { id: "violet-sea", label: "بنفسجي وأزرق", paint: gradientPaint(135, [["#491AB1", 0], ["#0077B6", 55], ["#00B4D8", 100]]) },
  { id: "glass", label: "زجاجي", paint: gradientPaint(135, [["#FFFFFF", 0, 0.92], ["#D0BCFC", 100, 0.55]]) },
  { id: "night", label: "ليلي", paint: gradientPaint(160, [["#03045E", 0], ["#34117E", 60], ["#491AB1", 100]]) },
];
export const ANGLE_CHOICES = [[0, "↑"], [45, "↗"], [90, "→"], [135, "↘"], [180, "↓"], [225, "↙"], [270, "←"], [315, "↖"]];

// ---------- سجلّ عناصر التخصيص: أيّها يقبل التدرج فعليًا وما الحد الأدنى للشفافية ----------
// gradient:true لا يُكتب إلا لعنصر تُرسمه الواجهة فعليًا بخاصية background (انظر paintBg في App.jsx)
export const PAINT_FIELDS = {
  ink: { gradient: false, minAlpha: 0.5 }, inkSoft: { gradient: false, minAlpha: 0.5 }, buttonText: { gradient: false, alpha: false },
  line: { gradient: false, minAlpha: 0.3 }, // الظل: raw = يبقى اللون الخام في theme[key] والشفافية وحدها هي «قوة الظل» (لا تُمزج مع الخلفية)
  cardShadowColor: { gradient: false, minAlpha: 0.04, raw: true }, btnShadowColor: { gradient: false, minAlpha: 0.04, raw: true },
  bg: { gradient: true }, bar: { gradient: true }, card: { gradient: true }, button: { gradient: true }, navButton: { gradient: false, alpha: false },
  tabBg: { gradient: true },
  markReports: { gradient: true }, markIncomes: { gradient: true }, markExpenses: { gradient: true }, markDebts: { gradient: true }, markPayments: { gradient: true }, markSuppliers: { gradient: true },
  txMarkIncome: { gradient: true }, txMarkExpense: { gradient: true }, txMarkDebt: { gradient: true }, txMarkPayment: { gradient: true },
  weekLine: { gradient: true, minAlpha: 0.6 },
  incomeCard: { gradient: true }, expenseCard: { gradient: true }, debtCard: { gradient: true }, paymentCard: { gradient: true }, supplierCard: { gradient: true },
  "reportCards.0": { gradient: true }, "reportCards.1": { gradient: true }, "reportCards.2": { gradient: true }, "reportCards.3": { gradient: true },
  "supplierPaletteA.0": { gradient: true }, "supplierPaletteB.0": { gradient: true },
};
export const fieldInfo = (key) => PAINT_FIELDS[key] || { gradient: false, minAlpha: 0 };

// ---------- مساعدات الثيم (غير متغيّرة للأصل) ----------
const ARR = /^(\w+)\.(\d+)$/;
export function getHexAt(theme, key) {
  const m = ARR.exec(key);
  return m ? (theme[m[1]] || [])[Number(m[2])] : theme[key];
}
export function setHexAt(theme, key, hex) {
  const m = ARR.exec(key);
  if (!m) return { ...theme, [key]: hex };
  const arr = (theme[m[1]] || []).slice(); arr[Number(m[2])] = hex;
  return { ...theme, [m[1]]: arr };
}
const backdropFor = (theme, key) => (key === "bg" ? (theme.mode === "dark" ? "#0F1514" : "#FFFFFF") : (parseColor(theme.bg) ? toHex6(parseColor(theme.bg)) : "#FFFFFF"));
// الطلاء الفعلي لعنصر: المحفوظ في paints إن وُجد، وإلا اللون العادي theme[key]
export const effectivePaint = (theme, key, fallback = "#000000") => normalizePaint((theme.paints || {})[key] ?? getHexAt(theme, key), fallback);
export const paintCssOf = (theme, key) => paintToCss(effectivePaint(theme, key));
// يضع طلاءً لعنصر: لون معتم عادي ← theme[key] فقط؛ تدرج/شفافية ← paints[key] + لون ممثِّل في theme[key]
export function setPaintInTheme(theme, key, paint) {
  const p = normalizePaint(paint);
  const paints = { ...(theme.paints || {}) };
  if (isPlainSolid(p)) delete paints[key]; else paints[key] = p;
  const info = PAINT_FIELDS[key] || {};
  const hex = isPlainSolid(p) || (info.raw && p.kind === "solid") ? p.color : paintHex(p, backdropFor(theme, key));
  return { ...setHexAt(theme, key, hex), paints };
}
export function clearPaintInTheme(theme, key) {
  const paints = { ...(theme.paints || {}) }; delete paints[key];
  return { ...theme, paints };
}
// ينظّف paints المخزَّنة (بيانات تالفة) ويُعيد حساب اللون الممثِّل لكل عنصر ليبقى متسقًا مع الخلفية الحالية
export function syncPaints(theme) {
  const src = theme && theme.paints && typeof theme.paints === "object" ? theme.paints : {};
  let out = { ...theme }; const paints = {};
  for (const key of Object.keys(src)) {
    if (!(key in PAINT_FIELDS)) continue;
    const p = normalizePaint(src[key], getHexAt(theme, key) || "#000000");
    const info = PAINT_FIELDS[key];
    if (isPlainSolid(p) || (isGradient(p) && !info.gradient) || (p.kind === "solid" && info.alpha === false)) continue; // ما لا يدعمه العنصر يُهمل
    paints[key] = p;
    out = setHexAt(out, key, info.raw && p.kind === "solid" ? p.color : paintHex(p, backdropFor(out, key)));
  }
  return { ...out, paints };
}
