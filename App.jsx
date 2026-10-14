import React, { useState, useMemo, useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { onAuthStateChanged, signInWithEmailAndPassword, signOut } from "firebase/auth";
import { auth } from "./firebase";
import { persist as persistCache, loadCached, setCacheScope } from "./syncCache";
import { buildAgg, reportFromAgg, tsOf } from "./logic";
import {
  parseISO, daysInMonth, defaultFilter, validateFilter, rangeOf, summarize, groupByDay, markWeekBreaks,
  debtSummary, paymentSummary, dayOfWeek, normStatus, isoOf, inRange as dateInRange,
} from "./periods";
import {
  BASE_COLORS, BASE_GROUPS, DARK_PALETTE, THEME_PRESETS, hexA, lum, isLight, readableOn, textOn, legibleOn, cardTone, auditTheme, autoFixTheme, textOnAll, cardToneAll,
} from "./colors";
import {
  normalizePaint, paintToCss, paintStopHexes, setPaintInTheme, clearPaintInTheme, syncPaints, effectivePaint, paintCssOf, fieldInfo, getHexAt,
} from "./paints";
import { accountingDate, inIncomeWindow, closeInstant, incomeDocId, windowHint, windowKind, toMinutes } from "./workday";
import PaintPicker, { PaintSwatch } from "./PaintPicker";
import { compressImage, compressLogo, isImageFile, beginPicking, endPicking, isPicking } from "./imageUtil";
import {
  subscribe, subscribePending, addItem, updateItem, deleteItem, setDataContext, resolveSession, bootstrapAdmin, changeMyPassword,
  subscribeStores, subscribeStoreDoc, saveStoreHours, confirmPaymentTx, updateWorker, deleteWorker, updateStore, touchLogin, verifyGatePin, setGatePin, restoreItem, subscribeAudit, subscribeOwnWorker, getDeviceId, getLocalDeviceState, markDevicePending, registerAdminDevice, checkDeviceAllowed, subscribeAdminDevices, removeAdminDevice, subscribeWorkers, addStore, createWorker, setWorkerActive, migrateLegacy, workerEmail, validUsername,
} from "./dataService";

// ---------- Design tokens ----------
// Background: warm paper (#F6F3EC) · Ink: deep pine (#182620)
// Income: #2F6F4E (green) · Expense: #A6403B (brick) · Receivable("لي"): #2B6C8F (blue)
// Payable("عليّ"): #B5721E (amber-brown) · Net profit accent: #C9A34A (muted gold)
// Text (Arabic): 'Tajawal' · Figures (ledger numbers): monospace, tabular-nums

// COLORS: القيم الحالية للثيم. ink/inkSoft تُخزَّنان كمتغيّري CSS (var(--ink) / var(--ink-soft)) كي يستطيع كل كارد
// تغييرهما محليًا بحسب خلفيته؛ والقيمة الحقيقية (hex) في COLORS.inkHex / COLORS.inkSoftHex.
const COLORS = { ...BASE_COLORS, inkHex: BASE_COLORS.ink, inkSoftHex: BASE_COLORS.inkSoft };
// الطلاءات (تدرج/لون بشفافية) المحفوظة في الثيم: PAINTS[key] = قيمة CSS للخلفية، PAINT_HEXES = ألوان نقاطها الفعلية (لاختيار لون نص مقروء فوقها).
// لا تحتفظ COLORS[key] إلا بلون ممثِّل واحد (#RRGGBB) تعمل به حسابات التباين والعناصر التي لا تقبل التدرج.
const PAINTS = {};
const PAINT_HEXES = new Map();
const paintBg = (key, fallback) => PAINTS[key] || getHexAt(COLORS, key) || fallback;
const paintHexes = (css) => PAINT_HEXES.get(css) || (isHexColor(css) ? [css] : null);

const isHexColor = (v) => /^#[0-9a-fA-F]{6}$/.test(String(v || ""));
const THEME_KEY = "daftar_ui_theme_v3";
const THEME_COLOR_VERSION = 2; // 2: تباين مضمون للنص الثانوي وخط الأسابيع والحدود (ترحيل تلقائي للثيمات المحفوظة)
const DEFAULT_THEME = {
  ...BASE_COLORS,
  ...BASE_GROUPS,
  mode: "light",
  colorV: THEME_COLOR_VERSION,
  categories: ["طعام", "مواصلات", "مواد أولية", "فواتير", "أخرى"],
  paints: {}, // تدرجات وألوان شفافة (paints.js): لا يُخزَّن فيها إلا ما يحتاجها، فتبقى الثيمات المحفوظة سابقًا صالحة دون ترحيل
};
// لوحة الوضع الداكن كاملة: كل لون فاتح (باستيل) له مقابل داكن، وألوان النص/الأزرار أفتح قليلًا لتبقى مقروءة
const DARK_KEYS = Object.keys(DARK_PALETTE);
const baseKeyOf = (k) => String(k).split(".")[0];
// الطلاءات التي تبدّلها لوحة الوضع الداكن (تُحفظ مع نسخة الفاتح) مقابل التي لا يمسّها الوضع (تبقى كما هي)
const splitPaints = (paints) => { const keep = {}, dark = {}; Object.entries(paints || {}).forEach(([k, v]) => { (DARK_KEYS.includes(baseKeyOf(k)) ? dark : keep)[k] = v; }); return { keep, dark }; };
function toggleThemeMode(isDark) {
  const cur = readTheme();
  let next;
  if (isDark) { // داكن ← فاتح: نستعيد ما كان قبل الداكن (بما فيه تخصيصاتك) أو الافتراضي
    const back = cur.lightBackup || {};
    const restore = {}; DARK_KEYS.forEach((k) => { restore[k] = back[k] !== undefined ? back[k] : DEFAULT_THEME[k]; });
    next = { ...cur, ...restore, mode: "light", lightBackup: null, darkV: 2, paints: { ...splitPaints(cur.paints).keep, ...(back.paints || {}) } };
  } else {
    const backup = {}; DARK_KEYS.forEach((k) => { backup[k] = cur[k]; });
    const sp = splitPaints(cur.paints);
    backup.paints = sp.dark;
    next = { ...cur, ...DARK_PALETTE, mode: "dark", lightBackup: backup, darkV: 2, paints: sp.keep };
  }
  return saveTheme(next);
}

function readTheme() {
  try {
    const saved = JSON.parse(localStorage.getItem(THEME_KEY) || "{}");
    let t = { ...DEFAULT_THEME, ...saved };
    // ترحيل واحد: الثيمات المحفوظة قبل نظام التباين قد تحمل خط أسابيع بنفسجيًا أو نصًا ثانويًا باهتًا (أو ذهبيًا باهتًا)؛ نصحّح هذه فقط دون لمس بقية ألوانك
    if (Object.keys(saved).length && saved.colorV !== THEME_COLOR_VERSION) {
      const fx = autoFixTheme(t);
      t = { ...t, weekLine: fx.weekLine, line: fx.line, inkSoft: fx.inkSoft, gold: t.gold === "#B8933A" ? DEFAULT_THEME.gold : t.gold, colorV: THEME_COLOR_VERSION };
    }
    // ترحيل من الوضع الداكن القديم (كان يغيّر 7 ألوان فقط فيظهر نص فاتح على كروت فاتحة)
    if (t.mode === "dark" && t.darkV !== 2) t = { ...t, ...DARK_PALETTE, darkV: 2, lightBackup: t.lightBackup || null };
    return syncPaints(t); // الثيمات القديمة بلا paints تعمل كما هي؛ والبيانات التالفة تُنظَّف
  } catch { return { ...DEFAULT_THEME }; }
}
function applyTheme(theme) {
  Object.assign(COLORS, theme || {});
  COLORS.inkHex = (theme && theme.ink) || COLORS.inkHex || BASE_COLORS.ink;
  COLORS.inkSoftHex = (theme && theme.inkSoft) || COLORS.inkSoftHex || BASE_COLORS.inkSoft;
  // الطلاءات: قيمة CSS لكل عنصر مخصَّص بتدرج أو شفافية + ألوان نقاطها الفعلية فوق الخلفية
  const th = { ...DEFAULT_THEME, ...(theme || {}) };
  Object.keys(PAINTS).forEach((k) => { delete PAINTS[k]; });
  PAINT_HEXES.clear();
  const bgHex = isHexColor(th.bg) ? th.bg : "#FFFFFF";
  Object.entries(th.paints || {}).forEach(([k, spec]) => {
    const css = paintToCss(spec);
    PAINTS[k] = css;
    PAINT_HEXES.set(css, paintStopHexes(spec, k === "bg" ? (th.mode === "dark" ? "#0F1514" : "#FFFFFF") : bgHex));
  });
  COLORS.inkCss = PAINTS.ink || COLORS.inkHex;           // قد تحمل شفافية
  COLORS.inkSoftCss = PAINTS.inkSoft || COLORS.inkSoftHex;
  COLORS.ink = "var(--ink)"; COLORS.inkSoft = "var(--ink-soft)";
  inputStyle.background = theme?.inputBg || (isHexColor(COLORS.card) ? COLORS.card : "#fff");
  inputStyle.border = `1px solid ${theme?.line || COLORS.line}`;
  if (typeof document !== "undefined") {
    document.documentElement.dataset.themeMode = theme?.mode || "light";
    // شفافية لون الظل = قوة الظل (الافتراضي 100% = القوة السابقة نفسها)
    const sa = (k) => (th.paints && th.paints[k] ? normalizePaint(th.paints[k]).alpha : 1);
    const cs = th.cardShadowOn !== false ? hexA(th.cardShadowColor, 0.16 * sa("cardShadowColor")) : null;
    const bs = th.btnShadowOn ? hexA(th.btnShadowColor, 0.28 * sa("btnShadowColor")) : null;
    const st = document.documentElement.style;
    st.setProperty("--card-shadow", cs ? `0 2px 10px ${cs}` : "none");
    st.setProperty("--card-shadow-hover", cs ? `0 8px 22px ${hexA(th.cardShadowColor, 0.24 * sa("cardShadowColor"))}` : "none");
    st.setProperty("--btn-shadow", bs ? `0 3px 10px ${bs}` : "none");
    st.setProperty("--btn-shadow-hover", bs ? `0 6px 16px ${hexA(th.btnShadowColor, 0.36 * sa("btnShadowColor"))}` : "none");
    st.setProperty("--app-bg", PAINTS.bg || theme?.bg || COLORS.bg);
    st.setProperty("--app-card", theme?.card || COLORS.card);
    st.setProperty("--ink", COLORS.inkCss);
    st.setProperty("--ink-soft", COLORS.inkSoftCss);
    st.setProperty("--line", COLORS.line);
    st.setProperty("--app-ink", COLORS.inkHex);
    st.setProperty("--app-bar", theme?.bar || "#0E4D4D");
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", theme?.bar || "#0E4D4D");
  }
}
function saveTheme(theme) {
  const next = syncPaints({ ...DEFAULT_THEME, ...theme });
  try { localStorage.setItem(THEME_KEY, JSON.stringify(next)); } catch {}
  applyTheme(next);
  window.dispatchEvent(new CustomEvent("daftar-theme-change", { detail: next }));
  return next;
}
// يفصل الصورة المضغوطة (dataUrl) عن بيانات المرفق: attachment = {name,type} و image = dataUrl
// (Firestore يرفض القيم undefined، لذلك نضمن null عند عدم وجود مرفق)
function withAttachments(data) {
  const legacy = data.attachment?.dataUrl ? [data.attachment] : [];
  const list = Array.isArray(data.attachments) ? data.attachments : legacy;
  const attachments = list.slice(0, 3).map((a) => {
    const { dataUrl, ...meta } = a || {};
    return dataUrl ? { ...meta, dataUrl } : meta;
  });
  const clean = { ...data };
  delete clean.attachment;
  delete clean.image;
  return { ...clean, attachments };
}

function whatsappNumber(phone) {
  let n = String(phone || "").replace(/\D/g, "");
  if (n.startsWith("0")) n = "213" + n.slice(1);
  return n;
}

function downloadDataUrl(dataUrl, name = "مرفق.jpg") {
  if (!dataUrl) return;
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ---------- يوم العمل (اليوم المحاسبي) ----------
// نهاية نافذة الدخل التي يحددها الأدمن لكل متجر = بداية يوم عمل جديد. وإن عبرت النافذة منتصف الليل (مثل 23:30 → 04:00)
// فما يُسجَّل بعد منتصف الليل حتى وقت النهاية يُنسب إلى اليوم السابق (دخل 13 أكتوبر 02:30 ← يوم 12 أكتوبر).
// المنطق كله في workday.js (مع اختباراته) ولا توجد ساعة ثابتة هنا. ما دام الوقت غير محدد فاليوم هو اليوم الميلادي المحلي.
// التاريخ يُخزَّن مع السجل لحظة إنشائه ولا يُعاد حسابه عند القراءة، فتغيير النافذة لاحقًا لا يمسّ العمليات القديمة.
let DAY_HOURS = { start: "", end: "" };
const setDayHours = (start, end) => { DAY_HOURS = { start: toMinutes(start) === null ? "" : start, end: toMinutes(end) === null ? "" : end }; };
const pad2 = (n) => String(n).padStart(2, "0");
const hhmm = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
const localISO = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const todayISO = () => accountingDate(new Date(), DAY_HOURS);
const nowISO = () => new Date().toISOString();

const BIOMETRIC_KEY = "daftar_admin_native_biometric_enabled";
const WEBAUTHN_CRED_KEY = "daftar_admin_webauthn_cred";

// Capacitor Android/iOS: use the OS biometric prompt. Browser/PWA: keep the
// existing WebAuthn path so the same project still works on the web.
import { Capacitor } from "@capacitor/core";
import { NativeBiometric } from "@rolster/capacitor-native-biometric";

function isNativeCapacitor() {
  return Capacitor.isNativePlatform();
}
function webAuthnSupported() {
  return typeof window !== "undefined" && window.isSecureContext && !!window.PublicKeyCredential && !!navigator.credentials;
}
function hasBiometricCredential() {
  try {
    return localStorage.getItem(BIOMETRIC_KEY) === "1" && (isNativeCapacitor() ? !!NativeBiometric : (webAuthnSupported() && !!localStorage.getItem(WEBAUTHN_CRED_KEY)));
  } catch { return false; }
}
function biometricErrorMessage(e) {
  const name = e?.name || "";
  const msg = String(e?.message || e || "");
  if (/cancel|user.*cancel|dismiss/i.test(msg) || name === "NotAllowedError") return "تم إلغاء التحقق بالبصمة";
  if (name === "InvalidStateError") return "بصمة الأدمن على هذا الجهاز غير صالحة — أعد تفعيلها من كلمة المرور";
  if (name === "NotSupportedError" || name === "SecurityError") return "البصمة غير مدعومة على هذا الجهاز";
  return msg || "تعذّر التحقق بالبصمة";
}
// فتح نافذة البصمة يُخفي صفحة التطبيق (visibilitychange) فكان القفل التلقائي يعيد قفله؛ نمنع ذلك أثناء النافذة فقط
async function withBiometricGuard(fn) {
  beginPicking();
  try { return await fn(); }
  finally { setTimeout(endPicking, 1500); }
}
const b64enc = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const b64dec = (str) => Uint8Array.from(atob(str), (c) => c.charCodeAt(0));

async function nativePrompt() {
  if (!NativeBiometric || typeof NativeBiometric.isAvailable !== "function" || typeof NativeBiometric.verifyIdentity !== "function") {
    throw new Error("مكوّن البصمة غير موجود في هذا الإصدار — أعد بناء التطبيق بعد npx cap sync android");
  }
  let av;
  try { av = await NativeBiometric.isAvailable(); } catch { throw new Error("تعذّر الوصول إلى البصمة على هذا الجهاز"); }
  if (!av?.isAvailable) throw new Error("لا توجد بصمة مسجّلة على هذا الهاتف — أضف بصمتك من إعدادات الهاتف أولًا");
  await withBiometricGuard(() => NativeBiometric.verifyIdentity({
    reason: "فتح تطبيق دفتر",
    title: "التحقق من الهوية",
    subtitle: "استخدم بصمة إصبعك لفتح التطبيق",
    description: "تأكيد هوية مدير التطبيق",
    useFallback: true,
    maxAttempts: 3,
  }));
  return true;
}

// التفعيل يطلب بصمة فعلية الآن: إن لم تعمل على هذا الهاتف يظهر السبب فورًا ولا يُفعَّل شيء
async function registerAdminBiometric() {
  if (isNativeCapacitor()) {
    await nativePrompt();
    localStorage.setItem(BIOMETRIC_KEY, "1");
    return true;
  }
  if (!webAuthnSupported()) throw new Error("البصمة غير متاحة في هذا المتصفح؛ استخدم HTTPS أو نسخة APK.");
  const cred = await withBiometricGuard(() => navigator.credentials.create({ publicKey: {
    challenge: crypto.getRandomValues(new Uint8Array(32)),
    rp: { name: "دفتر" },
    user: { id: crypto.getRandomValues(new Uint8Array(16)), name: "admin@daftar.local", displayName: "مدير دفتر" },
    pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
    authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required" },
    timeout: 60000,
    attestation: "none",
  }}));
  if (!cred) throw new Error("تعذّر إنشاء بصمة الأدمن");
  // نحفظ معرّف الاعتماد: التحقق لاحقًا يطلبه صراحة (بدونه كانت أغلب الهواتف ترفض الطلب)
  localStorage.setItem(WEBAUTHN_CRED_KEY, b64enc(cred.rawId));
  localStorage.setItem(BIOMETRIC_KEY, "1");
  return true;
}
async function verifyAdminBiometric() {
  if (isNativeCapacitor()) {
    if (!localStorage.getItem(BIOMETRIC_KEY)) throw new Error("لم يتم تفعيل بصمة الأدمن بعد");
    return nativePrompt();
  }
  if (!webAuthnSupported()) throw new Error("البصمة غير متاحة في هذا المتصفح");
  const saved = localStorage.getItem(WEBAUTHN_CRED_KEY);
  if (!saved) throw new Error("فعّل البصمة من الإعدادات من جديد");
  const result = await withBiometricGuard(() => navigator.credentials.get({ publicKey: {
    challenge: crypto.getRandomValues(new Uint8Array(32)),
    allowCredentials: [{ type: "public-key", id: b64dec(saved), transports: ["internal"] }],
    userVerification: "required",
    timeout: 60000,
  }}));
  return !!result;
}

// هوية المتجر (شعار مرفوع أو أيقونة) تُشارَك بين الرأس والقائمة وملف المتجر
let _brand = { logo: "", icon: "" };
const _brandSubs = new Set();
function setBrand(b) {
  if (b.logo === _brand.logo && b.icon === _brand.icon) return;
  _brand = b; _brandSubs.forEach((f) => f());
}
function useBrand() {
  const [b, setB] = useState(_brand);
  useEffect(() => { const f = () => setB(_brand); _brandSubs.add(f); f(); return () => { _brandSubs.delete(f); }; }, []);
  return b;
}
function StoreMark({ size = 40, radius = 12, bg, color, fontSize }) {
  const b = useBrand();
  const st = { width: size, height: size, borderRadius: radius, background: bg || "rgba(255,255,255,.14)", color: color || "inherit", fontSize: fontSize || Math.round(size * 0.5) };
  return b.logo
    ? <img src={b.logo} alt="" draggable="false" className="object-cover shrink-0" style={{ width: size, height: size, borderRadius: radius, background: "#fff" }} />
    : <div className="flex items-center justify-center font-black shrink-0 select-none" style={st}>{b.icon || COLORS.shopIcon || "د"}</div>;
}

// رقم الإصدار (يُحقن عند البناء) وعدّاد العمليات التي لم تُرفع بعد
const APP_VERSION = typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "dev";
function usePendingCount() {
  const [n, setN] = useState(0);
  useEffect(() => subscribePending(setN), []);
  return n;
}
function PendingWarn({ n }) {
  if (!n) return null;
  return <p className="text-[13px] leading-6 mb-4 rounded-xl p-3 font-bold" style={{ background: "#FBEAE9", color: COLORS.expense }}>⚠️ يوجد {n} عملية لم تُرفع إلى الخادم بعد. ابقَ متصلًا بالإنترنت حتى تختفي ثم اخرج.</p>;
}
function VersionFooter({ n }) {
  return <div className="px-4 pt-4 text-center text-[11px]" style={{ color: COLORS.inkSoft }}>الإصدار {APP_VERSION}{n > 0 ? ` · ⏳ ${n} بانتظار الرفع` : ""}</div>;
}

// رمز القفل السريع: يُخزَّن مجزّأً (SHA-256 + ملح) لا نصًا صريحًا
const hex = (buf) => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, "0")).join("");
const sha256Hex = async (t) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)));
async function makeLockRecord(pin) {
  const salt = hex(crypto.getRandomValues(new Uint8Array(8)));
  return `${salt}:${await sha256Hex(`${salt}:${pin}`)}`;
}
async function checkLockRecord(rec, pin) {
  if (!rec || !pin) return false;
  if (!rec.includes(":")) return rec === pin; // سجل قديم نصي (يُرحَّل تلقائيًا)
  const [salt, h] = rec.split(":");
  return (await sha256Hex(`${salt}:${pin}`)) === h;
}

// أرقام لاتينية 0-9 دائمًا، والسالب يُكتب -500 (علامة LRM تمنع انقلابه إلى 500- في الواجهة العربية)
const toLatinDigits = (str) => String(str ?? "").replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d)).replace(/[۰-۹]/g, (d) => "۰۱۲۳۴۵۶۷۸۹".indexOf(d));
function fmtMoney(n) {
  const v = Number(n) || 0;
  return (v < 0 ? "\u200E-" : "") + Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 0 }) + " دج";
}
// تاريخ نصي YYYY-MM-DD يُقرأ كما هو (بدون تحويل UTC الذي كان يُزيح اليوم أحيانًا)؛ غير ذلك يُقرأ بالتوقيت المحلي
function dateParts(v) {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v) ? null : { y: v.getFullYear(), m: v.getMonth() + 1, d: v.getDate() };
  const str = String(v);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
  if (m) return { y: +m[1], m: +m[2], d: +m[3] };
  const d = new Date(str);
  return isNaN(d) ? null : { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() };
}
// LRI/PDI تعزل التاريخ فلا يعكسه اتجاه RTL ولا يلتصق اليوم بالشهر (تُستعمل للعرض فقط؛ التصدير يستعمل ISO الخام)
const LRI = "\u2066", PDI = "\u2069";
function fmtDate(v) {
  const p = dateParts(v);
  return p ? `${LRI}${pad2(p.d)}/${pad2(p.m)}/${p.y}${PDI}` : "—";
}
function fmtDateTime(v) {
  const p = dateParts(v);
  if (!p) return "—";
  const d = v instanceof Date ? v : new Date(v);
  const t = isNaN(d) || /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? "" : ` ${LRI}${pad2(d.getHours())}:${pad2(d.getMinutes())}${PDI}`;
  return fmtDate(v) + t;
}

// Ledger-style number span
function Fig({ children, className = "", style = {} }) {
  return (
    <span
      className={className}
      style={{ fontFamily: "'JetBrains Mono','Menlo',monospace", fontVariantNumeric: "tabular-nums", fontWeight: 600, ...style }}
    >
      {children}
    </span>
  );
}

function debtStatusLabel(s) {
  return { unpaid: "غير مسدد", partial: "مسدد جزئيًا", paid: "مسدد بالكامل" }[s] || s;
}
function debtStatusColor(s) {
  return { unpaid: COLORS.expense, partial: COLORS.payable, paid: COLORS.income }[s] || COLORS.inkSoft;
}
function paymentStatusLabel(s) {
  return { pending: "قيد المراجعة", confirmed: "مؤكد", rejected: "مرفوض" }[s] || s;
}
function supportStatusLabel(s) {
  return { new: "جديد", in_review: "قيد المراجعة", resolved: "تم الحل", rejected: "مرفوض" }[s] || s;
}

// ---------- Small UI atoms ----------
// يُمرَّر onClick (وأي خصائص أخرى مثل onKeyDown) إلى الـ div مباشرة — من دون هذا
// التمرير، أي <Card onClick={...}> لا يفتح شيئًا عند الضغط (وهذا كان سبب تعطّل
// فتح بطاقة المورد سابقًا). عند وجود onClick تُضاف أيضًا role/tabIndex ودعم
// لوحة المفاتيح (Enter/Space) لتبقى البطاقة قابلة للتفعيل بأكثر من طريقة.
function Card({ children, className = "", style = {}, onClick, ...rest }) {
  const interactive = typeof onClick === "function";
  // لون نص الكارد يُحسب من خلفيته: خلفية غامقة ← نص فاتح، فاتحة ← داكن، والنص الثانوي يُقرَّب حتى يبلغ تباين 4.5
  const bg = style.background !== undefined ? style.background : paintBg("card");
  const hexes = paintHexes(String(bg)); // لون واحد، أو نقاط التدرج: يُراعى أسوأ نقطة
  const tone = hexes ? cardToneAll(hexes, COLORS.inkHex, COLORS.inkSoftHex) : null;
  // إن بقي النص بلونه المختار استُعملت قيمته الأصلية (قد تحمل شفافية)، وإلا اللون المعدَّل للتباين
  const vars = tone ? { "--ink": tone.ink === COLORS.inkHex ? COLORS.inkCss : tone.ink, "--ink-soft": tone.soft === COLORS.inkSoftHex ? COLORS.inkSoftCss : tone.soft, color: "var(--ink)" } : null;
  return (
    <div
      className={`rounded-2xl ui-card ${className}`}
      style={{ background: paintBg("card"), border: `1px solid ${COLORS.line}`, ...vars, ...style }}
      onClick={onClick}
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      onKeyDown={interactive ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(e); } } : undefined}
      {...rest}
    >
      {children}
    </div>
  );
}

function Button({ children, onClick, variant = "primary", className = "", type = "button", disabled }) {
  const base = "px-4 py-2.5 rounded-xl text-[14px] font-bold ui-button transition active:scale-[0.98] disabled:opacity-40 disabled:active:scale-100";
  const styles = {
    primary: { background: paintBg("button", COLORS.inkHex), color: textOnAll(paintHexes(paintBg("button", COLORS.inkHex)) || [COLORS.button || COLORS.inkHex], COLORS.buttonText || "#FFFFFF", 3) },
    ghost: { background: "transparent", color: COLORS.ink, border: `1px solid ${COLORS.line}` },
    income: { background: COLORS.income, color: textOn(COLORS.income, "#FFFFFF", 3) },
    expense: { background: COLORS.expense, color: textOn(COLORS.expense, "#FFFFFF", 3) },
    danger: { background: COLORS.expense, color: textOn(COLORS.expense, "#FFFFFF", 3), border: `1px solid ${COLORS.expense}` },
    gold: { background: COLORS.gold, color: textOn(COLORS.gold, COLORS.onGold || "#FFFFFF", 3) },
    debt: { background: COLORS.debtBtn, color: textOn(COLORS.debtBtn, "#182620", 3) },
    payment: { background: COLORS.paymentBtn, color: textOn(COLORS.paymentBtn, "#FFFFFF", 3) },
  };
  return (
    <button type={type} disabled={disabled} onClick={onClick} className={`${base} ${className}`} style={styles[variant]}>
      {children}
    </button>
  );
}

function Field({ label, children }) {
  return (
    <label className="block mb-3">
      <span className="block text-[13px] mb-1 font-bold" style={{ color: COLORS.inkSoft }}>{label}</span>
      {children}
    </label>
  );
}

const inputCls =
  "w-full rounded-xl px-3 py-2.5 text-[15px] outline-none focus:ring-2 transition";
const inputStyle = { border: `1px solid ${COLORS.line}`, background: COLORS.inputBg || "#fff" };
applyTheme(readTheme());

function TextInput(props) {
  const { onChange, type, ...rest } = props;
  const numeric = type === "number" || props.inputMode === "numeric" || props.inputMode === "decimal" || type === "tel";
  // الأرقام العربية/الهندية المكتوبة من لوحة المفاتيح تتحول إلى 0-9 فورًا
  const handle = onChange && type !== "number" ? (e) => { const v = e.target.value, n = toLatinDigits(v); if (n !== v) e.target.value = n; onChange(e); } : onChange;
  return <input {...rest} type={type} onChange={handle} lang={numeric ? "en" : props.lang} className={inputCls} style={{ ...inputStyle, ...(props.style || {}) }} dir={props.dir ?? (numeric ? "ltr" : undefined)} />;
}
function TextArea(props) {
  const { onChange, ...rest } = props;
  const handle = onChange ? (e) => { const v = e.target.value, n = toLatinDigits(v); if (n !== v) e.target.value = n; onChange(e); } : onChange;
  return <textarea {...rest} onChange={handle} className={inputCls} style={inputStyle} rows={props.rows || 3} />;
}

// يُرسم في document.body: أي أب فيه transform/animation (مثل صفحات الأدمن) كان يحبس النافذة تحت الشريط العلوي
function Modal({ title, onClose, children, wide, zClass = "z-50" }) {
  return createPortal(
    <div dir="rtl" lang="ar" className={`fixed inset-0 ${zClass} flex items-end sm:items-center justify-center`} style={{ background: "rgba(24,38,32,0.45)", fontFamily: "'Tajawal','Segoe UI',Tahoma,sans-serif", color: COLORS.ink }} onClick={onClose}>
      <div
        className={`w-full ${wide ? "sm:max-w-lg" : "sm:max-w-md"} rounded-t-3xl sm:rounded-3xl max-h-[90vh] overflow-y-auto`}
        style={{ background: COLORS.bg }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 sticky top-0 z-10" style={{ background: COLORS.bg, borderBottom: `1px solid ${COLORS.line}` }}>
          <h3 className="text-[17px] font-extrabold" style={{ color: /حذف|خروج|تنبيه|تحذير/.test(title) ? COLORS.expense : COLORS.ink }}>{title}</h3>
          <button onClick={onClose} aria-label="إغلاق" className="w-8 h-8 rounded-full flex items-center justify-center" style={{ background: COLORS.card, color: COLORS.inkSoft }}>✕</button>
        </div>
        <div className="p-5" style={{ paddingBottom: "max(1.25rem, env(safe-area-inset-bottom))" }}>{children}</div>
      </div>
    </div>,
    document.body
  );
}

function FileAttach({ files = [], onChange, label = "إرفاق فواتير أو صور (اختياري)" }) {
  const inputId = useId();
  const cameraId = useId();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const addFiles = async (picked) => {
    const list = Array.from(picked || []).slice(0, 3 - files.length);
    endPicking();
    if (!list.length) return;
    setBusy(true); setErr("");
    const out = [];
    let lastErr = "";
    for (const f of list) {
      try {
        if (!isImageFile(f)) throw new Error("الرجاء اختيار صور فقط للفواتير");
        out.push(await compressImage(f));
      } catch (e) { lastErr = e?.message || "تعذّر تجهيز الصورة"; }
    }
    if (out.length) onChange([...(files || []), ...out].slice(0, 3));
    setErr(lastErr);
    setBusy(false);
  };
  const onPick = async (e) => { const picked = Array.from(e.target.files || []); e.target.value = ""; await addFiles(picked); };
  const full = files.length >= 3;
  return (
    <Field label={`${label} — حتى 3 صور`}>
      <div className="grid grid-cols-2 gap-2">
        <label htmlFor={inputId} className="flex items-center justify-center gap-2 rounded-xl px-3 py-3 text-[14px] font-bold cursor-pointer" style={{ border: `1.5px dashed ${COLORS.line}`, background: COLORS.card, color: COLORS.inkSoft, opacity: full ? .5 : 1 }}>
          📎 اختيار الصور
        </label>
        <label htmlFor={cameraId} className="flex items-center justify-center gap-2 rounded-xl px-3 py-3 text-[14px] font-bold cursor-pointer" style={{ border: `1.5px dashed ${COLORS.line}`, background: COLORS.goldBg, color: COLORS.ink, opacity: full ? .5 : 1 }}>
          📷 تصوير فاتورة
        </label>
      </div>
      <input id={inputId} type="file" accept="image/*" multiple disabled={full} onClick={beginPicking} onCancel={endPicking} onChange={onPick} className="sr-only" />
      <input id={cameraId} type="file" accept="image/*" capture="environment" disabled={full} onClick={beginPicking} onCancel={endPicking} onChange={onPick} className="sr-only" />
      {busy && <p className="text-[12px] mt-2" style={{ color: COLORS.inkSoft }}>جارٍ تجهيز الصور...</p>}
      {!!files.length && <div className="grid grid-cols-3 gap-2 mt-2">
        {files.map((f, i) => <div key={i} className="relative">
          <img src={f.dataUrl} alt={f.name || `صورة ${i+1}`} className="w-full aspect-square object-cover rounded-xl" />
          <button type="button" onClick={() => onChange(files.filter((_, idx) => idx !== i))} className="absolute top-1 left-1 w-7 h-7 rounded-full text-white bg-black/60">×</button>
        </div>)}
      </div>}
      {err && <p className="text-[12px] mt-1" style={{ color: COLORS.expense }}>{err}</p>}
    </Field>
  );
}

// نافذة الفاتورة العائمة: 9:16 عمودية في المنتصف، هامش 4 مم من الجانبين، تمويه خلفها.
// تكبير وتصغير بإصبعين (Pinch)، وتحريك بإصبع واحد عند التكبير، ونقرتان للتبديل. تعود للوضع الافتراضي عند إعادة الفتح.
function InvoiceViewer({ file, onClose }) {
  const box = useRef(null);
  const ptrs = useRef(new Map());
  const g = useRef({});
  const [t, setT] = useState({ s: 1, x: 0, y: 0 });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const k = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  // يمنع خروج الصورة المكبّرة خارج إطار النافذة
  const clamp = (s, x, y) => {
    const el = box.current; const w = el?.offsetWidth || 300, h = el?.offsetHeight || 500;
    const mx = ((s - 1) * w) / 2, my = ((s - 1) * h) / 2;
    return { s, x: Math.max(-mx, Math.min(mx, x)), y: Math.max(-my, Math.min(my, y)) };
  };
  const dist = () => { const [a, b] = [...ptrs.current.values()]; return Math.hypot(a.x - b.x, a.y - b.y) || 1; };
  const down = (e) => {
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
    ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    setBusy(true);
    g.current = ptrs.current.size === 2 ? { mode: "pinch", d0: dist(), s0: t.s, x0: t.x, y0: t.y } : { mode: "pan", sx: e.clientX, sy: e.clientY, x0: t.x, y0: t.y };
  };
  const move = (e) => {
    if (!ptrs.current.has(e.pointerId)) return;
    ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const G = g.current;
    if (ptrs.current.size >= 2 && G.mode === "pinch") setT(clamp(Math.min(5, Math.max(1, (G.s0 * dist()) / G.d0)), G.x0, G.y0));
    else if (G.mode === "pan" && t.s > 1) setT(clamp(t.s, G.x0 + e.clientX - G.sx, G.y0 + e.clientY - G.sy));
  };
  const up = (e) => {
    ptrs.current.delete(e.pointerId);
    if (ptrs.current.size === 1) { const p = [...ptrs.current.values()][0]; g.current = { mode: "pan", sx: p.x, sy: p.y, x0: t.x, y0: t.y }; }
    if (ptrs.current.size === 0) setBusy(false);
    if (t.s < 1.03) setT({ s: 1, x: 0, y: 0 });
  };
  return createPortal(
    <div dir="rtl" className="fixed inset-0 z-[120] flex items-center justify-center" onClick={onClose}
      style={{ background: "rgba(0,0,0,0.4)", backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)", padding: "0 4mm" }}>
      <div ref={box} onClick={(e) => e.stopPropagation()} className="relative rounded-2xl shadow-2xl"
        style={{ aspectRatio: "9 / 16", width: "min(100%, 420px, calc((100dvh - 1.2cm) * 0.5625))", background: "#fff", overflow: "hidden", touchAction: "none" }}>
        <img src={file.dataUrl} alt={file.name || "فاتورة"} draggable={false}
          onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
          onDoubleClick={() => setT((c) => (c.s > 1 ? { s: 1, x: 0, y: 0 } : clamp(2.5, 0, 0)))}
          style={{ width: "100%", height: "100%", objectFit: "contain", userSelect: "none", transform: `translate(${t.x}px, ${t.y}px) scale(${t.s})`, transition: busy ? "none" : "transform .15s ease-out", cursor: t.s > 1 ? "grab" : "zoom-in" }} />
        <button onClick={onClose} aria-label="إغلاق" className="absolute top-1.5 left-1.5 w-8 h-8 rounded-full flex items-center justify-center text-[16px] font-bold" style={{ background: "rgba(0,0,0,0.55)", color: "#fff" }}>×</button>
      </div>
    </div>,
    document.body
  );
}

function AttachmentsView({ item, admin = false }) {
  const [view, setView] = useState(null);
  const files = Array.isArray(item?.attachments) ? item.attachments : (item?.image ? [{ name: item.attachment?.name || "مرفق", dataUrl: item.image }] : []);
  if (!files.length) return null;
  return <>
    <div className="mt-2 grid grid-cols-3 gap-2">{files.map((f, i) => <div key={i}>
      <button type="button" onClick={(e) => { e.stopPropagation(); setView(f); }} className="block w-full" aria-label="عرض الفاتورة">
        <img src={f.dataUrl} alt={f.name || `مرفق ${i+1}`} className="w-full aspect-square object-cover rounded-xl" />
      </button>
      {admin && f.dataUrl && <button type="button" onClick={() => downloadDataUrl(f.dataUrl, f.name || `invoice-${i+1}.jpg`)} className="w-full mt-1 text-[11px] font-bold rounded-lg py-1.5" style={{ background: COLORS.goldBg, color: COLORS.ink }}>⬇ تنزيل</button>}
    </div>)}</div>
    {view && <InvoiceViewer file={view} onClose={() => setView(null)} />}
  </>;
}

// ---------- Session cache (يسمح بفتح التطبيق بلا إنترنت دون إعادة التحقق) ----------
// مفاتيح التخزين المحلي الخاصة بالمستخدم: لا يشترك فيها حسابان على الهاتف نفسه
const uKey = (base) => `${base}_${auth.currentUser?.uid || "anon"}`;
const SESSION_KEY = "daftar_session_v1";
function readSession() { try { return JSON.parse(localStorage.getItem(SESSION_KEY) || "null"); } catch { return null; } }
function saveSession(s) { try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch {} }
function clearSession() { try { localStorage.removeItem(SESSION_KEY); } catch {} }

function authErrorMessage(e) {
  const code = e?.code || "";
  if (/invalid-credential|user-not-found|wrong-password|invalid-login/.test(code)) return "بيانات الدخول غير صحيحة";
  if (code === "auth/too-many-requests") return "محاولات كثيرة، انتظر قليلًا ثم أعد المحاولة";
  if (code === "auth/network-request-failed") return "تحقق من الاتصال بالإنترنت";
  if (code === "auth/email-already-in-use") return "اسم الدخول أو البريد مستخدم من قبل";
  if (code === "auth/weak-password") return "كلمة المرور قصيرة — 6 رموز على الأقل";
  if (code === "auth/invalid-email") return "صيغة البريد غير صحيحة";
  if (code === "auth/operation-not-allowed") return "فعّل تسجيل الدخول بالبريد وكلمة المرور من Firebase Console";
  if (code === "auth/requires-recent-login") return "سجّل الخروج ثم الدخول وأعد المحاولة";
  if (code === "permission-denied" || code === "firestore/permission-denied") return "لا تملك صلاحية تنفيذ هذا الإجراء";
  return e?.message || "حدث خطأ غير متوقع";
}

// ================= APP =================
export default function App() {
  const [session, setSession] = useState(() => readSession());
  const [authState, setAuthState] = useState("loading"); // loading | out | in
  const [loginError, setLoginError] = useState("");
  const [locked, setLocked] = useState(false);
  const [lockPass, setLockPass] = useState("");
  const [lockError, setLockError] = useState("");
  const [biometricBusy, setBiometricBusy] = useState(false);
  const [biometricReady, setBiometricReady] = useState(false);
  const [toast, setToast] = useState(null);
  const [theme, setTheme] = useState(() => readTheme());
  const pinKey = `daftar_admin_backup_pin_${session?.uid || "anon"}`;
  const [adminPin, setAdminPin] = useState("");
  useEffect(() => {
    (async () => {
      try {
        const raw = localStorage.getItem(pinKey) ?? localStorage.getItem("daftar_admin_backup_pin") ?? "";
        if (raw && !raw.includes(":")) { // ترحيل الرمز النصي القديم إلى مجزّأ
          const rec = await makeLockRecord(raw);
          localStorage.setItem(pinKey, rec); localStorage.removeItem("daftar_admin_backup_pin");
          setAdminPin(rec);
        } else setAdminPin(raw);
      } catch {}
    })();
  }, [pinKey]);
  const suppressAuth = useRef(false);   // أثناء إنشاء حساب الأدمن الأول
  const freshLogin = useRef(false);     // دخول يدوي الآن: لا حاجة لقفل الأدمن فورًا

  const [stores, setStores] = useState([]);
  const [workers, setWorkers] = useState([]);
  const [adminStoreId, setAdminStoreId] = useState(() => { try { return localStorage.getItem("daftar_admin_store") || ""; } catch { return ""; } });

  const [incomes, setIncomes] = useState([]);
  const [expenses, setExpenses] = useState([]);
  const [debts, setDebts] = useState([]);
  const [payments, setPayments] = useState([]);
  const [supportRequests, setSupportRequests] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [supplierTransactions, setSupplierTransactions] = useState([]);
  const [cache, setCache] = useState(null);
  const [isOnline, setIsOnline] = useState(typeof navigator === "undefined" ? true : navigator.onLine);
  const rootPending = usePendingCount();

  const isAdmin = session?.role === "admin";
  const [, setTick] = useState(0);
  // إعادة رسم كل 30 ثانية كي يبدأ اليوم الجديد ويُقفل الدخل في وقته دون إعادة فتح التطبيق
  useEffect(() => { const t = setInterval(() => setTick((x) => x + 1), 30000); return () => clearInterval(t); }, []);
  // ----- أجهزة الأدمن: يتذكر الهاتف ظهور فورم الأدمن -----
  const [deviceAllowed, setDeviceAllowed] = useState(() => getLocalDeviceState() !== "");
  useEffect(() => { if (authState === "out") checkDeviceAllowed().then(setDeviceAllowed).catch(() => {}); }, [authState]);
  useEffect(() => {
    if (authState === "in" && isAdmin && getLocalDeviceState() === "pending") registerAdminDevice().then(() => setDeviceAllowed(true)).catch(() => {});
  }, [authState, isAdmin]);

  // ----- الدخول بالبصمة كخيار أول (يُفعَّل من الإعدادات) -----
  const bioKey = `daftar_bio_auto_${session?.uid || "anon"}`;
  const [bioAuto, setBioAuto] = useState(false);
  useEffect(() => { try { setBioAuto(localStorage.getItem(bioKey) === "1"); } catch {} }, [bioKey]);
  const bioTried = useRef(false);
  useEffect(() => {
    if (!locked) { bioTried.current = false; return; }
    if (isAdmin && bioAuto && biometricReady && !bioTried.current) { bioTried.current = true; tryBiometricUnlock(); }
  }, [locked, isAdmin, bioAuto, biometricReady]);
  async function toggleBio(on) {
    if (on) {
      try { await registerAdminBiometric(); setBiometricReady(true); localStorage.setItem(bioKey, "1"); setBioAuto(true); showToast("تم تفعيل الدخول بالبصمة"); }
      catch (e) { showToast(biometricErrorMessage(e)); }
    } else { try { localStorage.setItem(bioKey, "0"); } catch {} setBioAuto(false); showToast("تم إيقاف الدخول بالبصمة"); }
  }
  const [workerBrand, setWorkerBrand] = useState(() => ({ logo: "", icon: "" }));
  const [workerHours, setWorkerHours] = useState({ incomeStart: "", incomeEnd: "", hoursSetAt: "", createdAt: "" });
  const [incomesReady, setIncomesReady] = useState(false);
  const storeId = authState !== "in" ? "" : (isAdmin ? adminStoreId : session?.storeId || "");
  useEffect(() => {
    if (authState !== "in") { setBrand({ logo: "", icon: "" }); return; }
    const cs = isAdmin ? stores.find((x) => x.id === adminStoreId) : null;
    setBrand(isAdmin ? { logo: cs?.logo || "", icon: cs?.icon || "" } : workerBrand);
  }, [authState, isAdmin, stores, adminStoreId, workerBrand]);
  const currentStore = isAdmin ? stores.find((s) => s.id === adminStoreId) : { id: session?.storeId, name: session?.storeName };
  const hours = isAdmin
    ? { incomeStart: currentStore?.incomeStart || "", incomeEnd: currentStore?.incomeEnd || "", hoursSetAt: currentStore?.hoursSetAt || "", createdAt: currentStore?.createdAt || "" }
    : workerHours;
  setDayHours(hours.incomeStart, hours.incomeEnd);
  // سياق الحفظ يُحدَّث مع كل رسم كي لا تُحفظ عملية بمتجر خاطئ
  setDataContext({ storeId, workerId: session?.uid || "", workerName: session?.workerName || "", isAdmin });

  // ----- الجلسة -----
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (suppressAuth.current) return;
      if (!user) { clearSession(); setSession(null); setAuthState("out"); return; }
      try {
        const s = await resolveSession(user);
        if (!s) { setLoginError("هذا الحساب غير مسجّل في التطبيق"); await signOut(auth); return; }
        if (s.blocked) { setLoginError("حسابك موقوف — راجع الأدمن"); await signOut(auth); return; }
        if (s.role === "admin" && !freshLogin.current) setLocked(true);
        else if (s.role !== "admin") setLocked(false); // العامل لا يُقفَل ولا تُطلب منه بصمة أبدًا
        freshLogin.current = false;
        setLoginError("");
        saveSession(s); setSession(s); setAuthState("in");
        if (s.role === "worker") touchLogin(s.uid).catch(() => {});
      } catch (e) {
        const cached = readSession();
        if (cached && cached.uid === user.uid) { setSession(cached); setAuthState("in"); if (cached.role === "admin") setLocked(true); }
        else { setLoginError("تعذّر التحقق من الحساب — تحقق من الاتصال"); setAuthState("out"); }
      }
    });
    return unsub;
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const on = () => setIsOnline(true);
    const off = () => setIsOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); };
  }, []);

  // قفل الأدمن عند إخفاء التطبيق (باستثناء فتح الكاميرا/المعرض)
  useEffect(() => {
    const lock = () => { if (document.hidden && session?.role === "admin" && !isPicking()) setLocked(true); };
    document.addEventListener("visibilitychange", lock);
    return () => document.removeEventListener("visibilitychange", lock);
  }, [session]);

  // ----- أوقات المتجر للعامل (من مستند متجره) -----
  useEffect(() => {
    if (authState !== "in" || isAdmin || !session?.storeId) return;
    const key = `daftar_hours_${session.storeId}`;
    try { const c = JSON.parse(localStorage.getItem(key) || "null"); if (c) setWorkerHours(c); } catch {}
    const bkey = `daftar_brand_${session.storeId}`;
    try { const b = JSON.parse(localStorage.getItem(bkey) || "null"); if (b) setWorkerBrand(b); } catch {}
    return subscribeStoreDoc(session.storeId, (st) => {
      const h = { incomeStart: st?.incomeStart || "", incomeEnd: st?.incomeEnd || "", hoursSetAt: st?.hoursSetAt || "", createdAt: st?.createdAt || "" };
      setWorkerHours(h);
      try { localStorage.setItem(key, JSON.stringify(h)); } catch {}
      const b = { logo: st?.logo || "", icon: st?.icon || "" };
      setWorkerBrand(b);
      try { localStorage.setItem(bkey, JSON.stringify(b)); } catch {}
    });
  }, [authState, isAdmin, session?.storeId]);

  // ----- ملف العامل نفسه: إيقاف فوري وتحديث الاسم -----
  useEffect(() => {
    if (authState !== "in" || isAdmin || !session?.uid) return;
    return subscribeOwnWorker(session.uid, (w) => {
      if (!w || w.active === false) { setLoginError("حسابك موقوف — راجع الأدمن"); logout(); return; }
      if (w.name) setSession((s) => { if (!s || s.workerName === w.name) return s; const n = { ...s, workerName: w.name }; saveSession(n); return n; });
    });
  }, [authState, isAdmin, session?.uid]);

  // ----- قائمة المتاجر والعمال (للأدمن فقط) -----
  useEffect(() => {
    if (authState !== "in" || !isAdmin) return;
    const u1 = subscribeStores(setStores);
    const u2 = subscribeWorkers(setWorkers);
    return () => { u1(); u2(); };
  }, [authState, isAdmin]);

  useEffect(() => {
    if (!isAdmin || !stores.length) return;
    if (!stores.some((s) => s.id === adminStoreId)) {
      const first = stores[0].id;
      setAdminStoreId(first);
      try { localStorage.setItem("daftar_admin_store", first); } catch {}
    }
  }, [isAdmin, stores, adminStoreId]);

  function switchStore(id) { setAdminStoreId(id); try { localStorage.setItem("daftar_admin_store", id); } catch {} }

  // ----- بيانات المتجر الحالي فقط -----
  useEffect(() => {
    setIncomesReady(false);
    setIncomes([]); setExpenses([]); setDebts([]); setPayments([]); setSupportRequests([]); setSuppliers([]); setSupplierTransactions([]);
    if (!storeId) return;
    setCacheScope(storeId);
    setCache(null);
    loadCached().then(setCache).catch(() => setCache({ incomes: [], expenses: [], debts: [], payments: [], agg: {}, openDebts: [] }));
    const opts = { storeId };
    const unsubs = [
      subscribe("income", (items, meta) => { setIncomes(items); if (!meta?.fromCache || !navigator.onLine) setIncomesReady(true); }, opts),
      subscribe("expense", setExpenses, opts),
      subscribe("debt", setDebts, opts),
      subscribe("payment", setPayments, opts),
      subscribe("support", setSupportRequests, isAdmin ? opts : { storeId, senderUid: session?.uid }),
    ];
    if (isAdmin) {
      unsubs.push(subscribe("supplier", setSuppliers, opts));
      unsubs.push(subscribe("supplierTransaction", setSupplierTransactions, opts));
    }
    return () => unsubs.forEach((u) => u());
  }, [storeId, isAdmin, session?.uid]);

  const gotFirstSnapshot = incomes.length + expenses.length + debts.length + payments.length > 0;
  useEffect(() => {
    if (!gotFirstSnapshot || !storeId) return;
    persistCache({ incomes, expenses, debts, payments }).catch(() => {});
  }, [incomes, expenses, debts, payments, gotFirstSnapshot, storeId]);

  const useLive = authState === "in";

  useEffect(() => {
    const handler = (e) => { const next = e.detail || readTheme(); setTheme(next); applyTheme(next); };
    window.addEventListener("daftar-theme-change", handler);
    return () => window.removeEventListener("daftar-theme-change", handler);
  }, []);

  useEffect(() => { setBiometricReady(hasBiometricCredential()); }, [locked]);

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2200);
  };

  // ---------- Write-through actions ----------
  const addIncome = (amount) => {
    if (!inIncomeWindow(hours.incomeStart, hours.incomeEnd)) throw new Error("outside-window");
    const date = todayISO();
    // معرّف ثابت (متجر + يوم) يمنع تكرار دخل اليوم حتى لو ضغط عاملان معًا
    return addItem("income", { amount, date, createdAt: nowISO() }, { id: incomeDocId(storeId, date) });
  };
  const addExpense = (data) => addItem("expense", { ...withAttachments(data), date: todayISO(), createdAt: nowISO() });
  const addDebt = (data) => addItem("debt", { ...withAttachments(data), paidAmount: 0, remainingAmount: data.amount, status: "unpaid", date: todayISO(), createdAt: nowISO() });
  const addPayment = (data) => addItem("payment", { ...withAttachments(data), status: "pending", date: todayISO(), createdAt: nowISO() });
  const addSupportRequest = (data) => addItem("support", { ...withAttachments(data), status: "new", adminReply: "", senderUid: auth.currentUser?.uid || "", createdAt: nowISO() });
  const addSupplier = (data) => addItem("supplier", { ...data, createdAt: nowISO() });

  // التأكيد يتم داخل Transaction واحدة (السداد + الدين معًا) ويرفض ما ليس "معلّقًا"
  const confirmPayment = (p) => confirmPaymentTx(p.id);
  const rejectPayment = (p) => updateItem("payment", p.id, { status: "rejected", rejectedBy: auth.currentUser?.uid || "", rejectedAt: nowISO() });

  // ---------- تسجيل الدخول ----------
  async function loginWorker(username, pin) {
    setLoginError("");
    await signInWithEmailAndPassword(auth, workerEmail(username), pin);
  }
  async function loginAdmin(email, password) {
    setLoginError("");
    freshLogin.current = true;
    try { await signInWithEmailAndPassword(auth, email.trim(), password); }
    catch (e) { freshLogin.current = false; throw e; }
  }
  async function setupAdmin(email, password, name) {
    setLoginError("");
    suppressAuth.current = true;
    try { await bootstrapAdmin(email.trim(), password, name); }
    finally { suppressAuth.current = false; }
    freshLogin.current = true;
    const u = auth.currentUser;
    if (u) {
      const s = await resolveSession(u);
      if (s) { freshLogin.current = false; saveSession(s); setSession(s); setAuthState("in"); }
    }
  }
  async function logout() { clearSession(); setLocked(false); await signOut(auth); }

  // ---------- قفل الأدمن ----------
  async function tryUnlock() {
    setLockError("");
    if (adminPin && await checkLockRecord(adminPin, lockPass)) { setLocked(false); setLockPass(""); return; }
    try {
      await signInWithEmailAndPassword(auth, session.email, lockPass);
      setLocked(false); setLockPass("");
    } catch (e) { setLockError(authErrorMessage(e)); }
  }
  async function tryBiometricUnlock() {
    if (!isAdmin) return; // البصمة للأدمن فقط
    setBiometricBusy(true); setLockError("");
    try { await verifyAdminBiometric(); setLocked(false); setLockPass(""); }
    catch (e) { setLockError(biometricErrorMessage(e)); }
    finally { setBiometricBusy(false); }
  }
  // ---------- إدارة المتاجر والعمال (أدمن) ----------
  async function handleAddStore(data) {
    const id = await addStore(data);
    switchStore(id);
    showToast("تمت إضافة المتجر");
  }
  async function handleAddWorker(data) {
    await createWorker({ ...data, storeId: adminStoreId });
    showToast("تمت إضافة العامل");
  }
  async function handleWorkerUpdate(id, patch) { await updateWorker(id, patch); showToast("تم الحفظ"); }
  async function handleWorkerDelete(id) { await deleteWorker(id); showToast("تم حذف العامل"); }
  async function handleWorkerReplace(old, { username, pin }) {
    const newId = await createWorker({ name: old.name, username, pin, storeId: old.storeId, extra: { previousIds: [old.id, ...(old.previousIds || [])] } });
    await updateWorker(old.id, { active: false, replacedBy: newId });
    showToast("تم إنشاء الدخول الجديد وإيقاف القديم");
  }
  async function handleStoreUpdate(id, patch) { await updateStore(id, patch); showToast("تم حفظ المتجر"); }
  async function handleMigrate() {
    const n = await migrateLegacy(adminStoreId);
    showToast(n ? `تم ترحيل ${n} سجلًا إلى المتجر الحالي` : "لا توجد بيانات قديمة تحتاج ترحيلًا");
  }

  if (authState === "loading") {
    return (
      <div dir="rtl" lang="ar" className="min-h-screen w-full flex items-center justify-center" style={{ background: paintBg("bg", COLORS.bg), fontFamily: "'Tajawal','Segoe UI',Tahoma,sans-serif", color: COLORS.inkSoft }}>
        جارٍ الاتصال...
      </div>
    );
  }

  return (
    <div dir="rtl" lang="ar" className="min-h-screen w-full" style={{ background: paintBg("bg", COLORS.bg), fontFamily: "'Tajawal','Segoe UI',Tahoma,sans-serif", color: COLORS.ink }}>
      <style>{`
        * { box-sizing: border-box; }
        input:focus, textarea:focus, select:focus { box-shadow: 0 0 0 3px ${COLORS.goldBg}; border-color: ${COLORS.gold}; }
      `}</style>

      {!isOnline && (
        <div className="fixed top-0 inset-x-0 z-[70] text-center text-[12px] font-bold py-1.5" style={{ background: COLORS.gold, color: COLORS.onGold || "#fff" }}>
          غير متصل — سيتم رفع العمليات تلقائيًا عند عودة الإنترنت{rootPending > 0 ? ` (${rootPending} بانتظار الرفع)` : ""}
        </div>
      )}
      {isOnline && rootPending > 0 && (
        <div className="fixed top-0 inset-x-0 z-[70] text-center text-[12px] font-bold py-1.5" style={{ background: COLORS.gold, color: COLORS.onGold || "#fff" }}>
          ⏳ جارٍ رفع {rootPending} عملية…
        </div>
      )}

      {authState === "out" && (
        <LoginScreen error={loginError} onWorker={loginWorker} onAdmin={loginAdmin} onSetup={setupAdmin} onVerifyGate={verifyGatePin} deviceAllowed={deviceAllowed} onRevealed={() => { markDevicePending(); setDeviceAllowed(true); }} />
      )}

      {authState === "in" && session?.role === "worker" && (
        <UserApp
          incomes={incomes} expenses={expenses} debts={debts} payments={payments}
          openDebtsCache={cache?.openDebts || []} useLive={useLive} supportRequests={supportRequests}
          addIncome={addIncome} addExpense={addExpense} addDebt={addDebt} addPayment={addPayment} addSupportRequest={addSupportRequest} addSupplier={addSupplier}
          showToast={showToast}
          onExit={logout}
          theme={theme}
          storeName={session.storeName} workerName={session.workerName} incomeStart={hours.incomeStart} incomeEnd={hours.incomeEnd} hours={hours} incomesReady={incomesReady}
        />
      )}

      {authState === "in" && isAdmin && stores.length === 0 && (
        <FirstStoreScreen onCreate={handleAddStore} onExit={logout} />
      )}

      {authState === "in" && isAdmin && stores.length > 0 && (
        <AdminApp
          incomes={incomes} expenses={expenses} debts={debts} payments={payments} supportRequests={supportRequests} suppliers={suppliers} supplierTransactions={supplierTransactions}
          aggCache={cache?.agg || {}} useLive={useLive}
          confirmPayment={confirmPayment} rejectPayment={rejectPayment}
          showToast={showToast}
          onExit={logout}
          theme={theme}
          adminPin={adminPin}
          onSavePin={async (pin) => { try { if (pin) { const rec = await makeLockRecord(pin); localStorage.setItem(pinKey, rec); setAdminPin(rec); } else { localStorage.removeItem(pinKey); localStorage.removeItem("daftar_admin_backup_pin"); setAdminPin(""); } } catch {} }}
          onSaveTheme={(next) => setTheme(saveTheme(next))}
          stores={stores} workers={workers} storeId={adminStoreId} currentStore={currentStore} incomesReady={incomesReady}
          onSwitchStore={switchStore} onAddStore={handleAddStore} onAddWorker={handleAddWorker}
          onToggleWorker={(w) => setWorkerActive(w.id, w.active === false)}
          onMigrate={handleMigrate}
          onWorkerUpdate={handleWorkerUpdate} onWorkerDelete={handleWorkerDelete} onWorkerReplace={handleWorkerReplace} onStoreUpdate={handleStoreUpdate}
          bioAuto={bioAuto} onToggleBio={toggleBio} adminName={session.workerName}
          onSetGatePin={async (pin) => { await setGatePin(pin); showToast("تم تغيير PIN الأدمن"); }}
        />
      )}

      {locked && isAdmin && (
        <div className="fixed inset-0 z-[95] flex items-center justify-center px-6" style={{ background: COLORS.bg }}>
          <div className="w-full max-w-sm">
            <div className="text-center mb-6">
              <div className="w-16 h-16 rounded-2xl mx-auto mb-3 flex items-center justify-center text-2xl" style={{ background: COLORS.solid, color: COLORS.goldBg }}>🔒</div>
              <h1 className="text-[22px] font-black">التطبيق مقفل</h1>
            </div>
            <TextInput type="password" value={lockPass} onChange={(e) => setLockPass(e.target.value)} placeholder="كلمة مرور الأدمن أو PIN" dir="ltr" style={{ textAlign: "center", letterSpacing: "2px", fontSize: "18px" }} onKeyDown={(e) => { if (e.key === "Enter") tryUnlock(); }} />
            {lockError && <p className="text-[13px] mt-2" style={{ color: lockError.includes("تم تفعيل") ? COLORS.income : COLORS.expense }}>{lockError}</p>}
            <Button className="w-full mt-3" onClick={tryUnlock} disabled={biometricBusy || !lockPass}>فتح</Button>
            <Button variant="ghost" className="w-full mt-2 !py-2 !text-[13px]" onClick={logout}>تسجيل الخروج</Button>
          </div>
        </div>
      )}

      {toast && (
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-[100] px-5 py-3 rounded-full text-[14px] font-bold shadow-lg" style={{ background: COLORS.solid, color: textOn(COLORS.solid, "#FFFFFF") }}>
          {toast}
        </div>
      )}
    </div>
  );
}

// ---------- Login ----------
function LoginScreen({ error, onWorker, onAdmin, onSetup, onVerifyGate, deviceAllowed, onRevealed }) {
  const [mode, setMode] = useState("worker"); // worker | admin | setup
  const [manualReveal, setManualReveal] = useState(false);
  const revealed = manualReveal || !!deviceAllowed; // جهاز مسموح له، أو أُظهر الآن بـPIN الأدمن
  const [username, setUsername] = useState("");
  const [pin, setPin] = useState("");
  const [email, setEmail] = useState("");
  const [pass, setPass] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // عند ظهور الفورمين يصبح فورم الأدمن هو الأساسي
  useEffect(() => { if (revealed) setMode((m) => (m === "worker" ? "admin" : m)); }, [revealed]);
  const isGateCombo = (u, p) => /^\d{6}$/.test(u) && u === p;
  // PIN الأدمن مكتوبًا في خانتي اسم الدخول والرمز معًا ← يُظهر الفورمين ويتذكر الجهاز
  const tryGate = async (u, p) => {
    if (!isGateCombo(u, p) || revealed) return;
    try {
      if (await onVerifyGate(u)) { onRevealed(); setManualReveal(true); setMode("admin"); setUsername(""); setPin(""); }
    } catch {}
  };
  useEffect(() => { tryGate(username, pin); }, [username, pin]);
  const run = async (fn) => { setBusy(true); setErr(""); try { await fn(); } catch (e) { setErr(authErrorMessage(e)); } finally { setBusy(false); } };
  const submitWorker = () => { if (isGateCombo(username, pin)) return tryGate(username, pin); return run(() => onWorker(username, pin)); };
  const tab = (id, label) => (
    <button onClick={() => { setMode(id); setErr(""); }} className="flex-1 py-2.5 rounded-xl text-[14px] font-extrabold" style={mode === id ? { background: COLORS.solid, color: textOn(COLORS.solid, "#FFFFFF") } : { background: "transparent", color: COLORS.inkSoft }}>{label}</button>
  );
  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-6 py-10">
      <div className="mb-8 text-center">
        <div className="w-16 h-16 rounded-2xl mx-auto mb-4 flex items-center justify-center text-2xl select-none" style={{ background: COLORS.solid, color: COLORS.goldBg }}>{COLORS.shopIcon || "د"}</div>
        <h1 className="text-[28px] font-black mb-1">دفتر</h1>
        <p className="text-[14px]" style={{ color: COLORS.inkSoft }}>تسجيل الدخول</p>
      </div>
      <div className="w-full max-w-sm">
        {revealed && mode !== "setup" && <div className="flex gap-1 p-1 rounded-2xl mb-4" style={{ background: COLORS.card, border: `1px solid ${COLORS.line}` }}>{tab("admin", "أدمن")}{tab("worker", "عامل")}</div>}
        {mode === "worker" && (<>
          <Field label="اسم الدخول"><TextInput value={username} onChange={(e) => setUsername(e.target.value)} dir="ltr" autoCapitalize="none" autoComplete="username" /></Field>
          <Field label="الرمز السري (PIN)"><TextInput type="password" value={pin} onChange={(e) => setPin(e.target.value)} dir="ltr" autoComplete="current-password" onKeyDown={(e) => { if (e.key === "Enter" && username && pin) submitWorker(); }} /></Field>
          <Button className="w-full" disabled={busy || !username || !pin} onClick={submitWorker}>{busy ? "جارٍ الدخول..." : "دخول"}</Button>
        </>)}
        {revealed && mode === "admin" && (<>
          <Field label="البريد الإلكتروني"><TextInput type="email" value={email} onChange={(e) => setEmail(e.target.value)} dir="ltr" autoCapitalize="none" autoComplete="email" /></Field>
          <Field label="كلمة المرور"><TextInput type="password" value={pass} onChange={(e) => setPass(e.target.value)} dir="ltr" autoComplete="current-password" onKeyDown={(e) => { if (e.key === "Enter" && email && pass) run(() => onAdmin(email, pass)); }} /></Field>
          <Button className="w-full" disabled={busy || !email || !pass} onClick={() => run(() => onAdmin(email, pass))}>{busy ? "جارٍ الدخول..." : "دخول الأدمن"}</Button>
          <button className="w-full mt-4 text-[13px] font-bold" style={{ color: COLORS.inkSoft }} onClick={() => { setMode("setup"); setErr(""); }}>أول استخدام؟ إنشاء حساب الأدمن</button>
        </>)}
        {revealed && mode === "setup" && (<>
          <h2 className="text-[17px] font-black mb-1">إنشاء حساب الأدمن</h2>
          <p className="text-[12px] mb-3" style={{ color: COLORS.inkSoft }}>يُسمح بذلك مرة واحدة فقط لهذا المشروع.</p>
          <Field label="الاسم"><TextInput value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="البريد الإلكتروني"><TextInput type="email" value={email} onChange={(e) => setEmail(e.target.value)} dir="ltr" autoCapitalize="none" /></Field>
          <Field label="كلمة المرور (8 رموز فأكثر)"><TextInput type="password" value={pass} onChange={(e) => setPass(e.target.value)} dir="ltr" /></Field>
          <Button className="w-full" disabled={busy || !email || pass.length < 8} onClick={() => run(() => onSetup(email, pass, name))}>{busy ? "جارٍ الإنشاء..." : "إنشاء الحساب"}</Button>
          <button className="w-full mt-4 text-[13px] font-bold" style={{ color: COLORS.inkSoft }} onClick={() => { setMode("admin"); setErr(""); }}>رجوع</button>
        </>)}
        {(err || error) && <p className="text-[13px] mt-3 text-center" style={{ color: COLORS.expense }}>{err || error}</p>}
      </div>
    </div>
  );
}

function FirstStoreScreen({ onCreate, onExit }) {
  const [name, setName] = useState("");
  const [type, setType] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-6 py-10">
      <div className="w-full max-w-sm">
        <h1 className="text-[22px] font-black mb-1">إنشاء أول متجر</h1>
        <p className="text-[13px] mb-4" style={{ color: COLORS.inkSoft }}>ثم يمكنك ترحيل بياناتك القديمة إليه من الإعدادات.</p>
        <Field label="اسم المتجر"><TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="pizza" /></Field>
        <Field label="النوع (اختياري)"><TextInput value={type} onChange={(e) => setType(e.target.value)} placeholder="مطعم بيتزا" /></Field>
        {err && <p className="text-[13px] mb-2" style={{ color: COLORS.expense }}>{err}</p>}
        <Button className="w-full" disabled={busy || !name.trim()} onClick={async () => { setBusy(true); setErr(""); try { await onCreate({ name, type }); } catch (e) { setErr(authErrorMessage(e)); setBusy(false); } }}>إنشاء المتجر</Button>
        <Button variant="ghost" className="w-full mt-2" onClick={onExit}>خروج</Button>
      </div>
    </div>
  );
}

const AUDIT_KIND = { income: "دخل", expense: "مصروف", debt: "دين", payment: "سداد", supplier: "مورد", supplierTransaction: "معاملة مورد", support: "طلب دعم", worker: "عامل", store: "متجر" };
const AUDIT_ACTION = { update: "عدّل", delete: "حذف", confirm: "أكّد" };
const AUDIT_FIELD = { amount: "المبلغ", description: "الوصف", person: "الشخص", supplier: "المورد", category: "التصنيف", status: "الحالة", name: "الاسم", active: "نشط", storeId: "المتجر", date: "التاريخ", type: "النوع", incomeStart: "بداية الدخل", incomeEnd: "نهاية الدخل", address: "العنوان", paidAmount: "المسدد", remainingAmount: "المتبقي" };
function AuditModal({ storeId, onClose }) {
  const [list, setList] = useState(null);
  useEffect(() => subscribeAudit(setList), []);
  const fmtV = (v) => (v === null || v === undefined || v === "" ? "—" : typeof v === "number" ? String(v) : String(v));
  const rows = (list || []).filter((e) => !storeId || e.storeId === storeId).slice(0, 100);
  const detail = (e) => {
    if (e.action === "update") return Object.keys(e.after || {}).slice(0, 4).map((k) => `${AUDIT_FIELD[k] || k}: ${fmtV(e.before?.[k])} ← ${fmtV(e.after[k])}`).join(" · ");
    if (e.action === "confirm") return `المبلغ ${fmtV(e.after?.amount)}`;
    const b = e.before || {};
    return [b.amount != null ? `المبلغ ${b.amount}` : "", b.description || b.person || b.name || ""].filter(Boolean).join(" · ");
  };
  return <Modal title="سجل التدقيق" onClose={onClose} wide>
    {list === null ? <div className="text-center py-8 text-[13px]" style={{ color: COLORS.inkSoft }}>جارٍ التحميل...</div>
      : rows.length === 0 ? <div className="text-center py-8 text-[13px]" style={{ color: COLORS.inkSoft }}>لا توجد تعديلات مسجّلة بعد</div>
      : <div className="space-y-2">{rows.map((e) => <Card key={e.id} className="p-3">
        <div className="text-[13px] font-bold">{e.byName || "—"} · {AUDIT_ACTION[e.action] || e.action} {AUDIT_KIND[e.kind] || e.kind}</div>
        <div className="text-[11px] mt-0.5" style={{ color: COLORS.inkSoft }}>{fmtClock(e.at)} {fmtDMY(e.at)}</div>
        {detail(e) && <div className="text-[12px] mt-1" style={{ color: COLORS.inkSoft }} dir="auto">{detail(e)}</div>}
      </Card>)}</div>}
    <p className="text-[11px] mt-3" style={{ color: COLORS.inkSoft }}>السجل إضافة فقط: لا يمكن تعديله ولا حذفه من التطبيق. يُسجَّل ما يغيّره الأدمن، وتأكيد السداد.</p>
  </Modal>;
}

function HoursModal({ store, onClose, showToast }) {
  const [start, setStart] = useState(store?.incomeStart || "");
  const [end, setEnd] = useState(store?.incomeEnd || "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const both = !!start && !!end;
  const kind = windowKind(start, end);
  const save = async (s, e) => {
    setBusy(true); setErr("");
    try { await saveStoreHours(store.id, s, e); showToast("تم حفظ الوقت"); onClose(); }
    catch (x) { setErr(authErrorMessage(x)); setBusy(false); }
  };
  return <Modal title={`وقت الدخل اليومي — ${store?.name || ""}`} onClose={onClose}>
    <div className="flex items-center gap-3 rounded-2xl p-3 mb-3" style={{ background: COLORS.goldBg }}>
      <Ico n="clock" size={44} />
      <p className="text-[12px] leading-6" style={{ color: COLORS.inkSoft }}>تحدد هذه الفترة متى يسجّل العامل دخل اليوم، وعلى أساسها يُحسب اليوم المحاسبي لكل عملية.</p>
    </div>
    <Field label="بداية تسجيل الدخل"><TextInput type="time" value={start} onChange={(e) => setStart(e.target.value)} dir="ltr" /></Field>
    <Field label="نهاية تسجيل الدخل (عندها يبدأ يوم جديد)"><TextInput type="time" value={end} onChange={(e) => setEnd(e.target.value)} dir="ltr" /></Field>
    <p className="text-[12px] mb-1 font-bold" style={{ color: kind === "empty" ? COLORS.expense : COLORS.ink }}>{windowHint(start, end)}</p>
    <p className="text-[12px] mb-3" style={{ color: COLORS.inkSoft }}>مثال: من 23:30 إلى 04:00 ← دخل يُسجَّل يوم 13 الساعة 02:30 يُحتسب ليوم 12. يُؤخذ الوقت من ساعة الهاتف، وتغيير الفترة لا يغيّر تواريخ العمليات المسجّلة سابقًا. اترك الحقلين فارغين لإلغاء التحديد (اليوم = اليوم الميلادي).</p>
    {err && <p className="text-[13px] mb-2" style={{ color: COLORS.expense }}>{err}</p>}
    <Button className="w-full" disabled={busy || !both || kind === "empty"} onClick={() => save(start, end)}>حفظ</Button>
    {(store?.incomeStart || store?.incomeEnd) && <Button variant="ghost" className="w-full mt-2" disabled={busy} onClick={() => save("", "")}>إلغاء التحديد</Button>}
  </Modal>;
}

function AddStoreModal({ onClose, onSave }) {
  const [name, setName] = useState(""); const [type, setType] = useState(""); const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  return <Modal title="إضافة متجر جديد" onClose={onClose}>
    <Field label="اسم المتجر"><TextInput value={name} onChange={(e) => setName(e.target.value)} /></Field>
    <Field label="النوع (اختياري)"><TextInput value={type} onChange={(e) => setType(e.target.value)} placeholder="ألبسة، بيتزا..." /></Field>
    {err && <p className="text-[13px] mb-2" style={{ color: COLORS.expense }}>{err}</p>}
    <Button className="w-full" disabled={busy || !name.trim()} onClick={async () => { setBusy(true); try { await onSave({ name, type }); onClose(); } catch (e) { setErr(authErrorMessage(e)); setBusy(false); } }}>حفظ المتجر</Button>
  </Modal>;
}

function WorkersModal({ store, stores = [], workers, onClose, onAdd, onToggle, onUpdate, onDelete, onReplace, onUpdateStore, ops = {} }) {
  const storeName = store?.name;
  const [selId, setSelId] = useState(null);
  const selected = workers.find((w) => w.id === selId);
  const [name, setName] = useState(""); const [username, setUsername] = useState(""); const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  const uname = username.trim().toLowerCase();
  const ok = name.trim() && validUsername(uname) && pin.length >= 6;
  return <><Modal title={`عمال متجر ${storeName || ""}`} onClose={onClose} wide>
    <div className="space-y-2 mb-5">
      {workers.length === 0 && <div className="text-[13px] text-center py-4" style={{ color: COLORS.inkSoft }}>لا يوجد عمال بعد</div>}
      {workers.map((w) => <Card key={w.id} className="p-3 flex items-center justify-between gap-2 cursor-pointer" onClick={() => setSelId(w.id)}>
        <div className="min-w-0"><div className="font-bold truncate">{w.name}</div><div className="text-[11px]" dir="ltr" style={{ color: COLORS.inkSoft, textAlign: "right" }}>{w.username}{w.active === false ? " · موقوف" : ""}</div></div>
        <Button variant={w.active === false ? "income" : "ghost"} className="!py-1.5 !px-3 !text-[12px]" onClick={(e) => { e.stopPropagation(); onToggle(w); }}>{w.active === false ? "تفعيل" : "إيقاف"}</Button>
      </Card>)}
    </div>
    <h3 className="font-extrabold mb-2">إضافة عامل</h3>
    <Field label="اسم العامل (يظهر في العمليات)"><TextInput value={name} onChange={(e) => setName(e.target.value)} /></Field>
    <Field label="اسم الدخول (أحرف إنجليزية وأرقام، 3 على الأقل)"><TextInput value={username} onChange={(e) => setUsername(e.target.value)} dir="ltr" autoCapitalize="none" /></Field>
    <Field label="الرمز السري (6 رموز فأكثر)"><TextInput value={pin} onChange={(e) => setPin(e.target.value)} dir="ltr" /></Field>
    {err && <p className="text-[13px] mb-2" style={{ color: COLORS.expense }}>{err}</p>}
    <Button className="w-full" disabled={busy || !ok} onClick={async () => { setBusy(true); setErr(""); try { await onAdd({ name, username: uname, pin }); setName(""); setUsername(""); setPin(""); } catch (e) { setErr(authErrorMessage(e)); } finally { setBusy(false); } }}>{busy ? "جارٍ الإنشاء..." : "إضافة العامل"}</Button>
    <p className="text-[11px] mt-2" style={{ color: COLORS.inkSoft }}>سجّل الرمز السري للعامل الآن؛ لا يمكن عرضه لاحقًا. عند النسيان افتح ملفه واختر «بيانات الدخول».</p>
  </Modal>
    {selected && <WorkerCard worker={selected} store={stores.find((x) => x.id === selected.storeId) || store} stores={stores} ops={ops} onClose={() => setSelId(null)} onToggle={onToggle} onUpdate={onUpdate} onDelete={onDelete} onReplace={onReplace} onUpdateStore={onUpdateStore} />}
  </>;
}

function WorkerCard({ worker, store, stores = [], ops, onClose, onToggle, onUpdate, onDelete, onReplace, onUpdateStore }) {
  const [sub, setSub] = useState(null); // edit | login | store | delete
  const ids = new Set([worker.id, ...(worker.previousIds || [])]);
  const mine = (list = []) => list.filter((x) => ids.has(x.workerId));
  const inc = mine(ops.incomes), exp = mine(ops.expenses), dbt = mine(ops.debts), pay = mine(ops.payments), sup = mine(ops.supportRequests);
  const sum = (l) => l.reduce((t, x) => t + (Number(x.amount) || 0), 0);
  const all = [...inc.map((x) => ["دخل", x]), ...exp.map((x) => ["مصروف", x]), ...dbt.map((x) => ["دين", x]), ...pay.map((x) => ["سداد", x]), ...sup.map((x) => ["طلب دعم", x])];
  const last = all.filter(([, x]) => x.createdAt).sort((a, b) => (Date.parse(b[1].createdAt) || 0) - (Date.parse(a[1].createdAt) || 0))[0];
  const today = todayISO();
  const todayCount = all.filter(([, x]) => x.date === today).length;
  const active = worker.active !== false;
  const stamp = (iso) => (iso ? `${fmtClock(iso)} ${fmtDMY(iso)}` : "—");
  const row = (k, v) => <div className="flex items-center justify-between gap-3 py-2 text-[13px]" style={{ borderBottom: `1px solid ${COLORS.line}` }}><span className="shrink-0" style={{ color: COLORS.inkSoft }}>{k}</span><span className="font-bold text-left">{v}</span></div>;
  const head = (t) => <div className="text-[12px] font-black mt-4 mb-1" style={{ color: COLORS.gold }}>{t}</div>;
  return <>
    <Modal title="ملف العامل" onClose={onClose}>
      <div className="flex items-center gap-3">
        <div className="w-14 h-14 rounded-full flex items-center justify-center text-[22px] font-black" style={{ background: COLORS.goldBg, color: COLORS.gold }}>{(worker.name || "؟").trim().charAt(0)}</div>
        <div><div className="text-[18px] font-black"><Ico n="person" size={18} className="inline-block align-text-bottom" /> {worker.name}</div><div className="text-[12px] font-bold" style={{ color: active ? COLORS.income : COLORS.expense }}>{active ? "● عامل نشط" : "● غير نشط"}</div></div>
      </div>

      {head(<span className="inline-flex items-center gap-1.5"><Ico n="store" size={16} /> المتجر</span>)}
      {row("الاسم", store?.name || "—")}
      {store?.type ? row("النوع", store.type) : null}
      {store?.address ? row("العنوان", store.address) : null}

      {head("🔑 الدخول")}
      {row("اسم الدخول", <span dir="ltr">{worker.username}</span>)}
      {row("كلمة المرور", <span>•••••••• <span className="text-[11px] font-normal" style={{ color: COLORS.inkSoft }}>(غير قابلة للعرض)</span></span>)}

      {head("📅 النشاط")}
      {row("تاريخ الإضافة", stamp(worker.createdAt))}
      {row("آخر دخول", worker.lastLoginAt ? stamp(worker.lastLoginAt) : "لم يسجّل دخولًا بعد")}
      {row("آخر نشاط", last ? `${last[0]} · ${stamp(last[1].createdAt)}` : "لا توجد عمليات")}

      {head("📊 العمليات")}
      {row("إجمالي العمليات", inc.length + exp.length + dbt.length + pay.length)}
      {row("عمليات اليوم", todayCount)}
      {row("السدادات", `${pay.length} · ${fmtMoney(sum(pay))}`)}
      {row("طلبات الدعم", sup.length)}

      {head("💰 المبالغ التي سجّلها")}
      {row("الدخل", `${inc.length} · ${fmtMoney(sum(inc))}`)}
      {row("المصروفات", `${exp.length} · ${fmtMoney(sum(exp))}`)}
      {row("الديون", `${dbt.length} · ${fmtMoney(sum(dbt))}`)}

      <div className="grid grid-cols-2 gap-2 mt-5">
        <Button variant="ghost" className="!text-[13px]" onClick={() => setSub("edit")}><span className="inline-flex items-center gap-1.5"><Glyph n="edit" size={15} /> الاسم والمتجر</span></Button>
        <Button variant="ghost" className="!text-[13px]" onClick={() => setSub("login")}>🔑 بيانات الدخول</Button>
        <Button variant="ghost" className="!text-[13px]" onClick={() => setSub("store")}><span className="inline-flex items-center gap-1.5"><Ico n="store" size={18} /> تعديل المتجر</span></Button>
        <Button variant={active ? "ghost" : "income"} className="!text-[13px]" onClick={() => onToggle(worker)}>{active ? "إيقاف" : "تفعيل"}</Button>
      </div>
      <div className="mt-5 pt-4" style={{ borderTop: `1px dashed ${COLORS.line}` }}>
        <Button variant="danger" className="w-full !text-[13px]" onClick={() => setSub("delete")}>حذف العامل</Button>
      </div>
    </Modal>

    {sub === "edit" && <EditWorkerModal worker={worker} stores={stores} onClose={() => setSub(null)} onSave={onUpdate} />}
    {sub === "login" && <ReplaceLoginModal worker={worker} onClose={() => setSub(null)} onSave={onReplace} />}
    {sub === "store" && store && <EditStoreModal store={store} onClose={() => setSub(null)} onSave={onUpdateStore} />}
    {sub === "delete" && <Modal title="تأكيد حذف العامل" onClose={() => setSub(null)}>
      <p className="text-[14px] leading-7 mb-3">سيُحذف ملف <b>{worker.name}</b> ولن يستطيع تسجيل الدخول. تبقى عملياته السابقة محفوظة في السجلات باسمه.</p>
      <p className="text-[12px] mb-4" style={{ color: COLORS.inkSoft }}>إن أردت إيقافه مؤقتًا فاستعمل "إيقاف" بدل الحذف. حساب الدخول نفسه يبقى في Firebase ويُحذف يدويًا من Authentication إن أردت، واسم دخوله يبقى محجوزًا.</p>
      <div className="flex gap-2">
        <Button variant="danger" className="flex-1" onClick={async () => { await onDelete(worker.id); onClose(); }}>حذف نهائيًا</Button>
        <Button variant="ghost" className="flex-1" onClick={() => setSub(null)}>إلغاء</Button>
      </div>
    </Modal>}
  </>;
}

function EditWorkerModal({ worker, stores, onClose, onSave }) {
  const [name, setName] = useState(worker.name || "");
  const [storeId, setStoreId] = useState(worker.storeId);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  const moving = storeId !== worker.storeId;
  return <Modal title="تعديل العامل" onClose={onClose}>
    <Field label="اسم العامل (يظهر في العمليات الجديدة)"><TextInput value={name} onChange={(e) => setName(e.target.value)} /></Field>
    <Field label="المتجر"><select value={storeId} onChange={(e) => setStoreId(e.target.value)} className={inputCls} style={inputStyle}>{stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
    {moving && <p className="text-[12px] mb-3" style={{ color: COLORS.gold }}>سينتقل العامل إلى المتجر المختار وسيختفي من هذه القائمة. عملياته السابقة تبقى في متجرها.</p>}
    {err && <p className="text-[13px] mb-2" style={{ color: COLORS.expense }}>{err}</p>}
    <Button className="w-full" disabled={busy || !name.trim()} onClick={async () => { setBusy(true); setErr(""); try { await onSave(worker.id, { name: name.trim(), storeId }); onClose(); } catch (e) { setErr(authErrorMessage(e)); setBusy(false); } }}>حفظ</Button>
  </Modal>;
}

function ReplaceLoginModal({ worker, onClose, onSave }) {
  const [username, setUsername] = useState(""); const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  const uname = username.trim().toLowerCase();
  return <Modal title="تغيير بيانات الدخول" onClose={onClose}>
    <p className="text-[12px] leading-6 mb-3" style={{ color: COLORS.inkSoft }}>لا يمكن تغيير كلمة مرور حساب آخر من التطبيق. لذلك يُنشأ دخول جديد (اسم دخول ورمز سري) لنفس العامل، ويُوقف القديم، وتبقى عملياته السابقة منسوبة إليه في ملفه.</p>
    <Field label="اسم الدخول الجديد (أحرف إنجليزية وأرقام)"><TextInput value={username} onChange={(e) => setUsername(e.target.value)} dir="ltr" autoCapitalize="none" /></Field>
    <Field label="الرمز السري الجديد (6 رموز فأكثر)"><TextInput value={pin} onChange={(e) => setPin(e.target.value)} dir="ltr" /></Field>
    {err && <p className="text-[13px] mb-2" style={{ color: COLORS.expense }}>{err}</p>}
    <Button className="w-full" disabled={busy || !validUsername(uname) || pin.length < 6} onClick={async () => { setBusy(true); setErr(""); try { await onSave(worker, { username: uname, pin }); onClose(); } catch (e) { setErr(authErrorMessage(e)); setBusy(false); } }}>{busy ? "جارٍ الإنشاء..." : "إنشاء الدخول الجديد"}</Button>
  </Modal>;
}

const LOGO_ICONS = ["🏪","🛒","🥖","🍔","☕","🍰","💊","👕","📱","🔧","🥩","🥬","💈","🧴","🚗","📦"];
function StoreLogoModal({ store, onClose, showToast }) {
  const [logo, setLogo] = useState(store?.logo || "");
  const [icon, setIcon] = useState(store?.icon || "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const inputId = useId();
  async function pick(e) {
    const f = e.target.files?.[0]; e.target.value = ""; endPicking();
    if (!f) return;
    if (!isImageFile(f)) { setErr("اختر ملف صورة"); return; }
    setBusy(true); setErr("");
    try { setLogo(await compressLogo(f)); setIcon(""); } catch (x) { setErr(x?.message || "تعذّرت قراءة الصورة"); }
    setBusy(false);
  }
  async function save() {
    setBusy(true);
    try { await updateStore(store.id, { logo, icon }); showToast("تم حفظ شعار المتجر"); onClose(); }
    catch { setErr("تعذّر الحفظ. تحقق من الاتصال ثم أعد المحاولة"); setBusy(false); }
  }
  const dirty = logo !== (store?.logo || "") || icon !== (store?.icon || "");
  return <Modal title="شعار المتجر" onClose={onClose}>
    <div className="flex flex-col items-center mb-5">
      {logo
        ? <img src={logo} alt="" className="w-24 h-24 rounded-3xl object-cover shadow" style={{background:"#fff"}}/>
        : <div className="w-24 h-24 rounded-3xl flex items-center justify-center text-5xl font-black" style={{background:COLORS.solid,color:COLORS.goldBg}}>{icon||COLORS.shopIcon||"د"}</div>}
      <div className="text-[12px] mt-2" style={{color:COLORS.inkSoft}}>يظهر في رأس التطبيق وفي القائمة عند كل العمال</div>
    </div>
    <label htmlFor={inputId} onClick={beginPicking} className="w-full flex items-center justify-center gap-2 rounded-xl px-4 py-3 text-[15px] font-bold cursor-pointer" style={{border:`1.5px dashed ${COLORS.line}`,color:COLORS.ink}}>{busy?"جارٍ المعالجة...":"📷 رفع صورة / شعار"}</label>
    <input id={inputId} type="file" accept="image/*" onChange={pick} className="sr-only" disabled={busy} style={{position:"absolute",width:1,height:1,overflow:"hidden",clip:"rect(0,0,0,0)"}}/>
    <div className="text-[12px] font-bold mt-5 mb-2" style={{color:COLORS.inkSoft}}>أو اختر أيقونة</div>
    <div className="grid grid-cols-8 gap-1.5">{LOGO_ICONS.map(i=>(
      <button key={i} onClick={()=>{setIcon(i);setLogo("");}} className="aspect-square rounded-xl text-[20px] flex items-center justify-center" style={{background:icon===i&&!logo?COLORS.goldBg:COLORS.card,border:`1.5px solid ${icon===i&&!logo?COLORS.gold:COLORS.line}`}}>{i}</button>))}</div>
    {err&&<p className="text-[13px] mt-3" style={{color:COLORS.expense}}>{err}</p>}
    <div className="flex gap-2 mt-5">
      <Button variant="ghost" className="flex-1" disabled={busy||(!logo&&!icon)} onClick={()=>{setLogo("");setIcon("");}}>إزالة</Button>
      <Button className="flex-1" disabled={busy||!dirty} onClick={save}>حفظ</Button>
    </div>
  </Modal>;
}
function EditStoreModal({ store, onClose, onSave }) {
  const [name, setName] = useState(store.name || ""); const [type, setType] = useState(store.type || ""); const [address, setAddress] = useState(store.address || ""); const [phone, setPhone] = useState(store.phone || "");
  const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  return <Modal title="تعديل المتجر" onClose={onClose}>
    <Field label="اسم المتجر"><TextInput value={name} onChange={(e) => setName(e.target.value)} /></Field>
    <Field label="النوع"><TextInput value={type} onChange={(e) => setType(e.target.value)} /></Field>
    <Field label="العنوان (اختياري)"><TextInput value={address} onChange={(e) => setAddress(e.target.value)} /></Field>
    <Field label="الهاتف (اختياري)"><TextInput value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" dir="ltr" /></Field>
    {err && <p className="text-[13px] mb-2" style={{ color: COLORS.expense }}>{err}</p>}
    <Button className="w-full" disabled={busy || !name.trim()} onClick={async () => { setBusy(true); setErr(""); try { await onSave(store.id, { name: name.trim(), type: type.trim(), address: address.trim(), phone: phone.trim() }); onClose(); } catch (e) { setErr(authErrorMessage(e)); setBusy(false); } }}>حفظ</Button>
  </Modal>;
}

function AdminDevicesCard({ showToast }) {
  const [list, setList] = useState([]);
  const myId = getDeviceId();
  useEffect(() => subscribeAdminDevices(setList), []);
  return <Card className="p-4 mt-4">
    <h3 className="text-[14px] font-extrabold mb-1">الإعدادات المتقدمة ← ظهور فورم الأدمن</h3>
    <p className="text-[12px] mb-3" style={{ color: COLORS.inkSoft }}>الأجهزة التي يظهر فيها فورم الأدمن مع فورم العامل. عند إزالة جهاز يعود إلى فورم العامل فقط، ويمكن تفعيله من جديد بكتابة الـPIN في الخانتين.</p>
    {list.length === 0
      ? <div className="text-[13px]" style={{ color: COLORS.inkSoft }}>لا توجد أجهزة مسجّلة</div>
      : <div className="space-y-2">{list.map((d) => <div key={d.id} className="flex items-center justify-between gap-2 rounded-xl px-3 py-2" style={{ background: COLORS.card, border: `1px solid ${COLORS.line}` }}>
        <div className="min-w-0"><div className="text-[13px] font-bold truncate">{d.label || "جهاز"}{d.id === myId && <span className="mr-2 text-[10px] px-2 py-0.5 rounded-full" style={{ background: COLORS.goldBg, color: COLORS.gold }}>هذا الجهاز</span>}</div><div className="text-[11px]" style={{ color: COLORS.inkSoft }}>أُضيف {fmtDMY(d.addedAt)}</div></div>
        <Button variant="ghost" className="!py-1.5 !px-3 !text-[12px]" onClick={async () => { try { await removeAdminDevice(d.id); showToast("تمت إزالة الجهاز"); } catch { showToast("تعذّرت الإزالة"); } }}>إزالة</Button>
      </div>)}</div>}
  </Card>;
}

function ChangePasswordModal({ label, minLen, onClose, showToast }) {
  const [cur, setCur] = useState(""); const [nw, setNw] = useState(""); const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  return <Modal title={`تغيير ${label}`} onClose={onClose}>
    <Field label="الحالي"><TextInput type="password" value={cur} onChange={(e) => setCur(e.target.value)} dir="ltr" /></Field>
    <Field label={`الجديد (${minLen} رموز فأكثر)`}><TextInput type="password" value={nw} onChange={(e) => setNw(e.target.value)} dir="ltr" /></Field>
    {err && <p className="text-[13px] mb-2" style={{ color: COLORS.expense }}>{err}</p>}
    <Button className="w-full" disabled={busy || !cur || nw.length < minLen} onClick={async () => { setBusy(true); setErr(""); try { await changeMyPassword(cur, nw); showToast("تم التغيير"); onClose(); } catch (e) { setErr(authErrorMessage(e)); setBusy(false); } }}>حفظ</Button>
  </Modal>;
}

// ---------- Support button + modal (shared) ----------
function SupportButton({ onOpen }) {
  return (
    <button
      onClick={onOpen}
      className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 px-4 py-2 rounded-full text-[12px] font-bold shadow-md flex items-center gap-1.5"
      style={{ background: COLORS.surface, border: `1px solid ${COLORS.line}`, color: COLORS.inkSoft }}
    >
      <IcoTile n="support" size={22} /> الدعم والشكوى
    </button>
  );
}

function SupportModal({ onClose, onSubmit }) {
  const draftKey = uKey("daftar_support_draft");
  const draft = useMemo(() => { try { return JSON.parse(localStorage.getItem(draftKey) || "{}"); } catch { return {}; } }, []);
  const [type, setType] = useState(draft.type || "daily_change_request");
  const [title, setTitle] = useState(draft.title || "");
  const [description, setDescription] = useState(draft.description || "");
  const [files, setFiles] = useState([]);
  // نحفظ النص أثناء الكتابة كي لا يضيع إن أُعيد تحميل التطبيق أثناء فتح الكاميرا
  useEffect(() => { try { localStorage.setItem(draftKey, JSON.stringify({ type, title, description })); } catch {} }, [type, title, description]);

  return (
    <Modal title="الدعم والشكوى" onClose={onClose}>
      <Field label="نوع الطلب">
        <select value={type} onChange={(e) => setType(e.target.value)} className={inputCls} style={inputStyle}>
          <option value="daily_change_request">طلب تغيير شيء غير مناسب في اليوم</option>
          <option value="complaint">شكوى أو ملاحظة</option>
        </select>
      </Field>
      <Field label="العنوان">
        <TextInput value={title} onChange={(e) => setTitle(e.target.value)} placeholder="عنوان مختصر" />
      </Field>
      <Field label="وصف المشكلة بالتفصيل">
        <TextArea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="اكتب التفاصيل هنا..." />
      </Field>
      <FileAttach files={files} onChange={setFiles} />
      <Button
        className="w-full mt-2"
        disabled={!title || !description}
        onClick={() => { try { localStorage.removeItem(draftKey); } catch {} onSubmit({ type, title, description, attachments: files }); onClose(); }}
      >
        إرسال الطلب
      </Button>
    </Modal>
  );
}

// ---------- Top bar: icons only ----------
// في الواجهة العربية (RTL) أول عنصر يظهر يمين الشاشة: القائمة يمينًا، الإشعارات يسارًا.
// الأيقونات المرفقة بيضاء: على شريط فاتح تُعكس تلقائيًا كي تبقى ظاهرة
const barLight = () => isLight(COLORS.bar);
const barText = () => textOnAll(paintHexes(paintBg("bar", COLORS.bar)) || [COLORS.bar], "#FFFFFF", 4.5);
const barBtnBg = () => (barLight() ? "rgba(0,0,0,.08)" : "rgba(255,255,255,.12)");
const whiteIconFilter = () => (barLight() ? "invert(1)" : "none");
function AppHeader({ onMenu, onBell, onLogo, unread = 0 }) {
  const icon = (n) => `${import.meta.env.BASE_URL}icons/${n}.png`;
  const btn = "relative w-11 h-11 rounded-xl flex items-center justify-center";
  return (
    <header className="sticky top-0 z-30 px-4 py-2.5 flex items-center justify-between" style={{ background: paintBg("bar", COLORS.bar), color: barText(), paddingTop: "calc(0.625rem + env(safe-area-inset-top, 0px))" }}>
      <button onClick={onMenu} className={btn} style={{ background: barBtnBg() }} aria-label="القائمة"><img src={icon("more")} alt="" className="w-7 h-7 object-contain" draggable="false" style={{ filter: whiteIconFilter() }} /></button>
      {onLogo
        ? <button onClick={onLogo} aria-label="ملف المتجر" className="rounded-xl"><StoreMark size={40} /></button>
        : <StoreMark size={40} />}
      <button onClick={onBell} className={btn} style={{ background: barBtnBg() }} aria-label="الإشعارات">
        <img src={icon("notification")} alt="" className="w-7 h-7 object-contain" draggable="false" style={{ filter: whiteIconFilter() }} />
        {unread > 0 && <span className="absolute top-1 left-1 w-2.5 h-2.5 rounded-full" style={{ background: "#E53935" }} />}
      </button>
    </header>
  );
}

// ================= USER APP =================
function UserApp({ incomes, expenses, debts, payments, openDebtsCache, useLive, supportRequests = [], addIncome, addExpense, addDebt, addPayment, addSupportRequest, addSupplier, showToast, onExit, theme, storeName = "", workerName = "", incomeStart = "", incomeEnd = "", hours = {}, incomesReady = false }) {
  const paymentDebts = useLive ? debts : (debts.length ? debts : openDebtsCache);
  const [drawer,setDrawer]=useState(false); const [noticeOpen,setNoticeOpen]=useState(false); const [calcOpen,setCalcOpen]=useState(false);
  const noticeReadKey=uKey("daftar_user_notice_read");
  const [noticeRead,setNoticeRead]=useState(()=>{try{return JSON.parse(localStorage.getItem(noticeReadKey)||"[]")}catch{return[]}});
  const [dark,setDark]=useState(theme.mode==="dark");
  const [dismissed,dismiss]=useDismissed(uKey("daftar_dismissed_user"));
  const userNotices=supportRequests.filter(r=>r.senderUid===auth.currentUser?.uid && r.adminReply);
  const userLines=[
    ...userNotices.map(r=>({id:r.id,kind:"support",ts:Date.parse(r.createdAt)||0,text:["رد الأدمن",fmtClock(r.createdAt),fmtDMY(r.createdAt)].filter(Boolean).join(" "),sub:r.title})),
    ...payments.filter(p=>p.workerId===auth.currentUser?.uid&&(p.status==="confirmed"||p.status==="rejected")).map(p=>{const at=p.confirmedAt||p.rejectedAt||p.createdAt;return {id:`pay-${p.id}-${p.status}`,kind:"payment",ts:Date.parse(at)||0,text:[p.status==="confirmed"?"تم تأكيد السداد":"تم رفض السداد",fmtClock(at),fmtDMY(at)].filter(Boolean).join(" ")}}).filter(n=>n.ts>Date.now()-7*864e5),
    ...missedIncomeLines({incomes,ready:incomesReady,hours}),
  ].filter(n=>!dismissed.includes(n.id)).sort((a,b)=>b.ts-a.ts);
  const unread=userLines.filter(n=>!noticeRead.includes(n.id)).length;
  function markNoticesRead(){const ids=[...new Set([...noticeRead,...userLines.map(n=>n.id)])].slice(-300);setNoticeRead(ids);try{localStorage.setItem(noticeReadKey,JSON.stringify(ids))}catch{};setNoticeOpen(true)}
  function toggleDark(){toggleThemeMode(dark);setDark(!dark)}
  const [modal, setModal] = useState(null); // 'income'|'expense'|'debt'|'payment'|'support'
  const [debtTab, setDebtTab] = useState("receivable");
  const [incomeConfirm, setIncomeConfirm] = useState(false);
  const [exitConfirm, setExitConfirm] = useState(false);
  const pendingN = usePendingCount();
  const [repliesOpen, setRepliesOpen] = useState(false);
  const replyList = userNotices.slice().sort((x, y) => (Date.parse(y.replyAt || y.createdAt) || 0) - (Date.parse(x.replyAt || x.createdAt) || 0));
  const unreadReplies = replyList.filter((r) => !noticeRead.includes(r.id)).length;
  function openReplies() {
    const ids = [...new Set([...noticeRead, ...replyList.map((r) => r.id)])].slice(-300);
    setNoticeRead(ids); try { localStorage.setItem(noticeReadKey, JSON.stringify(ids)); } catch {}
    setRepliesOpen(true);
  }

  const today = todayISO();
  const incomeOpen = inIncomeWindow(incomeStart, incomeEnd);
  const todayIncome = incomes.find((i) => i.date === today);
  const todayExpenses = expenses.filter((e) => e.date === today);
  const todayDebts = debts.filter((d) => d.date === today);

  const byNewest = (list) => list.slice().sort((x, y) => tsOf(y) - tsOf(x));
  const todayPayments = payments.filter((p) => p.date === today);
  const sumOf = (list) => list.reduce((t, x) => t + (Number(x.amount) || 0), 0);
  const pendingPay = todayPayments.filter((p) => p.status === "pending").length;

  return (
    <div className="min-h-screen max-w-lg mx-auto">
      <AppHeader onMenu={()=>setDrawer(true)} onBell={markNoticesRead} unread={unread} />
      <div className="px-5 pt-5 pb-4"><div className="text-[13px]" style={{color:COLORS.inkSoft}}>{fmtDate(today)}</div><div className="text-[20px] font-black">لوحة اليوم</div><div className="text-[12px] font-bold mt-1" style={{color:COLORS.inkSoft}}><span className="inline-flex items-center gap-1"><Ico n="store" size={16} />{storeName}</span> · <span className="inline-flex items-center gap-1"><Ico n="person" size={16} />{workerName}</span></div></div>

      {/* quick actions */}
      <div className="px-5 grid grid-cols-2 gap-3 mb-6">
        {todayIncome ? (
          <div className="col-span-2 rounded-xl px-4 py-3 text-center text-[13px] font-bold" style={{ background: COLORS.goldBg, color: COLORS.gold }}>
            {Date.now()-new Date(todayIncome.createdAt||todayIncome.date).getTime() < 5*60*1000 ? <>تم تسجيل دخل اليوم بالفعل — <Fig>{fmtMoney(todayIncome.amount)}</Fig></> : <>تم إضافة الدخل اليومي — {fmtDateTime(todayIncome.createdAt||todayIncome.date)}</>}
          </div>
        ) : (
          incomeOpen
            ? <Button variant="income" className="col-span-2" onClick={() => setIncomeConfirm(true)}>+ تسجيل دخل اليوم</Button>
            : <div className="col-span-2 rounded-xl px-4 py-3 text-center text-[13px] font-bold" style={{ background: COLORS.goldBg, color: COLORS.gold }}>تسجيل الدخل متاح من {incomeStart} إلى {incomeEnd}</div>
        )}
        <Button variant="expense" onClick={() => setModal("expense")}>+ إضافة مصروف</Button>
        <Button variant="debt" onClick={() => setModal("debt")}>+ إضافة دين</Button>
        <Button variant="payment" className="col-span-2" onClick={() => setModal("payment")}>+ تسجيل سداد</Button>
      </div>

      {/* today's operations */}
      <div className="px-5">
        <h2 className="text-[15px] font-extrabold mb-2">عمليات اليوم</h2>
        <Card className="p-3 mb-4">
          <div className="flex items-center justify-between text-[13px] font-bold py-1">
            <span>الدخل اليومي</span>
            <span style={{ color: todayIncome ? COLORS.income : COLORS.gold }}>{todayIncome ? "✓ تم التسجيل" : "○ لم يُسجَّل بعد"}</span>
          </div>
          <div className="flex items-center justify-between text-[13px] py-1" style={{ borderTop: `1px solid ${COLORS.line}` }}>
            <span>المصروفات</span><span><Fig>{todayExpenses.length}</Fig> عملية · <Fig>{fmtMoney(sumOf(todayExpenses))}</Fig></span>
          </div>
          <div className="flex items-center justify-between text-[13px] py-1" style={{ borderTop: `1px solid ${COLORS.line}` }}>
            <span>الديون</span><span><Fig>{todayDebts.length}</Fig> عملية · <Fig>{fmtMoney(sumOf(todayDebts))}</Fig></span>
          </div>
          <div className="flex items-center justify-between text-[13px] py-1" style={{ borderTop: `1px solid ${COLORS.line}` }}>
            <span>السداد</span><span><Fig>{todayPayments.length}</Fig> عملية{pendingPay > 0 && <span style={{ color: COLORS.gold }}> · {pendingPay} بانتظار التأكيد</span>}</span>
          </div>
        </Card>
        <OpsSection title="الدخل" color={COLORS.income} items={todayIncome ? [{ kind: "income", ...todayIncome }] : []} debts={debts} empty="لم يُسجَّل دخل اليوم بعد" />
        <OpsSection title="المصروفات" color={COLORS.expense} items={byNewest(todayExpenses).map((e) => ({ kind: "expense", ...e }))} total={sumOf(todayExpenses)} debts={debts} empty="لا مصروفات اليوم" />
        <OpsSection title="الديون" color={COLORS.payable} items={byNewest(todayDebts).map((d) => ({ kind: "debt", ...d }))} total={sumOf(todayDebts)} debts={debts} empty="لا ديون اليوم" />
        <OpsSection title="السداد" color={COLORS.gold} items={byNewest(todayPayments).map((p) => ({ kind: "payment", ...p }))} total={sumOf(todayPayments)} debts={debts} empty="لا عمليات سداد اليوم" />
      </div>

      <SideDrawer open={drawer} onClose={()=>setDrawer(false)} title="القائمة">
        <DrawerButton ico="notification" label="الإشعارات" badge={unread>0} onClick={()=>{setDrawer(false);markNoticesRead();}}/>
        <DrawerButton ico="support" label="الدعم والشكوى" sub="لتصحيح أي خطأ أو إرسال ملاحظة" onClick={()=>{setDrawer(false);setModal("support")}}/>
        <DrawerButton glyph="mail" label="ردود الأدمن" badge={unreadReplies>0} onClick={()=>{setDrawer(false);openReplies();}}/>
        <DrawerButton ico={dark?"sun":"moon"} label={dark?"الوضع العادي":"الوضع الداكن"} onClick={toggleDark}/>
        <DrawerButton ico="calculator" label="آلة حاسبة" onClick={()=>{setDrawer(false);setCalcOpen(true)}}/>
        <DrawerDivider/>
        <DrawerButton ico="logout" label="خروج" danger onClick={()=>{setDrawer(false);setExitConfirm(true)}}/>
      <VersionFooter n={pendingN} />
      </SideDrawer>
      {noticeOpen&&<NotificationModal lines={userLines} onClose={()=>setNoticeOpen(false)} onDismiss={dismiss}/>}
      {repliesOpen&&(
        <Modal title="ردود الأدمن" onClose={()=>setRepliesOpen(false)}>
          {replyList.length===0
            ? <div className="text-center py-10"><div className="w-16 h-16 mx-auto mb-3 rounded-full flex items-center justify-center text-3xl" style={{background:COLORS.goldBg}}>📭</div><div className="text-[14px] font-bold mb-1">لا توجد ردود بعد</div><div className="text-[12px]" style={{color:COLORS.inkSoft}}>عندما يرد الأدمن على شكواك أو طلبك سيظهر هنا</div></div>
            : <div className="space-y-4">{replyList.map(r=>{
                const complaint = r.type==="complaint";
                return (
                <div key={r.id} className="rounded-2xl overflow-hidden" style={{background:COLORS.card,border:`1px solid ${COLORS.line}`}}>
                  <div className="flex items-center justify-between gap-2 px-4 py-2.5" style={{background:COLORS.goldBg}}>
                    <span className="text-[11px] font-black px-2.5 py-1 rounded-full" style={{background:complaint?COLORS.dangerBg:COLORS.card,color:complaint?COLORS.expense:COLORS.gold}}>{complaint?"شكوى":"طلب تغيير"}</span>
                    <span className="text-[11px]" dir="ltr" style={{color:COLORS.inkSoft}}>{fmtDateTime(r.replyAt||r.createdAt)}</span>
                  </div>
                  <div className="px-4 pt-3">
                    <div className="text-[14px] font-extrabold leading-6">{r.title||"بدون عنوان"}</div>
                    {r.description&&<div className="mt-2 rounded-xl px-3 py-2 text-[12.5px] leading-6" style={{background:COLORS.bg,color:COLORS.inkSoft}}><span className="font-bold">رسالتك: </span>{r.description}</div>}
                  </div>
                  <div className="m-4 mt-3 rounded-xl p-3" style={{background:COLORS.goldBg,borderRight:`4px solid ${COLORS.gold}`}}>
                    <div className="flex items-center gap-1.5 text-[11px] font-black mb-1" style={{color:COLORS.gold}}><span>✓</span><span>رد الأدمن</span></div>
                    <div className="text-[14px] leading-7 whitespace-pre-wrap break-words">{r.adminReply}</div>
                  </div>
                </div>);})}</div>}
        </Modal>
      )}
      {calcOpen&&<CalculatorModal onClose={()=>{setCalcOpen(false);setDrawer(true)}}/>}

      {exitConfirm && (
        <Modal title="تأكيد الخروج" onClose={() => setExitConfirm(false)}>
          <PendingWarn n={pendingN} />
          <p className="text-[14px] leading-7 mb-5">هل تريد الخروج من واجهة المستخدم؟</p>
          <div className="flex gap-2"><Button variant="ghost" className="flex-1" onClick={() => setExitConfirm(false)}>إلغاء</Button><Button variant="danger" className="flex-1" onClick={onExit}>خروج</Button></div>
        </Modal>
      )}

      {incomeConfirm && (
        <Modal title="تأكيد تسجيل دخل اليوم" onClose={() => setIncomeConfirm(false)}>
          <p className="text-[14px] leading-7 mb-5">سيتم تسجيل الدخل <b>مرة واحدة فقط لهذا اليوم</b>. بعد الحفظ لن يظهر زر تسجيل دخل آخر لليوم نفسه.</p>
          <div className="flex gap-2"><Button variant="ghost" className="flex-1" onClick={() => setIncomeConfirm(false)}>إلغاء</Button><Button variant="income" className="flex-1" onClick={() => { setIncomeConfirm(false); setModal("income"); }}>متابعة</Button></div>
        </Modal>
      )}

      {modal === "income" && (
        <IncomeForm
          onClose={() => setModal(null)}
          onSubmit={async (amount) => {
            try {
              await addIncome(amount);
              showToast("تم تسجيل دخل اليوم");
            } catch (e) {
              showToast(e?.message === "outside-window" ? "انتهى وقت تسجيل الدخل" : e?.code === "permission-denied" ? "تم تسجيل دخل اليوم مسبقًا" : "تعذّر الحفظ — تحقق من الاتصال بالإنترنت");
            }
          }}
        />
      )}
      {modal === "expense" && (
        <ExpenseForm
          onClose={() => setModal(null)}
          onSubmit={async (data) => {
            try {
              await addExpense(data);
              showToast("تم إضافة المصروف");
            } catch (e) {
              showToast("تعذّر الحفظ — تحقق من الاتصال بالإنترنت");
            }
          }}
        />
      )}
      {modal === "debt" && (
        <DebtForm
          onClose={() => setModal(null)}
          onSubmit={async (data) => {
            try {
              await addDebt(data);
              showToast("تم إضافة الدين");
            } catch (e) {
              showToast("تعذّر الحفظ — تحقق من الاتصال بالإنترنت");
            }
          }}
        />
      )}
      {modal === "payment" && (
        <PaymentForm
          debts={paymentDebts}
          onClose={() => setModal(null)}
          onSubmit={async (data) => {
            try {
              await addPayment(data);
              showToast("تم إرسال طلب السداد، بانتظار تأكيد الأدمن");
            } catch (e) {
              showToast("تعذّر الحفظ — تحقق من الاتصال بالإنترنت");
            }
          }}
        />
      )}
      {modal === "support" && (
        <SupportModal
          onClose={() => setModal(null)}
          onSubmit={async (data) => {
            try {
              await addSupportRequest(data);
              showToast("تم إرسال طلبك للأدمن");
            } catch (e) {
              showToast("تعذّر الحفظ — تحقق من الاتصال بالإنترنت");
            }
          }}
        />
      )}
    </div>
  );
}

// لون نص مقروء فوق خلفية CSS (لون واحد أو تدرج مسجَّل في PAINT_HEXES)
const legibleOnCss = (bgCss, preferred, min = 3) => { const h = paintHexes(String(bgCss || "")); return h ? textOnAll(h, preferred, min) : preferred; };
function StatCard({ label, value, color, bg }) {
  const b = bg || COLORS.invoiceCard;
  return (
    <Card className="p-[12.6px] text-center" style={{ background: b, borderColor: COLORS.line, textAlign: "center" }}>
      <div className="text-[11px] font-bold mb-1" style={{ color: COLORS.inkSoft }}>{label}</div>
      <Fig className="text-[17px]" style={{ color: legibleOnCss(b, color) }}>{fmtMoney(value)}</Fig>
    </Card>
  );
}

function OpsSection({ title, color, items, total, debts, empty }) {
  return (
    <div className="mb-4">
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-2 text-[13px] font-extrabold">
          <span className="w-2 h-2 rounded-full" style={{ background: color }} />{title}
          <span className="text-[11px] font-bold" style={{ color: COLORS.inkSoft }}>({items.length})</span>
        </div>
        {total != null && items.length > 0 && <Fig className="text-[12px]" style={{ color }}>{fmtMoney(total)}</Fig>}
      </div>
      {items.length === 0
        ? <div className="text-[12px] py-2 px-3 rounded-xl" style={{ color: COLORS.inkSoft, border: `1px dashed ${COLORS.line}` }}>{empty}</div>
        : <div className="space-y-2">{items.map((it) => <OperationRow key={it.kind + it.id} item={it} debts={debts} />)}</div>}
    </div>
  );
}

function OperationRow({ item, debts }) {
  const map = {
    income: { label: "دخل اليوم", color: COLORS.income, icon: "↓" },
    expense: { label: item.description || "مصروف", color: COLORS.expense, icon: "↑" },
    debt: { label: `${item.type === "receivable" ? "دين لي" : "دين عليّ"} — ${item.person}`, color: item.type === "receivable" ? COLORS.receivable : COLORS.payable, icon: "≈" },
    payment: { label: `سداد دين — ${debts.find((d) => d.id === item.debtId)?.person || ""}`, color: COLORS.gold, icon: "✓" },
  };
  const m = map[item.kind];
  return (
    <TxCard kind={item.kind} className="p-3.5 flex items-center justify-between" style={{background:paintBg(({income:"incomeCard",expense:"expenseCard",debt:"debtCard",payment:"paymentCard"})[item.kind]||"card",COLORS.card)}}>
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-full flex items-center justify-center text-[15px] font-bold" style={{ background: m.color + "1A", color: m.color }}>{m.icon}</div>
        <div>
          <div className="text-[14px] font-bold">{m.label}</div>
          <div className="text-[12px]" style={{ color: COLORS.inkSoft }}>
            {fmtClock(item.createdAt)}
            {item.workerName && ` · ${item.workerName}`}
            {item.kind === "payment" && ` · ${paymentStatusLabel(item.status)}`}
            {item._pending && " · ⏳ بانتظار الرفع"}
          </div>
        </div>
      </div>
      {item.kind === "income" && Date.now() - new Date(item.createdAt||item.date).getTime() >= 5*60*1000 ? <div className="text-[11px] font-bold text-right" style={{color:COLORS.inkSoft}}>تمت الإضافة</div> : <Fig style={{ color: m.color }}>{fmtMoney(item.amount)}</Fig>}
    </TxCard>
  );
}

function IncomeForm({ onClose, onSubmit }) {
  const [amount, setAmount] = useState("");
  return (
    <Modal title="تسجيل دخل اليوم" onClose={onClose}>
      <Field label="قيمة الدخل (دج)">
        <TextInput type="number" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" dir="ltr" />
      </Field>
      <p className="text-[12px] mb-4" style={{ color: COLORS.inkSoft }}>سيتم تسجيل التاريخ تلقائيًا بتاريخ اليوم. لا يمكن تسجيل أكثر من دخل واحد في اليوم.</p>
      <Button variant="income" className="w-full" disabled={!amount || Number(amount) <= 0} onClick={() => { onSubmit(Number(amount)); onClose(); }}>
        تأكيد الدخل
      </Button>
    </Modal>
  );
}

function ExpenseForm({ onClose, onSubmit }) {
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [supplier, setSupplier] = useState("");
  const [category, setCategory] = useState("");
  const [files, setFiles] = useState([]);
  return (
    <Modal title="إضافة مصروف" onClose={onClose}>
      <Field label="المبلغ (دج)">
        <TextInput type="number" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" dir="ltr" />
      </Field>
      <Field label="وصف المصروف">
        <TextInput value={description} onChange={(e) => setDescription(e.target.value)} placeholder="مثال: شراء مواد أولية" />
      </Field>
      <Field label="التصنيف">
        <select value={category} onChange={e=>setCategory(e.target.value)} className={inputCls} style={inputStyle}><option value="">اختر تصنيفًا</option>{readTheme().categories.map(c=><option key={c} value={c}>{c}</option>)}</select>
      </Field>
      <Field label="اسم المورد (إن وجد)">
        <TextInput value={supplier} onChange={(e) => setSupplier(e.target.value)} placeholder="مثال: شركة ABC" />
      </Field>
      <FileAttach files={files} onChange={setFiles} />
      <Button variant="expense" className="w-full mt-2" disabled={!amount || Number(amount) <= 0 || !description}
        onClick={() => { onSubmit({ amount: Number(amount), description, supplier, category, attachments: files }); onClose(); }}>
        حفظ المصروف
      </Button>
    </Modal>
  );
}

function DebtForm({ onClose, onSubmit }) {
  const [type, setType] = useState("receivable");
  const [person, setPerson] = useState("");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [files, setFiles] = useState([]);
  return (
    <Modal title="إضافة دين" onClose={onClose}>
      <div className="flex gap-2 mb-4">
        <button onClick={() => setType("receivable")} className="flex-1 py-2.5 rounded-xl text-[14px] font-bold" style={type === "receivable" ? { background: COLORS.receivable, color: textOn(COLORS.receivable, "#FFFFFF", 3) } : { background: COLORS.card, border: `1px solid ${COLORS.line}`, color: COLORS.inkSoft }}>لي</button>
        <button onClick={() => setType("payable")} className="flex-1 py-2.5 rounded-xl text-[14px] font-bold" style={type === "payable" ? { background: COLORS.payable, color: textOn(COLORS.payable, "#FFFFFF", 3) } : { background: COLORS.card, border: `1px solid ${COLORS.line}`, color: COLORS.inkSoft }}>عليّ</button>
      </div>
      <Field label="اسم الشخص / العميل / المورد">
        <TextInput value={person} onChange={(e) => setPerson(e.target.value)} placeholder="مثال: أحمد" />
      </Field>
      <Field label="المبلغ الإجمالي (دج)">
        <TextInput type="number" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" dir="ltr" />
      </Field>
      <Field label="وصف أو تفاصيل الدين">
        <TextArea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="تفاصيل الدين..." />
      </Field>
      <FileAttach files={files} onChange={setFiles} />
      <Button variant="debt" className="w-full mt-2" disabled={!person || !amount || Number(amount) <= 0}
        onClick={() => { onSubmit({ type, person, amount: Number(amount), description, attachments: files }); onClose(); }}>
        حفظ الدين
      </Button>
    </Modal>
  );
}

function PaymentForm({ debts, onClose, onSubmit }) {
  const unpaid = debts.filter((d) => d.status !== "paid");
  const [debtId, setDebtId] = useState(unpaid[0]?.id || "");
  const [amount, setAmount] = useState("");
  const [files, setFiles] = useState([]);
  const selected = debts.find((d) => d.id === debtId);
  const over = selected && Number(amount) > selected.remainingAmount;

  return (
    <Modal title="تسجيل سداد" onClose={onClose}>
      {unpaid.length === 0 ? (
        <p className="text-[14px]" style={{ color: COLORS.inkSoft }}>لا توجد ديون غير مسددة حاليًا.</p>
      ) : (
        <>
          <Field label="اختر الدين">
            <select value={debtId} onChange={(e) => setDebtId(e.target.value)} className={inputCls} style={inputStyle}>
              {unpaid.map((d) => (
                <option key={d.id} value={d.id}>
                  {(d.type === "receivable" ? "لي" : "عليّ")} — {d.person} (متبقي {fmtMoney(d.remainingAmount)})
                </option>
              ))}
            </select>
          </Field>
          {selected && (
            <div className="text-[13px] mb-3 px-3 py-2 rounded-lg" style={{ background: COLORS.goldBg, color: COLORS.ink }}>
              المبلغ المتبقي: <Fig>{fmtMoney(selected.remainingAmount)}</Fig>
            </div>
          )}
          <Field label="المبلغ المدفوع (دج)">
            <TextInput type="number" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" dir="ltr" />
          </Field>
          {over && <p className="text-[12px] mb-3" style={{ color: COLORS.expense }}>لا يمكن سداد مبلغ أكبر من المبلغ المتبقي</p>}
          <FileAttach files={files} onChange={setFiles} label="إرفاق إيصال السداد (اختياري)" />
          <p className="text-[12px] mb-4" style={{ color: COLORS.inkSoft }}>لن يعتبر السداد نهائيًا حتى يؤكده الأدمن.</p>
          <Button variant="payment" className="w-full" disabled={!amount || Number(amount) <= 0 || over}
            onClick={() => { onSubmit({ debtId, amount: Number(amount), attachments: files }); onClose(); }}>
            إرسال طلب السداد
          </Button>
        </>
      )}
    </Modal>
  );
}

// ================= ICONS =================
function BottomIcon({ src, alt }) {
  return <img src={src} alt={alt} className="w-8 h-8 object-contain transition-transform duration-200" draggable="false" />;
}
function WhatsAppIcon() {
  return <Ico n="whatsapp" size={26} />;
}
function PersonIcon() {
  return <Ico n="person" size={44} />;
}

function NavIcon({ name }) {
  const paths = {
    reports: <><path d="M4 20V11M10 20V4M16 20v-6M22 20H2" /></>,
    expenses: <><path d="M7 17 17 7M9 7h8v8" /></>,
    incomes: <><path d="M17 7 7 17M15 17H7V9" /></>,
    payments: <><circle cx="12" cy="12" r="9" /><path d="m8 12.5 2.7 2.7L16 9.5" /></>,
    debts: <><path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3Z" /><path d="M9 8h6M9 12h6" /></>,
    suppliers: <><path d="m3 9 1.5-5h15L21 9" /><path d="M4 9v11h16V9M3 9h18M10 20v-6h4v6" /></>,
  };
  return <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

// ================= ADMIN APP =================
function AdminApp(props) {
  const { incomes, expenses, debts, payments, supportRequests, suppliers, supplierTransactions, aggCache, useLive, confirmPayment, rejectPayment, showToast, onExit, theme, adminPin, onSavePin, onSaveTheme, stores = [], workers = [], storeId, currentStore, onSwitchStore, onAddStore, onAddWorker, onToggleWorker, onMigrate, incomesReady, onWorkerUpdate, onWorkerDelete, onWorkerReplace, onStoreUpdate, onSetGatePin, bioAuto, onToggleBio, adminName } = props;
  const [logoModal, setLogoModal] = useState(false);
  const [overviewModal, setOverviewModal] = useState(false); const [auditModal, setAuditModal] = useState(false); const [hoursModal, setHoursModal] = useState(false); const [storeModal, setStoreModal] = useState(false); const [workersModal, setWorkersModal] = useState(false);
  const [drawer,setDrawer]=useState(false); const [noticeOpen,setNoticeOpen]=useState(false); const [calcOpen,setCalcOpen]=useState(false);
  const [dark,setDark]=useState(theme.mode==="dark");
  const [noticeRead,setNoticeRead]=useState(()=>{try{return JSON.parse(localStorage.getItem("daftar_admin_notice_read")||"[]")}catch{return[]}});
  const seenKey=`${uKey("daftar_admin_seen")}_${storeId}`;
  const readSeen=()=>{try{const v=localStorage.getItem(seenKey);if(v===null){const now=Date.now();localStorage.setItem(seenKey,String(now));return now}return Number(v)||0}catch{return 0}};
  const [seenAt,setSeenAt]=useState(readSeen);
  useEffect(()=>{setSeenAt(readSeen())},[seenKey]);
  const opLines=useMemo(()=>{
    const mk=(kind,list)=>list.map(x=>({id:kind+x.id,kind,tab:TAB_OF[kind],ts:Date.parse(x.createdAt)||0,text:noticeLine(kind,x)}));
    return [...mk("income",incomes),...mk("expense",expenses),...mk("debt",debts),...mk("payment",payments),...mk("support",supportRequests.filter(r=>!['resolved','rejected'].includes(r.status)))]
      .filter(n=>n.ts).sort((a,b)=>b.ts-a.ts).slice(0,60);
  },[incomes,expenses,debts,payments,supportRequests]);
  const [dismissed,dismiss]=useDismissed(`${uKey("daftar_dismissed")}_${storeId}`);
  const adminLines=[...missedIncomeLines({incomes,ready:incomesReady,hours:{incomeStart:currentStore?.incomeStart,incomeEnd:currentStore?.incomeEnd,hoursSetAt:currentStore?.hoursSetAt,createdAt:currentStore?.createdAt}}),...opLines]
    .filter(n=>!dismissed.includes(n.id)).sort((a,b)=>b.ts-a.ts);
  const unread=adminLines.filter(n=>n.ts>seenAt).length;
  function markNoticesRead(){const now=Date.now();setSeenAt(now);try{localStorage.setItem(seenKey,String(now))}catch{};setNoticeOpen(true)}
  function toggleDark(){toggleThemeMode(dark);setDark(!dark)}
  const [tab, setTab] = useState("overview");
  const [editing, setEditing] = useState(null);
  const [confirmDel, setConfirmDel] = useState(null);
  const [exitConfirm, setExitConfirm] = useState(false);
  const pendingN = usePendingCount();

  async function save(kind, updated) {
    try { const { id, ...patch } = updated; await updateItem(kind, id, patch); setEditing(null); showToast("تم حفظ التعديلات"); }
    catch { showToast("تعذّر الحفظ — تحقق من الاتصال بالإنترنت"); }
  }
  const go = (id) => setTab(id);
  const top = [
    ["overview", "reports", "التقارير", "markReports"],
    ["expenses", "expenses", "المصروفات", "markExpenses"],
    ["payments", "payments", "السداد", "markPayments"],
    ["incomes", "incomes", "المداخيل", "markIncomes"],
    ["debts", "debts", "الديون", "markDebts"],
    ["suppliers", "suppliers", "الموردين", "markSuppliers"],
  ];
  const pendingPayments = payments.filter(p => p.status === "pending").length;
  const openSupport = supportRequests.filter(r => !["resolved","rejected"].includes(r.status)).length;
  return (
    <div className="min-h-screen max-w-3xl mx-auto" style={{ background: paintBg("bg", COLORS.bg) }}>
      <AppHeader onMenu={()=>setDrawer(true)} onBell={markNoticesRead} onLogo={()=>setOverviewModal(true)} unread={unread} />

      <div className="px-5 pt-3 text-[12px] font-bold flex items-center gap-1.5" style={{color:COLORS.inkSoft}}><Ico n="store" size={18}/>{currentStore?.name || ""}</div>
      <div className="px-5 py-3 grid grid-cols-3 gap-2.5">
        {top.map(([id, icon, label, markKey]) => {
          const mark = COLORS[markKey] || COLORS.navButton;
          const active = tab === id;
          const solidBg = COLORS.tabBg || COLORS.card;
          const bg = paintBg("tabBg", COLORS.card);
          const fg = textOnAll(paintHexes(bg) || [solidBg], COLORS.inkHex, 4.5);
          const markBg = PAINTS[markKey] || mark;
          const side = COLORS.tabMarkPos === "side";
          return <button key={id} onClick={() => go(id)} aria-current={active ? "page" : undefined} className="ui-button relative overflow-hidden h-[68px] rounded-2xl text-[13px] font-extrabold flex flex-col items-center justify-center gap-1 active:scale-[.97]" style={{ background: bg, color: fg, border: `${active ? 2 : 1}px solid ${active ? mark : COLORS.line}` }}>
            {active && <span aria-hidden="true" className="absolute inset-0" style={{ background: markBg, opacity: 0.1 }} />}
            <span aria-hidden="true" className={side ? "absolute top-0 bottom-0 right-0 w-[5px]" : "absolute top-0 inset-x-0 h-[5px]"} style={{ background: markBg }} />
            <span className="relative flex flex-col items-center gap-1" style={{ paddingTop: side ? 0 : 3 }}><NavIcon name={icon} /><span>{label}</span></span>
            {id === "payments" && pendingPayments > 0 && <span className="absolute top-2 left-2 w-2.5 h-2.5 rounded-full" style={{ background: "#E53935", boxShadow: `0 0 0 2px ${solidBg}` }} />}
          </button>;
        })}
      </div>

      <main key={tab} className="px-5 admin-page-enter">
        {tab === "overview" && <ReportsTab incomes={incomes} expenses={expenses} debts={debts} payments={payments} aggCache={aggCache} useLive={useLive} />}
        {tab === "incomes" && <IncomesSection incomes={incomes} onEdit={raw=>setEditing({kind:"income",data:raw})} onDelete={id=>setConfirmDel({kind:"income",id})} />}
        {tab === "expenses" && <ExpensesSection expenses={expenses} onEdit={raw=>setEditing({kind:"expense",data:raw})} onDelete={id=>setConfirmDel({kind:"expense",id})} />}
        {tab === "debts" && <DebtsSection debts={debts} onEdit={raw=>setEditing({kind:"debt",data:raw})} onDelete={id=>setConfirmDel({kind:"debt",id})} />}
        {tab === "payments" && <PaymentsTab payments={payments} debts={debts} onConfirm={async p=>{try{await confirmPayment(p);showToast("تم تأكيد السداد")}catch(e){showToast(e?.code?"تعذّر تأكيد السداد — تحقق من الاتصال":(e?.message||"تعذّر تأكيد السداد"))}}} onReject={async p=>{try{await rejectPayment(p);showToast("تم رفض السداد")}catch{showToast("تعذّر التنفيذ")}}} onEdit={raw=>setEditing({kind:"payment",data:raw})} onDelete={id=>setConfirmDel({kind:"payment",id})} />}
        {tab === "support" && <SupportTab requests={supportRequests} onUpdate={async(id,patch)=>{try{await updateItem("support",id,patch);showToast("تم الحفظ")}catch{showToast("تعذّر الحفظ")}}} onDelete={async id=>{try{await deleteItem("support",id);showToast("تم الحذف")}catch{showToast("تعذّر الحذف")}}} showToast={showToast} />}
        {tab === "search" && <SearchTab incomes={incomes} expenses={expenses} debts={debts} payments={payments} />}
        {tab === "suppliers" && <SuppliersTab showToast={showToast} suppliers={suppliers} expenses={expenses} debts={debts} supplierTransactions={supplierTransactions} onEdit={s=>setEditing({kind:"supplier",data:s})} onDelete={async id=>{try{await deleteItem("supplier",id);showToast("تم حذف المورد");return true}catch{showToast("تعذّر الحذف");return false}}} onArchive={async sp=>{try{await updateItem("supplier",sp.id,{archived:true,archivedAt:nowISO()});showToast("تمت أرشفة المورد");return true}catch{showToast("تعذّرت الأرشفة");return false}}} onRestore={async sp=>{try{await updateItem("supplier",sp.id,{archived:false,archivedAt:""});showToast("تمت استعادة المورد");return true}catch{showToast("تعذّرت الاستعادة");return false}}} onAdd={async d=>{try{await addItem("supplier",{...d,createdAt:nowISO()});showToast("تمت إضافة المورد")}catch{showToast("تعذّرت الإضافة")}}} />}
        {tab === "customize" && <CustomizationTab theme={theme} onSave={onSaveTheme} showToast={showToast} />}
        {tab === "settings" && <SettingsTab bioAuto={bioAuto} onToggleBio={onToggleBio} onSetGatePin={onSetGatePin} onMigrate={onMigrate} storeName={currentStore?.name} showToast={showToast} incomes={incomes} expenses={expenses} debts={debts} payments={payments} supportRequests={supportRequests} suppliers={suppliers} supplierTransactions={supplierTransactions} adminPin={adminPin} onSavePin={onSavePin} theme={theme} onSaveTheme={onSaveTheme} />}
      </main>

      <SideDrawer open={drawer} onClose={()=>setDrawer(false)} title="القائمة">
        <div className="px-1 pb-3"><div className="text-[11px] font-bold mb-1" style={{color:COLORS.inkSoft}}>المتجر الحالي</div><select value={storeId} onChange={e=>{onSwitchStore(e.target.value);setDrawer(false)}} className={inputCls} style={inputStyle}>{stores.map(st=><option key={st.id} value={st.id}>{st.name}</option>)}</select></div>
        <DrawerButton glyph="image" label="شعار المتجر" sub="ارفع صورة أو اختر أيقونة" onClick={()=>{setDrawer(false);setLogoModal(true)}}/>
        <DrawerButton ico="store" label="إضافة متجر جديد" onClick={()=>{setDrawer(false);setStoreModal(true)}}/>
        <DrawerButton ico="clock" label="وقت الدخل اليومي" onClick={()=>{setDrawer(false);setHoursModal(true)}}/>
        <DrawerButton ico="audit" label="سجل التدقيق" onClick={()=>{setDrawer(false);setAuditModal(true)}}/>
        <DrawerButton ico="workers" label="عمال المتجر" onClick={()=>{setDrawer(false);setWorkersModal(true)}}/>
        <DrawerButton ico="settings" label="الإعدادات" onClick={()=>{setDrawer(false);go("settings")}}/>
        <DrawerButton ico="color-wheel" label="التخصيص" onClick={()=>{setDrawer(false);go("customize")}}/>
        <DrawerButton ico="support" label="الدعم والشكاوى" badge={openSupport>0} onClick={()=>{setDrawer(false);go("support")}}/>
        <DrawerButton ico={dark?"sun":"moon"} label={dark?"الوضع العادي":"الوضع الداكن"} onClick={toggleDark}/>
        <DrawerButton ico="calculator" label="آلة حاسبة" onClick={()=>{setDrawer(false);setCalcOpen(true)}}/>
        <DrawerButton ico="search" label="بحث" onClick={()=>{setDrawer(false);go("search")}}/>
        <DrawerDivider/>
        <DrawerButton ico="logout" label="قفل / خروج" danger onClick={()=>{setDrawer(false);setExitConfirm(true)}}/>
      <VersionFooter n={pendingN} />
      </SideDrawer>
      {noticeOpen&&<NotificationModal lines={adminLines} onClose={()=>setNoticeOpen(false)} onPick={(t)=>{setNoticeOpen(false);go(t)}} onDismiss={dismiss}/>}
      {calcOpen&&<CalculatorModal onClose={()=>{setCalcOpen(false);setDrawer(true)}}/>}
      {overviewModal&&<StoreOverviewModal store={currentStore} adminName={adminName} workers={workers.filter(w=>w.storeId===storeId&&!w.replacedBy)} incomes={incomes} expenses={expenses} debts={debts} payments={payments} onClose={()=>setOverviewModal(false)} onReports={()=>{setOverviewModal(false);go("overview")}} onWorkers={()=>{setOverviewModal(false);setWorkersModal(true)}} onSettings={()=>{setOverviewModal(false);go("settings")}}/>}

      {auditModal&&<AuditModal storeId={storeId} onClose={()=>setAuditModal(false)}/>}
      {hoursModal&&<HoursModal store={currentStore} onClose={()=>setHoursModal(false)} showToast={showToast}/>}
      {logoModal&&<StoreLogoModal store={currentStore} onClose={()=>setLogoModal(false)} showToast={showToast}/>}
      {storeModal&&<AddStoreModal onClose={()=>setStoreModal(false)} onSave={onAddStore}/>}
      {workersModal&&<WorkersModal store={currentStore} stores={stores} workers={workers.filter(w=>w.storeId===storeId&&!w.replacedBy)} onClose={()=>setWorkersModal(false)} onAdd={onAddWorker} onToggle={onToggleWorker} onUpdate={onWorkerUpdate} onDelete={onWorkerDelete} onReplace={onWorkerReplace} onUpdateStore={onStoreUpdate} ops={{incomes,expenses,debts,payments,supportRequests}}/>}

      {exitConfirm && <Modal title="تأكيد الخروج" onClose={() => setExitConfirm(false)}>
        <PendingWarn n={pendingN} />
        <p className="text-[14px] leading-7 mb-5">هل أنت متأكد أنك تريد الخروج من لوحة الأدمن؟</p>
        <div className="flex gap-2"><Button variant="ghost" className="flex-1" onClick={() => setExitConfirm(false)}>إلغاء</Button><Button variant="danger" className="flex-1" onClick={onExit}>خروج</Button></div>
      </Modal>}

      {editing && <EditModal kind={editing.kind} data={editing.data} onClose={()=>setEditing(null)} onSave={u=>save(editing.kind,u)} />}
      {confirmDel && <Modal title="تأكيد الحذف" onClose={()=>setConfirmDel(null)}><p className="text-[14px] mb-5">هل أنت متأكد من حذف هذه العملية؟ لا يمكن التراجع عن هذا الإجراء.</p><div className="flex gap-3"><Button variant="ghost" className="flex-1" onClick={()=>setConfirmDel(null)}>إلغاء</Button><Button variant="danger" className="flex-1" onClick={async()=>{try{await deleteItem(confirmDel.kind,confirmDel.id);showToast("تم الحذف")}catch{showToast("تعذّر الحذف")}setConfirmDel(null)}}>حذف</Button></div></Modal>}
    </div>
  );
}


function DrawerButton({icon,ico,glyph,label,sub,onClick,badge,danger}){
  const tile = ico ? <IcoTile n={ico} size={44} danger={danger}/> : glyph ? <GlyphTile n={glyph} size={44} danger={danger}/> : <span className="w-11 h-11 rounded-xl flex items-center justify-center text-[21px]" style={{background:danger?"rgba(0,0,0,.06)":COLORS.goldBg}}>{icon}</span>;
  return <button onClick={onClick} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-2xl text-right active:scale-[.98] transition" style={{background:danger?COLORS.dangerBg:COLORS.card,border:`1px solid ${danger?"transparent":COLORS.line}`,color:danger?COLORS.expense:COLORS.ink}}>
    <span className="relative shrink-0">{tile}{badge&&<span className="absolute -top-1 -left-1 w-3.5 h-3.5 rounded-full" style={{background:"#E53935",border:`2px solid ${COLORS.card}`}}/>}</span>
    <span className="flex-1 min-w-0"><span className="block text-[14px] font-extrabold leading-5">{label}</span>{sub&&<span className="block text-[11px] font-medium mt-0.5" style={{color:COLORS.inkSoft}}>{sub}</span>}</span>
    <span className="text-[20px] leading-none opacity-40">‹</span>
  </button>;
}
function DrawerDivider(){return <div className="my-2 h-px" style={{background:COLORS.line}}/>}
function SideDrawer({open,onClose,title,children}){
  if(!open)return null;
  return <div className="fixed inset-0 z-[80]" onClick={onClose}>
    <div className="absolute inset-0 bg-black/40"/>
    <aside onClick={e=>e.stopPropagation()} className="absolute right-0 top-0 h-full w-[min(86vw,360px)] overflow-y-auto shadow-2xl flex flex-col" style={{background:COLORS.bg,borderLeft:`1px solid ${COLORS.line}`}}>
      <div className="px-4 pb-4 flex items-center gap-3" style={{background:paintBg("bar",COLORS.bar),color:barText(),paddingTop:"calc(1rem + env(safe-area-inset-top, 0px))"}}>
        <StoreMark size={46} radius={14}/>
        <div className="flex-1 min-w-0"><div className="text-[17px] font-black">{title}</div><div className="text-[11px] opacity-70">دفتر</div></div>
        <button onClick={onClose} aria-label="إغلاق" className="w-9 h-9 rounded-full text-[15px]" style={{background:barBtnBg()}}>✕</button>
      </div>
      <div className="flex-1 p-3 space-y-2" style={{paddingBottom:"max(0.75rem, env(safe-area-inset-bottom))"}}>{children}</div>
    </aside>
  </div>;
}
// لون ثابت لكل نوع إشعار: شريط جانبي ملوّن مع خلفية فاتحة تحافظ على قراءة النص
const NOTICE_COLORS = {
  expense: { bar: "#C0392B", bg: "#FCEDEB" },
  income: { bar: "#2E8B57", bg: "#E8F5EC" },
  debt: { bar: "#E0A100", bg: "#FFF3D1" },
  payment: { bar: "#2F6FB5", bg: "#E7F0FA" },
  support: { bar: "#8C949C", bg: "#EEF0F2" },
  other: { bar: "#A0713D", bg: "#F0E4D3" },
};
const NOTICE_COLORS_DARK = {
  expense: { bar: "#E0675F", bg: "#3A2220" }, income: { bar: "#4CB07E", bg: "#1B3326" }, debt: { bar: "#E3B13A", bg: "#3A3119" },
  payment: { bar: "#5B93DC", bg: "#1C2B40" }, support: { bar: "#9AA3AB", bg: "#252C30" }, other: { bar: "#C79A66", bg: "#352B1F" },
};
const OP_LABEL = { income: "دخل", expense: "مصروف", debt: "دين", payment: "سداد", support: "طلب دعم" };
const TAB_OF = { income: "incomes", expense: "expenses", debt: "debts", payment: "payments", support: "support" };
const fmtClock = (iso) => { const d = new Date(iso); return isNaN(d) ? "" : `${LRI}${pad2(d.getHours())}:${pad2(d.getMinutes())}${PDI}`; };
const fmtDMY = (iso) => { const p = dateParts(iso); return p ? `${LRI}${pad2(p.d)}/${pad2(p.m)}/${p.y}${PDI}` : ""; };
// صيغة الإشعار: نوع العملية + اسم العامل + الوقت + التاريخ — مثال: مصروف أحمد 12:56 03/11/2026
const noticeLine = (kind, item) => [OP_LABEL[kind], item.workerName, fmtClock(item.createdAt), fmtDMY(item.createdAt)].filter(Boolean).join(" ");

function useDismissed(key) {
  const read = () => { try { return JSON.parse(localStorage.getItem(key) || "[]"); } catch { return []; } };
  const [ids, setIds] = useState(read);
  useEffect(() => { setIds(read()); }, [key]);
  const add = (id) => setIds((prev) => { const next = [...prev, id].slice(-300); try { localStorage.setItem(key, JSON.stringify(next)); } catch {} return next; });
  return [ids, add];
}

// إشعار أصفر: انتهى وقت الدخل لأيام سابقة دون تسجيل دخل فيها
function missedIncomeLines({ incomes, ready, hours = {} }) {
  if (!ready || toMinutes(hours.incomeEnd) === null) return [];
  const setAt = Date.parse(hours.hoursSetAt) || 0;
  const created = Date.parse(hours.createdAt) || 0;
  const lookback = setAt ? 3 : 1;
  const base = new Date(todayISO() + "T12:00:00");
  const out = [];
  for (let n = 1; n <= lookback; n++) {
    const d = new Date(base); d.setDate(d.getDate() - n);
    const key = localISO(d);
    // لحظة إغلاق يوم العمل: في نافذة تعبر منتصف الليل تقع صباح اليوم التالي
    const close = closeInstant(key, { start: hours.incomeStart, end: hours.incomeEnd });
    if (!close) continue;
    const t = close.getTime();
    if (t > Date.now() || (setAt && t < setAt) || (created && t < created)) continue;
    if (incomes.some((i) => i.date === key)) continue;
    out.push({ id: `warn-income-${key}`, warn: true, tab: "incomes", ts: t, text: `⚠️ لم يُسجَّل دخل يوم ${fmtDMY(key + "T12:00:00")}`, sub: `انتهى وقت الدخل ${hours.incomeEnd}` });
  }
  return out;
}

// صف قابل للسحب لليسار؛ يُحذف إذا تجاوز السحب 60% من عرضه
function SwipeRow({ children, onDismiss, threshold = 0.6 }) {
  const ref = useRef(null);
  const st = useRef({ active: false, x0: 0, y0: 0, dx: 0, dir: null });
  const [dx, setDx] = useState(0);
  const [drag, setDrag] = useState(false);
  const width = () => ref.current?.offsetWidth || 320;
  const down = (e) => { st.current = { active: true, x0: e.clientX, y0: e.clientY, dx: 0, dir: null }; };
  const move = (e) => {
    const s = st.current; if (!s.active) return;
    const mx = e.clientX - s.x0, my = e.clientY - s.y0;
    if (!s.dir && (Math.abs(mx) > 8 || Math.abs(my) > 8)) s.dir = Math.abs(mx) > Math.abs(my) * 1.2 ? "x" : "y";
    if (s.dir === "x") {
      if (!drag) { setDrag(true); try { e.currentTarget.setPointerCapture(e.pointerId); } catch {} }
      s.dx = Math.min(0, mx); setDx(s.dx);
    }
  };
  const up = () => {
    const s = st.current; if (!s.active) return; s.active = false; setDrag(false);
    if (s.dir === "x" && -s.dx >= width() * threshold) { setDx(-width() * 1.1); setTimeout(onDismiss, 180); }
    else setDx(0);
  };
  const progress = Math.min(1, -dx / (width() * threshold));
  return (
    <div ref={ref} className="relative overflow-hidden rounded-2xl" style={{ touchAction: "pan-y" }}>
      <div className="absolute inset-0 flex items-center justify-end px-5 text-[13px] font-black text-white" style={{ background: COLORS.expense, opacity: progress }}>🗑 حذف</div>
      <div onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
        style={{ transform: `translateX(${dx}px)`, transition: drag ? "none" : "transform .18s ease-out", position: "relative" }}>
        {children}
      </div>
    </div>
  );
}

function NotificationModal({ lines, onClose, onPick, onDismiss }) {
  const dark = COLORS.mode === "dark";
  const pal = dark ? NOTICE_COLORS_DARK : NOTICE_COLORS;
  const warnText = dark ? "#FFE9A0" : "#7A5B00";
  return <Modal title="الإشعارات" onClose={onClose}>
    {lines.length === 0
      ? <div className="text-sm py-8 text-center" style={{ color: COLORS.inkSoft }}>لا توجد إشعارات</div>
      : <>
        <p className="text-[11px] mb-2" style={{ color: COLORS.inkSoft }}>اسحب الإشعار لليسار لحذفه من القائمة</p>
        <div className="space-y-2">{lines.map((n) => (
          <SwipeRow key={n.id} onDismiss={() => onDismiss(n.id)}>
            <Card className={`p-3 ${onPick && n.tab ? "cursor-pointer" : ""}`} onClick={onPick && n.tab ? () => onPick(n.tab) : undefined}
              style={n.warn
                ? { background: dark ? "#5A4A12" : "#FFE680", border: `2px solid ${dark ? "#E3B13A" : "#D4A017"}` }
                : (() => { const c = pal[n.kind] || pal.other; return { background: c.bg, borderColor: c.bar, borderInlineStartWidth: "6px" }; })()}>
              <div className="text-[14px] font-bold" style={n.warn ? { color: warnText } : undefined}>{n.text}</div>
              {n.sub && <div className="text-[11px] mt-1" style={{ color: n.warn ? warnText : COLORS.inkSoft }}>{n.sub}</div>}
            </Card>
          </SwipeRow>
        ))}</div>
      </>}
  </Modal>;
}
function CalculatorModal({onClose}){
  const [v,setV]=useState("");
  // الترتيب كما يظهر من اليسار إلى اليمين: الأرقام ثم عمود العمليات على اليمين (جهة البداية في الواجهة العربية)
  const keys=["7","8","9","÷","4","5","6","×","1","2","3","−","0",".","C","+"];
  const isOp=k=>["÷","×","−","+"].includes(k);
  function press(k){
    if(k==="C")return setV("");
    if(k==="="){try{const x=v.replaceAll("×","*").replaceAll("÷","/").replaceAll("−","-");setV(String(Function(`return (${x})`)()))}catch{setV("خطأ")}return}
    setV(x=>x+k);
  }
  const keyStyle=k=>({
    background:k==="="?COLORS.income:isOp(k)?COLORS.goldBg:k==="C"?"#FBEAE9":COLORS.card,
    color:k==="="?"#fff":k==="C"?COLORS.expense:isOp(k)?COLORS.gold:COLORS.ink,
    border:`1px solid ${COLORS.line}`,
    height:"clamp(54px, 15vw, 70px)",
    fontSize:"clamp(24px, 7.5vw, 32px)",
    lineHeight:1,
    padding:0,
    fontFamily:"'JetBrains Mono','Menlo',monospace",
  });
  return <Modal title="آلة حاسبة" onClose={onClose}>
    <div className="rounded-xl px-4 py-3 mb-3 text-left font-black overflow-x-auto whitespace-nowrap" dir="ltr" style={{background:COLORS.card,border:`1px solid ${COLORS.line}`,minHeight:68,fontSize:"clamp(28px, 9vw, 38px)",lineHeight:"1.3",fontFamily:"'JetBrains Mono','Menlo',monospace"}}>{v||"0"}</div>
    <div className="grid grid-cols-4 gap-2" dir="ltr">
      {keys.map(k=><button key={k} onClick={()=>press(k)} className="rounded-xl font-black flex items-center justify-center transition active:scale-95" style={keyStyle(k)}>{k}</button>)}
      <button onClick={()=>press("=")} className="rounded-xl font-black col-span-4 flex items-center justify-center transition active:scale-95" style={keyStyle("=")}>=</button>
    </div>
  </Modal>
}
const HEX6 = /^#[0-9a-fA-F]{6}$/;
function SwitchRow({ label, on, onChange }) {
  return <button type="button" role="switch" aria-checked={on} onClick={() => onChange(!on)} className="w-full flex items-center justify-between py-2">
    <span className="text-[13px] font-bold">{label}</span>
    <span className="w-11 h-6 rounded-full relative transition" style={{ background: on ? COLORS.income : COLORS.line }}><span className="absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all" style={{ [on ? "left" : "left"]: on ? 22 : 2 }} /></span>
  </button>;
}

// شفافية لون الظل = قوة الظل
const shadowAlpha = (t, key) => { const p = t.paints && t.paints[key]; return p ? normalizePaint(p).alpha : 1; };
const shadowOf = (t, kind) => {
  if (kind === "card") return t.cardShadowOn !== false ? `0 2px 10px ${hexA(t.cardShadowColor, 0.16 * shadowAlpha(t, "cardShadowColor"))}` : "none";
  return t.btnShadowOn ? `0 3px 10px ${hexA(t.btnShadowColor, 0.28 * shadowAlpha(t, "btnShadowColor"))}` : "none";
};
function ThemePreview({ t }) {
  const P = (k) => paintCssOf(t, k);
  const backdrop = isHexColor(t.bg) ? t.bg : "#FFFFFF";
  const hexesOf = (k) => paintStopHexes(effectivePaint(t, k), backdrop);
  const tabs = [["التقارير", "markReports"], ["المداخيل", "markIncomes"], ["السداد", "markPayments"]];
  const side = t.tabMarkPos === "side";
  const tabFg = textOnAll(hexesOf("tabBg"), t.ink, 3);
  const incKey = t.txMarkIncome ? "txMarkIncome" : "markIncomes";
  const supKey = (t.supplierPaletteA || [])[0] ? "supplierPaletteA.0" : "supplierCard";
  const incTone = cardToneAll(hexesOf("incomeCard"), t.ink, t.inkSoft), supTone = cardToneAll(hexesOf(supKey), t.ink, t.inkSoft);
  return (
    <div className="rounded-2xl overflow-hidden" style={{ background: P("bg"), border: `1px solid ${t.line}` }}>
      <div className="px-4 py-2.5 flex items-center justify-between" style={{ background: P("bar"), color: textOnAll(hexesOf("bar"), "#FFFFFF", 4.5) }}><span className="text-[13px] font-black">معاينة قبل الاعتماد</span><span className="text-[11px] opacity-80">دفتر</span></div>
      <div className="p-3 grid grid-cols-3 gap-2">
        {tabs.map(([l, k], i) => (
          <div key={k} className="relative overflow-hidden rounded-xl h-[54px] flex items-center justify-center text-[12px] font-extrabold" style={{ background: P("tabBg"), color: tabFg, border: `${i === 0 ? 2 : 1}px solid ${i === 0 ? t[k] : t.line}`, boxShadow: shadowOf(t, "btn") }}>
            <span className={side ? "absolute top-0 bottom-0 right-0 w-[5px]" : "absolute top-0 inset-x-0 h-[5px]"} style={{ background: P(k) }} />{l}
          </div>
        ))}
      </div>
      <div className="px-3 pb-3 space-y-2">
        <div className="relative overflow-hidden rounded-2xl p-3 pr-5" style={{ background: P("incomeCard"), border: `1px solid ${t.line}`, boxShadow: shadowOf(t, "card") }}>
          <span className="absolute top-0 bottom-0 right-0 w-[5px]" style={{ background: P(incKey) }} />
          <div className="text-[13px] font-bold" style={{ color: incTone.ink }}>دخل اليوم · 2,000 دج</div>
          <div className="text-[11px]" style={{ color: incTone.soft }}>{fmtDate("2026-10-11")} · الأحد</div>
        </div>
        <div className="rounded-2xl p-3" style={{ background: P(supKey), border: `1px solid ${t.line}`, boxShadow: shadowOf(t, "card") }}>
          <div className="text-[13px] font-black" style={{ color: supTone.ink }}>مورد تجريبي</div>
          <div className="text-[11px]" style={{ color: supTone.soft }}>كارد المورد</div>
        </div>
        <div className="rounded-xl py-2.5 text-center text-[13px] font-bold" style={{ background: P("button"), color: textOnAll(hexesOf("button"), t.buttonText, 3), boxShadow: shadowOf(t, "btn") }}>زر رئيسي</div>
      </div>
    </div>
  );
}

// عناصر خلفيتها تحمل نصًا: يُحذَّر في المنتقي إن تعذّر ضمان قراءة النص فوقها
const TEXT_OVER = new Set(["bg", "bar", "card", "button", "tabBg", "incomeCard", "expenseCard", "debtCard", "paymentCard", "supplierCard", "reportCards.0", "reportCards.1", "reportCards.2", "reportCards.3", "supplierPaletteA.0", "supplierPaletteB.0"]);
const pickerUi = () => ({
  ink: COLORS.inkHex, soft: COLORS.inkSoftHex, line: COLORS.line, bg: COLORS.bg, card: COLORS.card, tint: COLORS.goldBg,
  btn: COLORS.button || COLORS.inkHex, btnText: legibleOn(COLORS.button || COLORS.inkHex, COLORS.buttonText || "#FFFFFF"),
  solid: COLORS.solid, solidText: textOn(COLORS.solid, "#FFFFFF"), danger: COLORS.expense,
});
// حقل لون واحد لكل عنصر: يعرض اللون الحالي ويفتح المنتقي المتقدم. التدرج لا يُعرض إلا لما يرسمه التطبيق فعليًا بخاصية background.
// follow: مفتاح علامة القسم التي يتبعها الحقل الاختياري حين يكون فارغًا (علامة كرت العملية)
function PaintField({ label, pk, t, setT, hint, follow }) {
  const [open, setOpen] = useState(false);
  const info = fieldInfo(pk);
  const hex = getHexAt(t, pk);
  const following = !!follow && !hex;
  const paint = following ? effectivePaint(t, follow) : effectivePaint(t, pk, COLORS.inkHex);
  const css = paintToCss(paint);
  const summary = paint.kind === "linear"
    ? `تدرج · ${paint.stops.length} نقاط · ${Math.round(paint.angle)}°`
    : `${paint.color}${paint.alpha < 0.999 ? ` · ${Math.round(paint.alpha * 100)}%` : ""}${following ? " (يتبع الزر)" : ""}`;
  return (
    <div className="mb-3">
      <div className="text-[13px] mb-1 font-bold" style={{ color: COLORS.inkSoft }}>{label}</div>
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => setOpen(true)} aria-label={`تغيير ${label}`} className="flex-1 min-w-0 flex items-center gap-3 rounded-xl px-3 py-2 text-right" style={{ background: COLORS.inputBg || "#fff", border: `1px solid ${COLORS.line}`, color: COLORS.ink }}>
          <PaintSwatch css={css} className="w-12 h-8 rounded-lg shrink-0" style={{ border: `1px solid ${COLORS.line}` }} />
          <span dir="ltr" className="flex-1 min-w-0 truncate text-[12px] font-bold text-left" style={{ color: COLORS.inkSoft }}>{summary}</span>
          <Ico n="color-wheel" size={22} />
        </button>
        {follow && hex ? <button type="button" onClick={() => setT((x) => ({ ...clearPaintInTheme(x, pk), [pk]: "" }))} className="text-[11px] font-bold px-3 py-2 rounded-lg shrink-0" style={{ background: COLORS.goldBg, color: COLORS.gold }}>اتباع الزر</button> : null}
      </div>
      {hint && <div className="text-[11px] mt-1" style={{ color: COLORS.inkSoft }}>{hint}</div>}
      {open && <PaintPicker title={label} value={paint} allowGradient={info.gradient} minAlpha={info.minAlpha || 0} showAlpha={info.alpha !== false}
        backdrop={isHexColor(t.bg) ? t.bg : "#FFFFFF"} textOver={TEXT_OVER.has(pk)} ui={pickerUi()} icon={<Ico n="color-wheel" size={26} />}
        onApply={(p) => { setT((x) => setPaintInTheme(x, pk, p)); setOpen(false); }} onClose={() => setOpen(false)} />}
    </div>
  );
}
// يحذف الطلاءات المخزَّنة لمفاتيح معيّنة (عند فرض ألوان من قالب أو إصلاح تباين أو استعادة الافتراضي) كي لا تعود فوقها
const dropPaints = (paints, keys) => { const out = { ...(paints || {}) }; Object.keys(out).forEach((k) => { if (keys.includes(String(k).split(".")[0])) delete out[k]; }); return out; };

function CustomizationTab({ theme, onSave, showToast }) {
  const [t, setT] = useState(() => readTheme());
  const dirty = JSON.stringify(t) !== JSON.stringify(readTheme());
  const reports = t.reportCards || DEFAULT_THEME.reportCards;
  const save = () => { onSave(t); showToast("تم حفظ التخصيص"); };
  const dark = t.mode === "dark";
  const audit = auditTheme(t);
  const MARKS = [["markReports", "التقارير"], ["markIncomes", "المداخيل"], ["markExpenses", "المصروفات"], ["markDebts", "الديون"], ["markPayments", "السداد"], ["markSuppliers", "الموردين"]];
  const TXM = [["txMarkIncome", "markIncomes", "علامة كرت الدخل"], ["txMarkExpense", "markExpenses", "علامة كرت المصروف"], ["txMarkDebt", "markDebts", "علامة كرت الدين"], ["txMarkPayment", "markPayments", "علامة كرت السداد"]];
  const reset = () => setT((x) => {
    const d = {}; const done = [];
    Object.keys(DEFAULT_THEME).forEach((k) => { if (!["categories", "shopIcon", "mode", "lightBackup", "darkV", "paints"].includes(k) && !(dark && DARK_KEYS.includes(k))) { d[k] = DEFAULT_THEME[k]; done.push(k); } });
    return { ...x, ...d, paints: dropPaints(x.paints, done) };
  });
  const F = (label, pk, extra) => <PaintField key={pk} label={label} pk={pk} t={t} setT={setT} {...(extra || {})} />;
  return <div className="space-y-4">
    <h2 className="text-[18px] font-black flex items-center gap-2"><Ico n="color-wheel" size={26} />تخصيص المظهر</h2>
    <ThemePreview t={t} />
    <div className="grid grid-cols-3 gap-2 sticky top-2 z-10">
      <Button className="col-span-2" disabled={!dirty} onClick={save}>اعتماد التغييرات</Button>
      <Button variant="ghost" disabled={!dirty} onClick={() => setT(readTheme())}>تراجع</Button>
    </div>

    <Card className="p-4">
      <h3 className="font-black mb-1">فحص التباين</h3>
      <p className="text-[12px] mb-3" style={{ color: COLORS.inkSoft }}>النص داخل كل كارد يتكيّف تلقائيًا مع لونه. هذا الفحص يخص الألوان الأساسية فقط.</p>
      <div className="space-y-1.5">
        {audit.map((r) => (
          <div key={r.label} className="flex items-center justify-between gap-2 text-[12px]">
            <span className="flex items-center gap-2 min-w-0"><span className="w-7 h-7 rounded-md flex items-center justify-center font-black shrink-0" style={{ background: r.bg, color: r.fg, border: `1px solid ${COLORS.line}` }}>أ</span><span className="truncate">{r.label}</span></span>
            <span className="font-bold shrink-0" dir="ltr" style={{ color: r.ok ? COLORS.okText : COLORS.expense }}>{r.ratio.toFixed(1)}:1 {r.ok ? "✓" : `< ${r.min}`}</span>
          </div>
        ))}
      </div>
      {audit.some((r) => !r.ok) && <Button className="w-full mt-3" onClick={() => setT((x) => { const fx = autoFixTheme(x); const changed = ["bg", "card", "ink", "inkSoft", "weekLine", "line"].filter((k) => fx[k] !== x[k]); return { ...x, ...fx, paints: dropPaints(x.paints, changed) }; })}>إصلاح التباين تلقائيًا</Button>}
    </Card>

    <Card className="p-4">
      <h3 className="font-black mb-1">قوالب جاهزة</h3>
      <p className="text-[12px] mb-3" style={{ color: COLORS.inkSoft }}>{dark ? "عطّل الوضع الداكن لاستخدام القوالب." : "تغيّر الألوان الأساسية فقط، ثم عدّل أي عنصر على حدة."}</p>
      <div className="grid grid-cols-3 gap-2">{Object.entries(THEME_PRESETS).map(([id, pr]) => <Button key={id} variant="ghost" disabled={dark} className="!text-[13px]" onClick={() => setT((x) => ({ ...x, ...pr.colors, paints: dropPaints(x.paints, Object.keys(pr.colors)) }))}>{pr.label}</Button>)}</div>
    </Card>

    <Card className="p-4"><h3 className="font-black mb-3">لون الخطوط</h3>
      {F("الخطوط الرئيسية", "ink")}
      {F("الخطوط الثانوية", "inkSoft")}
    </Card>

    <Card className="p-4"><h3 className="font-black mb-3">الأزرار الرئيسية العلوية</h3>
      {F("خلفية الأزرار", "tabBg", { hint: "خلفية هادئة؛ ويمكن أن تكون تدرجًا." })}
      <Field label="موضع العلامة الملونة"><Chips value={t.tabMarkPos || "top"} onChange={(v) => setT((x) => ({ ...x, tabMarkPos: v }))} options={[["top", "أعلى الزر"], ["side", "جانب الزر"]]} /></Field>
      {MARKS.map(([k, l]) => F(`علامة زر ${l}`, k))}
    </Card>

    <Card className="p-4"><h3 className="font-black mb-1">العلامة الجانبية لكروت العمليات</h3>
      <p className="text-[12px] mb-3" style={{ color: COLORS.inkSoft }}>تتبع لون زر القسم افتراضيًا، ويمكنك تخصيصها بشكل مستقل.</p>
      {TXM.map(([k, from, l]) => F(l, k, { follow: from }))}
      {F("خط الفصل بين الأسابيع", "weekLine")}
    </Card>

    <Card className="p-4"><h3 className="font-black mb-2">ظلال الكروت والأزرار</h3>
      <SwitchRow label="تفعيل ظلال الكاردات" on={t.cardShadowOn !== false} onChange={(v) => setT((x) => ({ ...x, cardShadowOn: v }))} />
      {F("لون ظل الكاردات", "cardShadowColor", { hint: "الشفافية = قوة الظل." })}
      <SwitchRow label="تفعيل ظلال الأزرار" on={!!t.btnShadowOn} onChange={(v) => setT((x) => ({ ...x, btnShadowOn: v }))} />
      {F("لون ظل الأزرار", "btnShadowColor", { hint: "الشفافية = قوة الظل." })}
    </Card>

    <Card className="p-4"><h3 className="font-black mb-3">الألوان الأساسية</h3>
      {F("الخلفية", "bg")}
      {F("الكاردات العامة", "card")}
      {F("الأشرطة", "bar")}
      {F("أزرار الإجراءات (حفظ، إضافة…)", "button")}
      {F("لون نص أزرار الإجراءات", "buttonText")}
      {F("القائمة والفترة", "navButton")}
      {F("حدود العناصر", "line")}
    </Card>
    <Card className="p-4"><h3 className="font-black mb-3">ألوان الكاردات الأساسية</h3>{[["incomeCard", "كارد الدخل"], ["expenseCard", "كارد المصروف"], ["debtCard", "كارد الدين"], ["paymentCard", "كارد السداد"], ["supplierCard", "كارد المورد"]].map(([k, l]) => F(l, k))}</Card>
    <Card className="p-4"><h3 className="font-black mb-3">كاردات التقارير — كل كارد مستقل</h3>{reports.map((c, i) => F(["صافي الربح", "إجمالي المصاريف", "إجمالي الدخل", "إجمالي الديون"][i], `reportCards.${i}`))}</Card>
    <Card className="p-4"><h3 className="font-black mb-3">كاردات الموردين — مجموعتان بالتناوب</h3><p className="text-xs mb-3" style={{ color: COLORS.inkSoft }}>الكارد 1 = اللون A، الكارد 2 = اللون B، الكارد 3 = A وهكذا.</p>
      {F("لون الكروت الفردية (A)", "supplierPaletteA.0")}
      {F("لون الكروت الزوجية (B)", "supplierPaletteB.0")}
    </Card>
    <Card className="p-4"><h3 className="font-black mb-3">أيقونة المتجر والتصنيفات</h3>
      <Field label="رمز أيقونة المتجر"><TextInput value={t.shopIcon || "د"} onChange={(e) => setT((x) => ({ ...x, shopIcon: e.target.value.slice(0, 3) }))} /></Field>
      <Field label="التصنيفات — واحد في كل سطر"><TextArea value={(t.categories || []).join("\n")} onChange={(e) => setT((x) => ({ ...x, categories: e.target.value.split("\n").map((y) => y.trim()).filter(Boolean) }))} rows={5} /></Field>
    </Card>
    <Button variant="ghost" className="w-full" onClick={reset}>استعادة ألوان المظهر الافتراضية</Button>
  </div>;
}
function NotificationScheduler(){const [name,setName]=useState("");const [tone,setTone]=useState("افتراضي");const [repeat,setRepeat]=useState("مرة واحدة");const [duration,setDuration]=useState("5");const [list,setList]=useState(()=>{try{return JSON.parse(localStorage.getItem("daftar_custom_notifications")||"[]")}catch{return[]}});function add(){if(!name)return;const n=[...list,{id:Date.now(),name,tone,repeat,duration}];setList(n);localStorage.setItem("daftar_custom_notifications",JSON.stringify(n));setName("")}return <><Field label="اسم الإشعار"><TextInput value={name} onChange={e=>setName(e.target.value)} placeholder="مثال: تذكير إغلاق المحل"/></Field><div className="grid grid-cols-3 gap-2"><Field label="النغمة"><select value={tone} onChange={e=>setTone(e.target.value)} className={inputCls} style={inputStyle}><option>افتراضي</option><option>هادئ</option><option>تنبيه</option></select></Field><Field label="التكرار"><select value={repeat} onChange={e=>setRepeat(e.target.value)} className={inputCls} style={inputStyle}><option>مرة واحدة</option><option>يومي</option><option>أسبوعي</option><option>كل ساعة</option></select></Field><Field label="المدة"><TextInput value={duration} onChange={e=>setDuration(e.target.value)} inputMode="numeric"/></Field></div><Button variant="ghost" className="w-full" onClick={add}>+ إضافة إشعار</Button>{list.length>0&&<div className="mt-3 space-y-1">{list.map(n=><div key={n.id} className="flex items-center justify-between rounded-lg px-3 py-2" style={{background:COLORS.card,border:`1px solid ${COLORS.line}`}}><span className="text-xs">{n.name} · {n.repeat} · {n.duration}</span><button onClick={()=>{const x=list.filter(a=>a.id!==n.id);setList(x);localStorage.setItem("daftar_custom_notifications",JSON.stringify(x))}} style={{color:COLORS.expense}}>حذف</button></div>)}</div>}</>}

function SettingsTab({ bioAuto, onToggleBio, onSetGatePin, onMigrate, storeName, showToast, incomes, expenses, debts, payments, supportRequests, suppliers = [], supplierTransactions = [], adminPin, onSavePin, theme, onSaveTheme }) {
  const [pinDraft, setPinDraft] = useState("");
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [importing, setImporting] = useState(false);
  const [confirmImport, setConfirmImport] = useState(null); // { data, fileName }
  const importInputId = useId();

  const [confirmExport, setConfirmExport] = useState(false);
  function handleExport() {
    setConfirmExport(false);
    const payload = {
      exportedAt: nowISO(),
      app: "daftar",
      version: 2,
      incomes, expenses, debts, payments, supportRequests, suppliers, supplierTransactions,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `daftar-backup-${todayISO()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast("تم إنشاء ملف النسخة الاحتياطية");
  }

  function handleImportFile(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!data || typeof data !== "object") throw new Error("bad");
        setConfirmImport({ data, fileName: file.name });
      } catch (err) {
        showToast("ملف النسخة الاحتياطية غير صالح");
      }
    };
    reader.readAsText(file);
  }

  async function runImport() {
    const data = confirmImport.data;
    setConfirmImport(null);
    setImporting(true);
    try {
      const groups = [
        ["income", data.incomes], ["expense", data.expenses], ["debt", data.debts],
        ["payment", data.payments], ["support", data.supportRequests], ["supplier", data.suppliers], ["supplierTransaction", data.supplierTransactions],
      ];
      let added = 0, skipped = 0, noId = 0;
      for (const [kind, list] of groups) {
        for (const rec of Array.isArray(list) ? list : []) {
          const { id, ...rest } = rec;
          if (id) { (await restoreItem(kind, id, rest)) ? added++ : skipped++; } // نفس المعرّف ← يُتخطى إن كان موجودًا
          else { await addItem(kind, rest); added++; noId++; }                   // نسخة قديمة بلا معرّفات
        }
      }
      showToast(`أُضيف ${added} وتُخطّي ${skipped} موجودًا${noId ? ` · ${noId} بلا معرّف` : ""}`);
    } catch (err) {
      showToast("تعذّر الاستيراد بالكامل — تحقق من الاتصال بالإنترنت");
    } finally {
      setImporting(false);
    }
  }

  const [pwOpen, setPwOpen] = useState(false);
  const [gNew, setGNew] = useState(""); const [gConf, setGConf] = useState(""); const [gBusy, setGBusy] = useState(false); const [gErr, setGErr] = useState("");
  const [migrating, setMigrating] = useState(false);

  return (
    <div>
      <h2 className="text-[15px] font-extrabold mb-2">الإعدادات</h2>
      <Card className="p-4">
        <h3 className="text-[14px] font-extrabold mb-3">كلمة مرور الأدمن</h3>
        <Button className="w-full" onClick={() => setPwOpen(true)}>تغيير كلمة المرور</Button>
      </Card>
      {pwOpen && <ChangePasswordModal label="كلمة المرور" minLen={8} onClose={() => setPwOpen(false)} showToast={showToast} />}

      <Card className="p-4 mt-4">
        <h3 className="text-[14px] font-extrabold mb-1">ترحيل البيانات القديمة</h3>
        <p className="text-[12px] mb-3" style={{ color: COLORS.inkSoft }}>ينقل كل السجلات التي لا تتبع أي متجر إلى المتجر الحالي ({storeName || "—"}). نفّذه مرة واحدة فقط بعد اختيار متجر pizza.</p>
        <Button variant="ghost" className="w-full" disabled={migrating} onClick={async () => { setMigrating(true); try { await onMigrate(); } catch { showToast("تعذّر الترحيل — تحقق من الاتصال والصلاحيات"); } finally { setMigrating(false); } }}>{migrating ? "جارٍ الترحيل..." : "ترحيل البيانات القديمة إلى هذا المتجر"}</Button>
      </Card>

      <Card className="p-4 mt-4">
        <h3 className="text-[14px] font-extrabold mb-1">أمان الأدمن — PIN إظهار نموذج الأدمن</h3>
        <p className="text-[12px] mb-3" style={{ color: COLORS.inkSoft }}>يظهر فورم الأدمن عند كتابة هذا الـPIN في خانتي «اسم الدخول» و«الرمز السري» معًا في شاشة الدخول، ويتذكر الهاتف ذلك. الافتراضي 000000 حتى تغيّره، وبعد تغييره لا يصلح القديم. هو إخفاء للواجهة وليس بديلًا عن كلمة المرور.</p>
        <TextInput type="password" inputMode="numeric" maxLength={6} value={gNew} onChange={e => setGNew(e.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="PIN جديد (6 أرقام)" dir="ltr" style={{ textAlign: "center", letterSpacing: "6px" }} />
        <div className="h-2" />
        <TextInput type="password" inputMode="numeric" maxLength={6} value={gConf} onChange={e => setGConf(e.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="أعد كتابة PIN" dir="ltr" style={{ textAlign: "center", letterSpacing: "6px" }} />
        {gErr && <p className="text-[13px] mt-2" style={{ color: COLORS.expense }}>{gErr}</p>}
        <Button className="w-full mt-3" disabled={gBusy || gNew.length !== 6 || gNew !== gConf} onClick={async () => { setGBusy(true); setGErr(""); try { await onSetGatePin(gNew); setGNew(""); setGConf(""); } catch (e) { setGErr(authErrorMessage(e)); } finally { setGBusy(false); } }}>حفظ PIN</Button>
        {gConf.length === 6 && gNew !== gConf && <p className="text-[12px] mt-2" style={{ color: COLORS.expense }}>الرقمان غير متطابقين</p>}
      </Card>

      <Card className="p-4 mt-4">
        <div className="flex items-center justify-between gap-3">
          <div><h3 className="text-[14px] font-extrabold">تفعيل تسجيل الدخول بالبصمة</h3><p className="text-[12px] mt-1" style={{ color: COLORS.inkSoft }}>عند التفعيل تظهر نافذة البصمة مباشرة عند فتح التطبيق المقفل. تبقى كلمة المرور بديلًا. يفرض الهاتف نفسه أي تأكيد أمني.</p></div>
          <button role="switch" aria-checked={!!bioAuto} onClick={() => onToggleBio(!bioAuto)} className="shrink-0 w-12 h-7 rounded-full relative transition" style={{ background: bioAuto ? COLORS.income : COLORS.line }}>
            <span className="absolute top-0.5 w-6 h-6 rounded-full bg-white shadow transition-all" style={{ right: bioAuto ? "calc(100% - 26px)" : "2px" }} />
          </button>
        </div>
      </Card>

      <AdminDevicesCard showToast={showToast} />

      <Card className="p-4 mt-4">
        <h3 className="text-[14px] font-extrabold mb-3">رمز القفل السريع (على هذا الجهاز)</h3>
        <p className="text-[12px] mb-3" style={{color:COLORS.inkSoft}}>يستخدم كمسار دخول احتياطي للأدمن عند تعذّر كلمة المرور أو البصمة.</p>
        <TextInput type="password" inputMode="numeric" maxLength={8} value={pinDraft} onChange={e=>setPinDraft(e.target.value.replace(/\D/g,"").slice(0,8))} placeholder={adminPin ? "رمز محفوظ — اكتب رمزًا جديدًا للتغيير" : "مثال: 2580"} dir="ltr" style={{textAlign:"center",letterSpacing:"4px"}}/>
        <div className="grid grid-cols-2 gap-2 mt-2">
          <Button className="!py-2.5 !text-[13px]" disabled={pinDraft.length < 4} onClick={()=>{onSavePin(pinDraft);setPinDraft("");showToast("تم حفظ الرمز");}}>حفظ الرمز</Button>
          <Button variant="ghost" className="!py-2.5 !text-[13px]" disabled={!adminPin} onClick={()=>{onSavePin("");setPinDraft("");showToast("تم حذف الرمز");}}>حذف الرمز</Button>
        </div>
      </Card>

      <Card className="p-4 mt-4">
        <h3 className="text-[14px] font-extrabold mb-1">نسخة احتياطية</h3>
        <p className="text-[12px] mb-3" style={{ color: COLORS.inkSoft }}>
          يمكنك حفظ كل البيانات الحالية في ملف على هاتفك، والرجوع إليه لاحقًا عند الحاجة.
        </p>
        <Button variant="ghost" className="w-full mb-3" onClick={() => setConfirmExport(true)}>⬇ تنزيل نسخة احتياطية (JSON)</Button>

        <label htmlFor={importInputId} className="w-full flex items-center justify-center gap-2 rounded-xl px-4 py-3 text-[15px] font-bold cursor-pointer" style={{ border: `1.5px dashed ${COLORS.line}`, color: COLORS.inkSoft }}>
          {importing ? "جارٍ الاستيراد..." : "⬆ استعادة من ملف نسخة احتياطية"}
        </label>
        <input id={importInputId} type="file" accept="application/json,.json" onChange={handleImportFile} className="sr-only" disabled={importing}
          style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0,0,0,0)" }} />
        <p className="text-[11px] mt-2" style={{ color: COLORS.inkSoft }}>
          الاستعادة تضيف سجلات النسخة كعمليات جديدة، ولا تحذف أي بيانات موجودة حاليًا.
        </p>
      </Card>

      {confirmExport && (
        <Modal title="إنشاء نسخة احتياطية" onClose={() => setConfirmExport(false)}>
          <p className="text-[14px] leading-7 mb-2">سيتم إنشاء ملف يحتوي كل بيانات هذا المتجر (الدخل والمصاريف والديون والسداد والموردين) وتنزيله على هاتفك.</p>
          <p className="text-[12px] leading-6 mb-5" style={{ color: COLORS.inkSoft }}>احتفظ بالملف في مكان آمن ولا تشاركه، فهو يتضمن أرقامًا مالية.</p>
          <div className="flex gap-2"><Button variant="ghost" className="flex-1" onClick={() => setConfirmExport(false)}>إلغاء</Button><Button className="flex-1" onClick={handleExport}>نعم، أنشئ وحمّل</Button></div>
        </Modal>
      )}
      {confirmImport && (
        <Modal title="تأكيد الاستيراد" onClose={() => setConfirmImport(null)}>
          <p className="text-[14px] mb-5">
            سيتم إضافة كل السجلات الموجودة في الملف "{confirmImport.fileName}" كعمليات جديدة في هذا الحساب. هل تريد المتابعة؟
          </p>
          <div className="flex gap-3">
            <Button variant="ghost" className="flex-1" onClick={() => setConfirmImport(null)}>إلغاء</Button>
            <Button className="flex-1" onClick={runImport}>استيراد</Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function PaymentsTab({ payments, debts, onConfirm, onReject, onEdit, onDelete }) {
  const pending = payments.filter((p) => p.status === "pending").slice().sort((a, b) => tsOf(b) - tsOf(a));
  const history = payments.filter((p) => p.status !== "pending");
  const byId = useMemo(() => new Map(debts.map((d) => [d.id, d])), [debts]);
  // الإجمالي من سجلات السداد المؤكدة فعليًا فقط (لا من قيمة الدين الأصلي)
  const cfg = {
    amount: (p) => (p.status === "confirmed" ? p.amount : 0), match: () => true, empty: "لا سدادات في هذه الفترة",
    stats: (list, range) => {
      const sm = paymentSummary(list, range);
      return [
        { span: true, label: "إجمالي السداد المؤكد", main: fmtMoney(sm.total), sub: `${sm.count} عملية سداد`, color: COLORS.paymentBtn, bg: paintBg("reportCards.2") },
        { label: "متوسط السداد اليومي", main: fmtMoney(sm.avgDaily), color: COLORS.income },
        { label: "سدادات مرفوضة", main: String(sm.rejected), color: COLORS.expense },
      ];
    },
  };
  return (
    <div>
      <h2 className="text-[15px] font-extrabold mb-2">طلبات السداد بانتظار التأكيد</h2>
      {pending.length === 0 && <div className="text-[13px] mb-6" style={{ color: COLORS.inkSoft }}>لا توجد طلبات بانتظار التأكيد</div>}
      <div className="space-y-2 mb-6">
        {pending.map((p) => {
          const d = byId.get(p.debtId);
          return (
            <TxCard key={p.id} kind="payment" className="p-3.5">
              <div className="flex items-center justify-between mb-2">
                <div className="text-[14px] font-bold">{d?.person || "—"}</div>
                <Fig style={{ color: COLORS.gold }}>{fmtMoney(p.amount)}</Fig>
              </div>
              {p.workerName && <div className="mb-1"><WorkerTag name={p.workerName} max={200} /></div>}
              <div className="text-[12px] mb-3" style={{ color: COLORS.inkSoft }}>{fmtDate(p.date)} · متبقي قبل السداد: <Fig>{fmtMoney(d?.remainingAmount)}</Fig></div>
              {createdNote(p)}
              <div className="flex gap-2 mt-2">
                <Button variant="income" className="flex-1 !py-2 !text-[13px]" onClick={() => onConfirm(p)}>تأكيد السداد</Button>
                <Button variant="danger" className="flex-1 !py-2 !text-[13px]" onClick={() => onReject(p)}>رفض</Button>
              </div>
            </TxCard>
          );
        })}
      </div>

      <h2 className="text-[15px] font-extrabold mb-2">سجل الدفعات</h2>
      <SectionView kind="payments" records={history} cfg={cfg} renderItem={(p) => {
        const d = byId.get(p.debtId);
        return (
          <TxCard key={p.id} kind="payment" className="p-3.5">
            <div className="flex items-start justify-between gap-3">
              <div className="text-[13px] leading-6 min-w-0" style={{ color: COLORS.inkSoft }}>
                <div className="font-bold" style={{ color: COLORS.ink }}>{d?.person || "—"}</div>
                <div><Fig>{fmtMoney(p.amount)}</Fig></div>
                {createdNote(p)}
              </div>
              <div className="flex flex-col items-center gap-1.5 shrink-0">
                <span className="text-[11px] px-2.5 py-1 rounded-full font-bold" style={{ background: COLORS.goldBg, color: COLORS.gold }}>{paymentStatusLabel(p.status)}</span>
                <WorkerTag name={p.workerName} />
                {p.status !== "confirmed" && <div className="flex gap-1.5">
                  <IconBtn glyph="edit" label="تعديل" onClick={() => onEdit(p)} />
                  <IconBtn glyph="trash" label="حذف" tone="danger" onClick={() => onDelete(p.id)} />
                </div>}
              </div>
            </div>
          </TxCard>
        );
      }} />
    </div>
  );
}

function SupportTab({ requests, onUpdate, onDelete, showToast }) {
  const [open, setOpen] = useState(null);
  return (
    <div>
      <div className="flex items-center justify-between mb-3"><h2 className="text-[18px] font-black">الشكاوى والطلبات</h2><span className="text-[12px]" style={{color:COLORS.inkSoft}}>{requests.length} طلب</span></div>
      {requests.length === 0 ? <div className="text-center py-10 text-[13px]" style={{ color: COLORS.inkSoft }}>لا توجد شكاوى أو طلبات</div> :
        <div className="space-y-2">
          {requests.slice().sort((a,b)=>tsOf(b)-tsOf(a)).map(r => (
            <Card key={r.id} className="p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0"><div className="font-extrabold text-[14px] truncate">{r.title || "بدون عنوان"}</div><div className="text-[11px] mt-1" style={{color:COLORS.inkSoft}}>{fmtDateTime(r.createdAt)} · {r.type === "complaint" ? "شكوى" : "طلب تغيير"}</div><div className="text-[11px] mt-1" style={{color:COLORS.inkSoft}}>{r.adminReply ? "تم الرد" : "بانتظار الرد"}</div></div>
                <div className="flex flex-col items-center gap-1 shrink-0"><span className="text-[10px] px-2 py-1 rounded-full font-bold" style={{ background: COLORS.goldBg, color: COLORS.gold }}>{supportStatusLabel(r.status)}</span>{r.workerName && <div className="text-[12px] font-bold" style={{color:COLORS.inkSoft}}><Ico n="person" size={13} className="inline-block align-text-bottom" /> {r.workerName}</div>}</div>
              </div>
              <div className="flex gap-2 mt-3"><Button className="flex-1 !py-2 !text-[12px]" onClick={async () => { setOpen(r); if (r.status === "new") { try { await onUpdate(r.id,{status:"in_review",readAt:nowISO()}); } catch {} } }}>قراءة والرد</Button><Button variant="danger" className="!py-2 !text-[12px]" onClick={() => onDelete(r.id)}>حذف</Button></div>
            </Card>
          ))}
        </div>}
      {open && <Modal title={open.title || "تفاصيل الطلب"} onClose={() => setOpen(null)} wide>
        <div className="text-[12px] mb-2" style={{color:COLORS.inkSoft}}>{fmtDateTime(open.createdAt)} · {open.type === "complaint" ? "شكوى" : "طلب تغيير"}</div>
        <div className="rounded-xl p-3 mb-4 leading-7 text-[14px]" style={{background:COLORS.surface,border:`1px solid ${COLORS.line}`}}>{open.description}</div>
        <div className="text-[11px] mb-3" style={{color:COLORS.inkSoft}}>سيتم حفظ الرد لنفس جهاز المرسل المرتبط بطلبه.</div>
        <AttachmentsView item={open} admin />
        <Field label="الحالة"><select value={open.status || "new"} onChange={e=>setOpen(o=>({...o,status:e.target.value}))} className={inputCls} style={inputStyle}><option value="new">جديد</option><option value="in_review">قيد المراجعة</option><option value="resolved">تم الحل</option><option value="rejected">مرفوض</option></select></Field>
        <Field label="الرد"><TextArea value={open.adminReply || ""} onChange={e=>setOpen(o=>({...o,adminReply:e.target.value}))} placeholder="اكتب الرد الذي سيظهر على هاتف المرسل..." rows={5}/></Field>
        <div className="flex gap-2"><Button className="flex-1" onClick={async()=>{await onUpdate(open.id,{status:open.status||"new",adminReply:open.adminReply||"",replyAt:nowISO()});showToast("تم حفظ الرد وإرساله لنفس الجهاز");setOpen(null)}}>حفظ وإرسال الرد</Button><Button variant="danger" onClick={async()=>{await onDelete(open.id);setOpen(null);showToast("تم حذف الشكوى")}}>حذف</Button></div>
      </Modal>}
    </div>
  );
}

function exportRows(type,data,name){
  const rows=[['النوع','التاريخ','الوصف/الشخص','المبلغ','الحالة','العامل'],...data.incomes.map(x=>['دخل',x.date,'دخل يومي',x.amount,'',x.workerName||'']),...data.expenses.map(x=>['مصروف',x.date,x.description,x.amount,x.category||'',x.workerName||'']),...data.debts.map(x=>['دين',x.date,x.person,x.amount,x.status||'',x.workerName||'']),...data.payments.map(x=>['سداد',x.date,x.debtId,x.amount,x.status||'',x.workerName||''])];
  if(type==='csv'){const csv='\ufeff'+rows.map(r=>r.map(v=>`"${String(v??'').replaceAll('"','""')}"`).join(',')).join('\n');downloadBlob(new Blob([csv],{type:'text/csv;charset=utf-8'}),name);return}
  const html='<table border="1" dir="rtl">'+rows.map(r=>'<tr>'+r.map(v=>`<td>${String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</td>`).join('')+'</tr>').join('')+'</table>';
  downloadBlob(new Blob(['\ufeff',html],{type:'application/vnd.ms-excel'}),name);
}
function downloadBlob(blob,name){const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),500)}

// ================= الفترات والفلاتر الموحّدة =================
const PERIODS5 = [["today", "يومية"], ["week", "أسبوعية"], ["month", "شهرية"], ["year", "سنوية"], ["custom", "فترة مخصصة"]];
const SEARCH_PERIODS = [["all", "كل الفترات"], ["today", "اليوم"], ["yesterday", "أمس"], ["week", "هذا الأسبوع"], ["month", "هذا الشهر"], ["year", "هذه السنة"], ["custom", "فترة مخصصة"]];
const isoAdd = (iso, n) => { const d = new Date(iso + "T12:00:00"); d.setDate(d.getDate() + n); return localISO(d); };
// حدود الفترة كتواريخ ISO (تُقارن نصيًا): [من، إلى]
function periodBounds(id, day, range) {
  const t = todayISO();
  const d = new Date(t + "T12:00:00");
  if (id === "today") { const x = day || t; return [x, x]; }
  if (id === "yesterday") { const y = isoAdd(t, -1); return [y, y]; }
  if (id === "week") { const k = (d.getDay() + 6) % 7; return [isoAdd(t, -k), isoAdd(t, 6 - k)]; }
  if (id === "month") return [localISO(new Date(d.getFullYear(), d.getMonth(), 1)), localISO(new Date(d.getFullYear(), d.getMonth() + 1, 0))];
  if (id === "year") return [`${d.getFullYear()}-01-01`, `${d.getFullYear()}-12-31`];
  if (id === "custom") return [range?.from || "0000-01-01", range?.to || "9999-12-31"];
  return ["0000-01-01", "9999-12-31"];
}

function PeriodPicker({ options = PERIODS5, value, onChange, day, onDay, range, onRange }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({ from: range?.from || "", to: range?.to || "" });
  const label = (options.find((o) => o[0] === value) || [])[1] || "";
  return (
    <div className="mb-4">
      <div className="relative">
        <button onClick={() => setOpen((v) => !v)} className="w-full rounded-xl px-4 py-2.5 flex items-center justify-between text-[14px] font-bold" style={{ background: COLORS.card, border: `1px solid ${COLORS.line}`, color: COLORS.ink }}>
          <span><span style={{ color: COLORS.inkSoft }}>الفترة: </span>{label}</span><span>▾</span>
        </button>
        {open && (
          <div className="absolute z-20 inset-x-0 rounded-2xl p-2 shadow-xl" style={{ top: "calc(100% + 4px)", background: COLORS.card, border: `1px solid ${COLORS.line}` }}>
            {options.map(([id, l]) => (
              <button key={id} onClick={() => { onChange(id); setOpen(false); }} className="w-full px-4 py-2.5 rounded-xl text-[14px] font-bold flex items-center justify-between" style={value === id ? { background: COLORS.goldBg, color: COLORS.ink } : { color: COLORS.ink }}>
                <span>{l}</span>{value === id && <span>✓</span>}
              </button>
            ))}
          </div>
        )}
      </div>
      {value === "custom" && onRange && (
        <div className="mt-2">
          <div className="grid grid-cols-1 gap-2">
            <Field label="من"><DateSelect value={draft.from} onChange={(v) => setDraft((d) => ({ ...d, from: v }))} /></Field>
            <Field label="إلى"><DateSelect value={draft.to} onChange={(v) => setDraft((d) => ({ ...d, to: v }))} /></Field>
          </div>
          <Button className="w-full" disabled={!draft.from || !draft.to || draft.from > draft.to} onClick={() => onRange(draft)}>عرض التقرير</Button>
        </div>
      )}
    </div>
  );
}

// ================= الأيقونات المرفقة =================
// الأيقونات البيضاء (قائمة/إشعار/إعدادات/بحث/دعم/خروج) تُعرض على بلاطة داكنة، والملوّنة على بلاطة فاتحة، دون تمديد أو تشويه.
const ICON_WHITE = new Set(["more", "notification", "logout", "settings", "search", "support"]);
// أيقونات سوداء الخطوط (القمر والاتصال): تُعكس فوق الخلفيات الداكنة كي لا تختفي
const ICON_BLACK = new Set(["moon", "call"]);
const iconSrc = (n) => `${import.meta.env.BASE_URL}icons/${n}.png`;
function Ico({ n, size = 24, className = "", style }) {
  const flip = ICON_BLACK.has(n) && COLORS.mode === "dark";
  return <img src={iconSrc(n)} alt="" draggable="false" className={`object-contain shrink-0 ${className}`} style={{ width: size, height: size, ...(flip ? { filter: "invert(1)" } : null), ...style }} />;
}
function IcoTile({ n, size = 44, danger = false }) {
  const white = ICON_WHITE.has(n);
  const bg = white ? (danger ? COLORS.expense : COLORS.bar) : COLORS.goldBg;
  const filter = ICON_BLACK.has(n) ? (isLight(bg) ? "none" : "invert(1)") : (white && !danger && isLight(bg) ? "invert(1)" : undefined);
  return <span className="relative flex items-center justify-center shrink-0" style={{ width: size, height: size, borderRadius: Math.round(size * 0.28), background: bg }}><Ico n={n} size={Math.round(size * (white ? 0.52 : 0.66))} style={filter ? { filter } : undefined} /></span>;
}
// أيقونات خطّية بديلة مؤقتة للأماكن التي لم تُرفق لها أيقونة (تعديل/حذف/صورة/بريد/تنزيل/رفع)
const GLYPHS = {
  edit: <><path d="M4 20h4L19 9l-4-4L4 16v4Z" /><path d="m13.5 6.5 4 4" /></>,
  trash: <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6" />,
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  palette: <><path d="M12 3a9 9 0 1 0 0 18c1.4 0 2-.9 2-1.8 0-1.2-.9-1.5-.9-2.6 0-1 .8-1.6 1.8-1.6H17a4 4 0 0 0 4-4c0-4.4-4-8-9-8Z" /><circle cx="7.5" cy="11" r="1" /><circle cx="10" cy="7" r="1" /><circle cx="15" cy="7" r="1" /></>,
  image: <><rect x="3" y="4" width="18" height="16" rx="3" /><circle cx="9" cy="10" r="1.6" /><path d="m4 18 5-5 4 4 3-3 4 4" /></>,
  mail: <><rect x="3" y="5" width="18" height="14" rx="3" /><path d="m4 7 8 6 8-6" /></>,
  download: <path d="M12 4v11m0 0-4-4m4 4 4-4M5 20h14" />,
  upload: <path d="M12 20V9m0 0-4 4m4-4 4 4M5 4h14" />,
  calendar: <><rect x="3" y="5" width="18" height="16" rx="3" /><path d="M8 3v4M16 3v4M3 10h18" /></>,
  filter: <path d="M4 5h16l-6 8v6l-4-2v-4L4 5Z" />,
};
function Glyph({ n, size = 18, stroke = 2 }) {
  return <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{GLYPHS[n]}</svg>;
}
function GlyphTile({ n, size = 44, danger = false }) {
  return <span className="flex items-center justify-center shrink-0" style={{ width: size, height: size, borderRadius: Math.round(size * 0.28), background: danger ? "rgba(0,0,0,.06)" : COLORS.goldBg, color: danger ? COLORS.expense : COLORS.ink }}><Glyph n={n} size={Math.round(size * 0.5)} /></span>;
}
function IconBtn({ glyph, label, onClick, tone = "gold" }) {
  const t = tone === "danger" ? { background: COLORS.dangerBg, color: COLORS.expense } : { background: COLORS.goldBg, color: COLORS.gold };
  return <button type="button" onClick={onClick} aria-label={label} className="w-9 h-9 rounded-full flex items-center justify-center" style={t}><Glyph n={glyph} size={16} /></button>;
}
function WorkerTag({ name, max = 84 }) {
  return <span className="inline-flex items-center gap-1 text-[11px] font-bold truncate" style={{ color: COLORS.inkSoft, maxWidth: max }} title="العامل"><Ico n="person" size={14} />{name || "—"}</span>;
}

// ================= كروت العمليات بعلامة جانبية =================
const TX_SECTION = { income: "markIncomes", expense: "markExpenses", debt: "markDebts", payment: "markPayments" };
const TX_OVERRIDE = { income: "txMarkIncome", expense: "txMarkExpense", debt: "txMarkDebt", payment: "txMarkPayment" };
// العلامة الجانبية تتبع لون زر القسم افتراضيًا، وتُخصَّص مستقلةً عنه عند اختيار لون لها
const txColor = (kind) => { const o = TX_OVERRIDE[kind], sec = TX_SECTION[kind]; return COLORS[o] ? (PAINTS[o] || COLORS[o]) : (PAINTS[sec] || COLORS[sec] || COLORS.line); };
function TxCard({ kind, children, className = "", style = {}, ...rest }) {
  return (
    <Card className={`relative overflow-hidden pr-5 ${className}`} style={style} {...rest}>
      <span aria-hidden="true" className="absolute top-0 bottom-0 right-0 w-[5px]" style={{ background: txColor(kind) }} />
      {children}
    </Card>
  );
}

// ================= التاريخ والفترة =================
const MONTHS_DZ = ["جانفي", "فيفري", "مارس", "أفريل", "ماي", "جوان", "جويلية", "أوت", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
const WEEKDAYS = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];

// اختيار تاريخ بثلاث قوائم (يوم / شهر / سنة): تنسيق ثابت DD/MM/YYYY وأرقام إنجليزية على كل الأجهزة (حقل type=date يتبع لغة الهاتف)
function DateSelect({ value, onChange, minYear, maxYear }) {
  const nowY = new Date().getFullYear();
  const lo = minYear || nowY - 6, hi = maxYear || nowY + 1;
  const [part, setPart] = useState(() => { const p = parseISO(value); return p ? { y: p.y, m: p.m, d: p.d } : { y: 0, m: 0, d: 0 }; });
  useEffect(() => { const p = parseISO(value); if (p) setPart({ y: p.y, m: p.m, d: p.d }); }, [value]);
  const change = (k, v) => {
    const next = { ...part, [k]: Number(v) };
    if (next.y && next.m && next.d) next.d = Math.min(next.d, daysInMonth(next.y, next.m));
    setPart(next);
    onChange(next.y && next.m && next.d ? isoOf(next.y, next.m, next.d) : "");
  };
  const maxD = part.y && part.m ? daysInMonth(part.y, part.m) : 31;
  const sel = `${inputCls} !px-2 text-center`;
  return (
    <div dir="ltr" className="grid gap-1.5" style={{ gridTemplateColumns: "1fr 1.7fr 1.25fr" }}>
      <select aria-label="اليوم" value={part.d || ""} onChange={(e) => change("d", e.target.value)} className={sel} style={inputStyle}>
        <option value="">DD</option>{Array.from({ length: maxD }, (_, i) => <option key={i + 1} value={i + 1}>{pad2(i + 1)}</option>)}
      </select>
      <select aria-label="الشهر" value={part.m || ""} onChange={(e) => change("m", e.target.value)} className={sel} style={inputStyle}>
        <option value="">MM</option>{MONTHS_DZ.map((n, i) => <option key={i} value={i + 1}>{pad2(i + 1)} · {n}</option>)}
      </select>
      <select aria-label="السنة" value={part.y || ""} onChange={(e) => change("y", e.target.value)} className={sel} style={inputStyle}>
        <option value="">YYYY</option>{Array.from({ length: hi - lo + 1 }, (_, i) => hi - i).map((y) => <option key={y} value={y}>{y}</option>)}
      </select>
    </div>
  );
}

function filterLabel(f) {
  if (f.mode === "month") return `${MONTHS_DZ[f.month - 1]} ${f.year}`;
  if (f.mode === "year") return `سنة ${f.year}`;
  return `${fmtDate(f.from)} ← ${fmtDate(f.to)}`;
}

// فلتر الفترة الموحّد: شهري / سنوي / فترة مخصصة فقط، مع زر «تطبيق الفلتر» صريح
function PeriodFilter({ value, onChange, onApply, dirty, error, years, extra, appliedLabel }) {
  const modes = [["month", "شهري"], ["year", "سنوي"], ["custom", "فترة مخصصة"]];
  const selCls = `${inputCls} text-center`;
  const yearSel = (v, set) => (
    <select aria-label="السنة" value={v} onChange={(e) => set(Number(e.target.value))} className={selCls} style={inputStyle} dir="ltr">
      {years.map((y) => <option key={y} value={y}>{y}</option>)}
    </select>
  );
  return (
    <div>
      <div className="grid grid-cols-3 gap-1.5 mb-3">
        {modes.map(([id, l]) => (
          <button key={id} type="button" onClick={() => onChange({ mode: id })} className="py-2 rounded-xl text-[13px] font-bold" style={value.mode === id ? { background: COLORS.solid, color: textOn(COLORS.solid, "#FFFFFF") } : { background: COLORS.card, color: COLORS.ink, border: `1px solid ${COLORS.line}` }}>{l}</button>
        ))}
      </div>
      {value.mode === "month" && (
        <div className="grid grid-cols-2 gap-2 mb-3">
          <Field label="الشهر">
            <select aria-label="الشهر" value={value.month} onChange={(e) => onChange({ month: Number(e.target.value) })} className={selCls} style={inputStyle}>
              {MONTHS_DZ.map((n, i) => <option key={i} value={i + 1}>{pad2(i + 1)} · {n}</option>)}
            </select>
          </Field>
          <Field label="السنة">{yearSel(value.year, (y) => onChange({ year: y }))}</Field>
        </div>
      )}
      {value.mode === "year" && <div className="mb-3"><Field label="السنة">{yearSel(value.year, (y) => onChange({ year: y }))}</Field></div>}
      {value.mode === "custom" && (
        <div className="space-y-2 mb-3">
          <Field label="تاريخ البداية"><DateSelect value={value.from} onChange={(v) => onChange({ from: v })} minYear={years[years.length - 1]} maxYear={years[0] + 1} /></Field>
          <Field label="تاريخ النهاية"><DateSelect value={value.to} onChange={(v) => onChange({ to: v })} minYear={years[years.length - 1]} maxYear={years[0] + 1} /></Field>
        </div>
      )}
      {extra}
      {error && <p className="text-[12px] font-bold mb-2" style={{ color: COLORS.expense }}>{error}</p>}
      <Button className="w-full flex items-center justify-center gap-2" disabled={!!error} onClick={onApply}><Glyph n="filter" size={16} />تطبيق الفلتر</Button>
      <div className="text-[12px] mt-2 text-center" style={{ color: COLORS.inkSoft }}>
        الفترة المعروضة: <b style={{ color: COLORS.ink }}>{appliedLabel}</b>{dirty && <span style={{ color: COLORS.gold }}> · تغييرات لم تُطبَّق بعد</span>}
      </div>
    </div>
  );
}

function WeekLine() {
  return <div role="separator" aria-label="فاصل أسبوع" className="my-4 rounded-full" style={{ height: 4, background: paintBg("weekLine", "#6631DB") }} />;
}

// ملاحظة تمييز تاريخ التسجيل عن تاريخ العملية (تظهر فقط حين يختلفان)
function createdNote(raw) {
  if (!raw?.createdAt || !raw?.date) return null;
  const c = dateParts(raw.createdAt), d = dateParts(raw.date);
  if (!c || !d || (c.y === d.y && c.m === d.m && c.d === d.d)) return null;
  return <div className="text-[11px]" style={{ color: COLORS.inkSoft }}>سُجّلت في {fmtDateTime(raw.createdAt)}</div>;
}

const FILTER_MEM = {}; // يحفظ الفلتر المطبّق لكل قسم أثناء الجلسة؛ عند فتح التطبيق يبدأ كل قسم بالشهر الحالي
const SECTION_MARK = { incomes: "markIncomes", expenses: "markExpenses", debts: "markDebts", payments: "markPayments", reports: "markReports" };
const TOP_BTN_H = 68;                                        // ارتفاع أزرار الأقسام العلوية (px): المرجع لحجم بطاقة الفترة
const PERIOD_H = Math.max(Math.round(TOP_BTN_H * 0.4), 28);  // ≈40% منه، مع حد أدنى يُبقي النص مقروءًا

// عنوان البطاقة المختصرة: الشهر الحالي = «الفترة شهريًا»؛ وأي اختيار آخر يظهر بدقة
function periodTitle(f, today) {
  const cur = parseISO(today);
  if (f.mode === "month") return cur && f.month === cur.m && f.year === cur.y ? "الفترة شهريًا" : `الفترة شهريًا · ${MONTHS_DZ[f.month - 1]} ${f.year}`;
  if (f.mode === "year") return cur && f.year === cur.y ? "الفترة سنويًا" : `الفترة سنويًا · ${f.year}`;
  return `فترة مخصصة · ${fmtDate(f.from)} ← ${fmtDate(f.to)}`;
}

// بطاقة الفترة: شريط مختصر بلون علامة القسم، ويتوسع إلى الأسفل بحركة سلسة (ارتفاع + شفافية؛ تُلغى حركتها عند «تقليل الحركة»)
function PeriodCard({ kind, label, open, onToggle, children }) {
  const css = paintBg(SECTION_MARK[kind] || "markReports", COLORS.navButton);
  const fg = textOnAll(paintHexes(css) || [COLORS.navButton], "#FFFFFF", 4.5);
  const bodyId = useId();
  return (
    <div className="mb-3">
      <button type="button" onClick={onToggle} aria-expanded={open} aria-controls={bodyId} className="ui-button w-full flex items-center justify-between gap-2 px-3.5 rounded-xl text-[13px] font-extrabold" style={{ height: PERIOD_H, background: css, color: fg }}>
        <span className="truncate leading-none">{label}</span>
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, transition: "transform .28s cubic-bezier(.2,.8,.2,1)", transform: open ? "rotate(180deg)" : "none" }}><path d="m6 9 6 6 6-6" /></svg>
      </button>
      <div id={bodyId} className="period-body" data-open={open ? "1" : "0"} aria-hidden={!open}>
        <div className="period-body-inner"><Card className="p-3.5 mt-2">{children}</Card></div>
      </div>
    </div>
  );
}

function SectionView({ kind, records, cfg, renderItem }) {
  const today = todayISO();
  const base = () => ({ ...defaultFilter(today), dir: "all", status: "all" });
  const [applied, setApplied] = useState(() => FILTER_MEM[kind] || base());
  const [draft, setDraft] = useState(applied);
  const [open, setOpen] = useState(false); // فتح البطاقة أو طيّها لا يمسّ الفلتر المختار
  const range = rangeOf(applied, today);
  const years = useMemo(() => {
    const nowY = parseISO(today).y; const ys = new Set([nowY, applied.year || nowY, draft.year || nowY]);
    records.forEach((r) => { const p = parseISO(r.date); if (p) ys.add(p.y); });
    const min = Math.min(...ys, nowY - 1);
    const out = []; for (let y = nowY + 1; y >= min; y--) out.push(y);
    return out;
  }, [records, applied.year, draft.year, today]);
  const error = validateFilter(draft);
  const dirty = JSON.stringify(draft) !== JSON.stringify(applied);
  const apply = () => { if (error) return; setApplied(draft); FILTER_MEM[kind] = draft; };
  const list = records.filter((r) => dateInRange(r.date, range) && cfg.match(r, applied));
  const sum = summarize(list, range, { amount: cfg.amount });
  const stats = cfg.stats(list, range, sum);
  const groups = markWeekBreaks(groupByDay(list, range, { amount: cfg.amount, order: (a, b) => tsOf(b) - tsOf(a) }));
  const chips = cfg.chips ? cfg.chips.map((c) => (
    <div key={c.key} className="mb-2">
      <div className="text-[11px] font-bold mb-1" style={{ color: COLORS.inkSoft }}>{c.label}</div>
      <Chips value={draft[c.key]} onChange={(v) => setDraft((d) => ({ ...d, [c.key]: v }))} options={c.options} />
    </div>
  )) : null;
  return (
    <div>
      <PeriodCard kind={kind} label={periodTitle(applied, today)} open={open} onToggle={() => setOpen((o) => !o)}>
        <PeriodFilter value={draft} onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))} onApply={apply} dirty={dirty} error={error} years={years} extra={chips} appliedLabel={filterLabel(applied)} />
        <div className="grid grid-cols-2 gap-2.5 mt-3">
          {stats.map((st, i) => <MiniStat key={i} {...st} />)}
        </div>
        {cfg.showAvg !== false && (
          <div className="text-[11px] mt-2 mb-1 text-center" style={{ color: COLORS.inkSoft }}>
            {range.elapsed === 0 ? "هذه الفترة لم تبدأ بعد" : range.partial ? `المتوسط اليومي محسوب على ${range.elapsed} يومًا من أصل ${range.days} (حتى اليوم)` : `المتوسط اليومي محسوب على كل أيام الفترة (${range.days} يومًا)`}
          </div>
        )}
        {cfg.extra && cfg.extra(list, range)}
      </PeriodCard>
      {applied.mode === "year" ? (
        <div className="text-center text-[12px] py-5" style={{ color: COLORS.inkSoft }}>العرض السنوي يعرض الإجماليات والمتوسط فقط بلا تفاصيل يومية: افتح بطاقة الفترة أعلاه لرؤيتها، أو اختر «شهري» أو «فترة مخصصة» لعرض العمليات يومًا بيوم.</div>
      ) : list.length === 0 ? (
        <div className="text-center py-10 text-[13px]" style={{ color: COLORS.inkSoft }}>{cfg.empty || "لا توجد عمليات في هذه الفترة"}</div>
      ) : (
        <div>
          {groups.map((g) => (
            <div key={g.date}>
              {g.weekBreakBefore && <WeekLine />}
              {!cfg.hideDayHeader && (
                <div className="flex items-center justify-between gap-2 px-1 mt-4 mb-2">
                  <div className="text-[13px] font-black">{WEEKDAYS[dayOfWeek(g.date)]} · {fmtDate(g.date)}</div>
                  <div className="text-[12px] font-bold shrink-0" style={{ color: COLORS.inkSoft }}>{g.items.length} · <Fig>{fmtMoney(g.total)}</Fig></div>
                </div>
              )}
              <div className={`space-y-2 ${cfg.hideDayHeader ? "mt-2" : ""}`}>{g.items.map(renderItem)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// بطاقة سجل عام (دخل / مصروف / دين) بأزرار تعديل وحذف
function RecordCard({ kind, raw, onEdit, onDelete, children }) {
  return (
    <TxCard kind={kind} className="p-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="text-[13px] leading-6 flex-1 min-w-0" style={{ color: COLORS.inkSoft }}>
          {children}
          {createdNote(raw)}
          {raw?._pending && <div className="text-[12px] font-bold" style={{ color: COLORS.gold }}>⏳ بانتظار الرفع</div>}
          <AttachmentsView item={raw} admin />
        </div>
        <div className="flex flex-col items-center gap-1.5 shrink-0">
          <div className="flex gap-1.5">
            <IconBtn glyph="edit" label="تعديل" onClick={() => onEdit(raw)} />
            <IconBtn glyph="trash" label="حذف" tone="danger" onClick={() => onDelete(raw.id)} />
          </div>
          <WorkerTag name={raw?.workerName} />
        </div>
      </div>
    </TxCard>
  );
}

const MONEY = (n) => fmtMoney(n);
const weekdayName = (iso) => (parseISO(iso) ? WEEKDAYS[dayOfWeek(iso)] : "");
function IncomesSection({ incomes, onEdit, onDelete }) {
  const cfg = {
    amount: (x) => x.amount, match: () => true, empty: "لا مداخيل في هذه الفترة",
    hideDayHeader: true, // التاريخ واليوم داخل البطاقة نفسها فلا يتكرران فوقها
    stats: (list, range, sum) => [
      { span: true, label: "إجمالي المداخيل", main: MONEY(sum.total), sub: `${sum.count} سجل`, color: COLORS.incomeText, bg: paintBg("reportCards.2") },
      { label: "متوسط الدخل اليومي", main: MONEY(sum.avgDaily), color: COLORS.income },
      { label: "عدد الأيام المسجَّلة", main: String(new Set(list.map((x) => x.date)).size), sub: `من ${range.days} يومًا`, color: COLORS.ink },
    ],
  };
  return <SectionView kind="incomes" records={incomes} cfg={cfg} renderItem={(i) => (
    <RecordCard key={i.id} kind="income" raw={i} onEdit={onEdit} onDelete={onDelete}>
      <div className="flex items-center gap-2 flex-wrap mb-0.5">
        <span className="text-[14px] font-black" style={{ color: COLORS.ink }}>{weekdayName(i.date)}</span>
        <span className="text-[12px] font-bold px-2 py-0.5 rounded-full" style={{ background: COLORS.goldBg, color: COLORS.gold }}><Fig>{fmtDate(i.date)}</Fig></span>
      </div>
      <Fig className="text-[18px]" style={{ color: COLORS.ink }}>{fmtMoney(i.amount)}</Fig>
    </RecordCard>
  )} />;
}
function ExpensesSection({ expenses, onEdit, onDelete }) {
  const cfg = {
    amount: (x) => x.amount, match: () => true, empty: "لا مصاريف في هذه الفترة",
    stats: (list, range, sum) => [
      { span: true, label: "إجمالي المصاريف", main: MONEY(sum.total), sub: `${sum.count} عملية`, color: COLORS.expense, bg: paintBg("reportCards.1") },
      { label: "متوسط المصروف اليومي", main: MONEY(sum.avgDaily), color: COLORS.expense },
      { label: "عدد العمليات", main: String(sum.count), color: COLORS.ink },
    ],
    extra: (list) => {
      const cats = {}; list.forEach((e) => { const k = e.category || "بدون تصنيف"; (cats[k] = cats[k] || { n: 0, s: 0 }); cats[k].n++; cats[k].s += Number(e.amount) || 0; });
      const rows = Object.entries(cats).sort((x, y) => y[1].s - x[1].s);
      if (!rows.length) return null;
      return <div className="mt-4"><h4 className="text-[13px] font-extrabold mb-2 text-center">أنواع المصاريف</h4><div className="space-y-2">{rows.map(([k, v]) => <Card key={k} className="p-3 flex items-center justify-between"><span className="text-[13px] font-bold">{k} <span style={{ color: COLORS.inkSoft }}>({v.n})</span></span><Fig>{fmtMoney(v.s)}</Fig></Card>)}</div></div>;
    },
  };
  return <SectionView kind="expenses" records={expenses} cfg={cfg} renderItem={(e) => (
    <RecordCard key={e.id} kind="expense" raw={e} onEdit={onEdit} onDelete={onDelete}>
      <div className="font-bold" style={{ color: COLORS.ink }}>{e.description || "مصروف"}</div>
      {e.supplier && <div>المورد: {e.supplier}</div>}
      <Fig className="text-[15px]" style={{ color: COLORS.ink }}>{fmtMoney(e.amount)}</Fig>
    </RecordCard>
  )} />;
}
function DebtsSection({ debts, onEdit, onDelete }) {
  const cfg = {
    amount: (x) => x.amount, showAvg: false, empty: "لا ديون مطابقة للفلتر",
    match: (d, f) => (f.dir === "all" || d.type === f.dir) && (f.status === "all" || normStatus(d) === f.status),
    chips: [
      { key: "dir", label: "اتجاه الدين", options: [["all", "الكل"], ["receivable", "لي"], ["payable", "عليّ"]] },
      { key: "status", label: "حالة السداد", options: [["all", "كل الحالات"], ["unpaid", "غير مسدد"], ["partial", "مسدد جزئيًا"], ["paid", "مسدد بالكامل"]] },
    ],
    stats: (list, range) => {
      const d = debtSummary(list, range);
      return [
        { span: true, label: "إجمالي الديون (الأصلي)", main: MONEY(d.original), sub: `${d.count} دين`, color: COLORS.debtText, bg: paintBg("reportCards.3") },
        { label: "إجمالي المسدَّد", main: MONEY(d.paid), color: COLORS.income },
        { label: "إجمالي المتبقي", main: MONEY(d.remaining), color: COLORS.expense },
        { label: "ديون لي", main: MONEY(d.byDir.receivable.original), sub: `${d.byDir.receivable.count} · متبقي ${fmtMoney(d.byDir.receivable.remaining)}`, color: COLORS.receivable },
        { label: "ديون عليّ", main: MONEY(d.byDir.payable.original), sub: `${d.byDir.payable.count} · متبقي ${fmtMoney(d.byDir.payable.remaining)}`, color: COLORS.payable },
        { span: true, label: "حالات الديون", main: `${d.byStatus.unpaid} غير مسدد · ${d.byStatus.partial} جزئي · ${d.byStatus.paid} كامل`, color: COLORS.ink },
      ];
    },
  };
  return <SectionView kind="debts" records={debts} cfg={cfg} renderItem={(d) => (
    <RecordCard key={d.id} kind="debt" raw={d} onEdit={onEdit} onDelete={onDelete}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-bold" style={{ color: COLORS.ink }}>{d.person || "—"}</span>
        <span className="text-[11px] font-bold px-2 py-0.5 rounded-full" style={{ background: COLORS.goldBg, color: COLORS.gold }}>{d.type === "receivable" ? "لي" : "عليّ"}</span>
        <span className="text-[11px] font-bold px-2 py-0.5 rounded-full" style={{ background: COLORS.card, border: `1px solid ${COLORS.line}`, color: debtStatusColor(d.status) }}>{debtStatusLabel(d.status)}</span>
      </div>
      <div>الأصلي: <Fig>{fmtMoney(d.amount)}</Fig> · المسدَّد: <Fig>{fmtMoney(d.paidAmount)}</Fig></div>
      <div>المتبقي: <Fig style={{ color: COLORS.ink }}>{fmtMoney(d.remainingAmount)}</Fig></div>
    </RecordCard>
  )} />;
}

function Chips({ value, onChange, options }) {
  return <div className="flex flex-wrap gap-1.5 mb-3">{options.map(([id, l]) => (
    <button key={id} onClick={() => onChange(id)} className="px-3 py-1.5 rounded-full text-[12px] font-bold" style={value === id ? { background: COLORS.solid, color: textOn(COLORS.solid, "#FFFFFF") } : { background: COLORS.card, color: COLORS.ink, border: `1px solid ${COLORS.line}` }}>{l}</button>
  ))}</div>;
}

function MiniStat({ label, main, sub, color, bg, span }) {
  const b = bg || paintBg("card");
  return (
    <Card className={`p-3 text-center ${span ? "col-span-2" : ""}`} style={{ background: b, textAlign: "center" }}>
      <div className="text-[11px] font-bold mb-1" style={{ color: COLORS.inkSoft }}>{label}</div>
      <div className="text-[17px]" style={{ color: legibleOnCss(b, color) }}><Fig>{main}</Fig></div>
      {sub != null && <div className="text-[11px] mt-0.5" style={{ color: COLORS.inkSoft }}>{sub}</div>}
    </Card>
  );
}

// ================= ملف المتجر (الضغط على الشعار) =================
function StoreOverviewModal({ store, adminName, workers, incomes, expenses, debts, payments, onClose, onReports, onWorkers, onSettings }) {
  const t = todayISO();
  const td = (l) => l.filter((x) => x.date === t);
  const sum = (l) => l.reduce((s, x) => s + (Number(x.amount) || 0), 0);
  const inc = td(incomes), exp = td(expenses), dbt = td(debts), pay = td(payments);
  const active = workers.filter((w) => w.active !== false).length;
  const windowSet = store?.incomeStart && store?.incomeEnd;
  const status = windowSet ? (inIncomeWindow(store.incomeStart, store.incomeEnd) ? "الدخل مفتوح" : "الدخل مغلق") : "بلا نافذة دخل محددة";
  const row = (k, v) => <div className="flex items-center justify-between gap-3 py-2 text-[13px]" style={{ borderBottom: `1px solid ${COLORS.line}` }}><span style={{ color: COLORS.inkSoft }}>{k}</span><span className="font-bold text-left">{v}</span></div>;
  return <Modal title="ملف المتجر" onClose={onClose}>
    <div className="flex items-center gap-3 mb-2">
      <StoreMark size={56} radius={16} bg={COLORS.solid} color={COLORS.goldBg} fontSize={26} />
      <div className="min-w-0"><div className="text-[18px] font-black truncate">{store?.name || "—"}</div>{store?.type && <div className="text-[12px]" style={{ color: COLORS.inkSoft }}>{store.type}</div>}</div>
    </div>
    {row("المسؤول", adminName || "—")}
    {row("العمال", `${active} نشط من ${workers.length}`)}
    {row("الحالة", status)}
    {row("دخل اليوم", inc.length ? "✓ مسجّل" : "○ لم يُسجَّل بعد")}
    {store?.address ? row("العنوان", store.address) : null}
    {store?.phone ? row("الهاتف", <span dir="ltr">{store.phone}</span>) : null}
    <h4 className="text-[12px] font-black mt-4 mb-2 text-center" style={{ color: COLORS.gold }}>اليوم — {td(incomes).length + exp.length + dbt.length + pay.length} عملية</h4>
    <div className="grid grid-cols-2 gap-2">
      <MiniStat label="الدخل" main={fmtMoney(sum(inc))} color={COLORS.incomeText} />
      <MiniStat label="المصاريف" main={fmtMoney(sum(exp))} sub={`${exp.length} عملية`} color={COLORS.expense} />
      <MiniStat label="الديون" main={fmtMoney(sum(dbt))} sub={`${dbt.length} عملية`} color={COLORS.debtText} />
      <MiniStat label="السدادات" main={fmtMoney(sum(pay))} sub={`${pay.length} عملية`} color={COLORS.paymentBtn} />
    </div>
    <div className="grid grid-cols-3 gap-2 mt-4">
      <Button variant="ghost" className="!text-[12px] !px-2" onClick={onReports}><span className="inline-flex items-center gap-1.5"><NavIcon name="reports" />التقارير</span></Button>
      <Button variant="ghost" className="!text-[12px] !px-2" onClick={onWorkers}><span className="inline-flex items-center gap-1.5"><Ico n="workers" size={22} />العمال</span></Button>
      <Button variant="ghost" className="!text-[12px] !px-2" onClick={onSettings}><span className="inline-flex items-center gap-1.5"><IcoTile n="settings" size={22} />الإعدادات</span></Button>
    </div>
  </Modal>;
}

// ================= البحث الموحّد بفلاتر قابلة للتركيب =================
function SearchTab({ incomes, expenses, debts, payments = [] }) {
  const [q, setQ] = useState("");
  const [type, setType] = useState("all");
  const [st, setSt] = useState("all");
  const [period, setPeriod] = useState("all");
  const [range, setRange] = useState({ from: "", to: "" });
  const query = toLatinDigits(q).trim().toLowerCase();
  const active = !!(query || type !== "all" || st !== "all" || period !== "all");

  const results = useMemo(() => {
    if (!active) return [];
    const [a, b] = periodBounds(period, "", range);
    const inP = (x) => period === "all" || (!!x.date && x.date >= a && x.date <= b);
    const has = (...vals) => vals.some((v) => String(v ?? "").toLowerCase().includes(query));
    const byId = new Map(debts.map((d) => [d.id, d]));
    const who = (x) => (x.workerName ? ` · ${x.workerName}` : "");
    const out = [];
    const wantDebtsOnly = st !== "all";
    if (!wantDebtsOnly && (type === "all" || type === "income"))
      incomes.filter((i) => inP(i) && (!query || has(i.amount, i.date, fmtDate(i.date), i.workerName, "دخل"))).forEach((i) => out.push({ date: i.date, kind: "دخل", label: `${fmtDate(i.date)}${who(i)}`, amount: i.amount, color: COLORS.income }));
    if (!wantDebtsOnly && (type === "all" || type === "expense"))
      expenses.filter((e) => inP(e) && (!query || has(e.description, e.supplier, e.category, e.amount, e.workerName))).forEach((e) => out.push({ date: e.date, kind: "مصروف", label: `${e.description || ""}${e.supplier ? " · " + e.supplier : ""}${who(e)}`, amount: e.amount, color: COLORS.expense }));
    if (type === "all" || type === "receivable" || type === "payable")
      debts.filter((d) => inP(d) && (type === "all" || d.type === type) && (st === "all" || d.status === st) && (!query || has(d.person, d.description, d.amount, d.workerName)))
        .forEach((d) => out.push({ date: d.date, kind: `${d.type === "receivable" ? "دين لي" : "دين عليّ"} · ${d.status === "paid" ? "مسدد" : d.status === "partial" ? "جزئي" : "غير مسدد"}`, label: `${d.person || ""}${who(d)}`, amount: d.amount, color: d.type === "receivable" ? COLORS.receivable : COLORS.payable }));
    if (!wantDebtsOnly && (type === "all" || type === "payment"))
      payments.filter((p) => inP(p) && (!query || has(byId.get(p.debtId)?.person, p.amount, p.workerName))).forEach((p) => out.push({ date: p.date, kind: `سداد · ${paymentStatusLabel(p.status)}`, label: `${byId.get(p.debtId)?.person || "—"}${who(p)}`, amount: p.amount, color: COLORS.gold }));
    return out.sort((x, y) => tsOf(y) - tsOf(x));
  }, [query, type, st, period, range, active, incomes, expenses, debts, payments]);

  return (
    <div>
      <h2 className="text-[15px] font-extrabold mb-3">بحث شامل</h2>
      <TextInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="اسم، وصف، مبلغ، عامل..." />
      <div className="h-3" />
      <Chips value={type} onChange={setType} options={[["all", "الكل"], ["income", "دخل"], ["expense", "مصروف"], ["receivable", "دين لي"], ["payable", "دين عليّ"], ["payment", "سداد"]]} />
      {(type === "all" || type === "receivable" || type === "payable") && <Chips value={st} onChange={setSt} options={[["all", "كل الحالات"], ["unpaid", "غير مسدد"], ["partial", "مسدد جزئيًا"], ["paid", "مسدد كليًا"]]} />}
      <PeriodPicker options={SEARCH_PERIODS} value={period} onChange={setPeriod} range={range} onRange={setRange} />
      {!active ? (
        <div className="text-center py-10 text-[13px]" style={{ color: COLORS.inkSoft }}>اكتب للبحث أو اختر فلترًا</div>
      ) : results.length === 0 ? (
        <div className="text-center py-10 text-[13px]" style={{ color: COLORS.inkSoft }}>لا توجد نتائج</div>
      ) : (
        <div className="space-y-2">
          <div className="text-[12px]" style={{ color: COLORS.inkSoft }}>{results.length} نتيجة</div>
          {results.slice(0, 200).map((r, i) => (
            <Card key={i} className="p-3.5 flex items-center justify-between">
              <div>
                <div className="text-[12px] font-bold mb-0.5" style={{ color: r.color }}>{r.kind}</div>
                <div className="text-[14px]">{r.label}</div>
              </div>
              <Fig>{fmtMoney(r.amount)}</Fig>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function ReportsTab({ incomes, expenses, debts, payments, aggCache, useLive }) {
  const today = todayISO();
  const [open, setOpen] = useState(false);
  const [applied, setApplied] = useState(() => FILTER_MEM.reports || defaultFilter(today));
  const [draft, setDraft] = useState(applied);
  const range = rangeOf(applied, today);
  const years = useMemo(() => {
    const nowY = parseISO(today).y; const ys = new Set([nowY, applied.year || nowY, draft.year || nowY]);
    [incomes, expenses, debts, payments].forEach((l) => l.forEach((r) => { const p = parseISO(r.date); if (p) ys.add(p.y); }));
    const min = Math.min(...ys, nowY - 1); const out = []; for (let y = nowY + 1; y >= min; y--) out.push(y); return out;
  }, [incomes, expenses, debts, payments, applied.year, draft.year, today]);
  const error = validateFilter(draft);
  const dirty = JSON.stringify(draft) !== JSON.stringify(applied);
  const inR = (d) => dateInRange(d, range);
  const inPeriod = (r) => inR(r.date);
  const periodData = { incomes: incomes.filter(inPeriod), expenses: expenses.filter(inPeriod), debts: debts.filter(inPeriod), payments: payments.filter(inPeriod) };
  const agg = useLive ? buildAgg(incomes, expenses, debts, payments) : aggCache || {};
  const { incTotal, expTotal, debtTotal, paymentTotal, receivable, payable, paid, partial, unpaid, net } = reportFromAgg(agg, inR);
  const avgInc = range.elapsed > 0 ? incTotal / range.elapsed : 0;
  const label = filterLabel(applied);
  function handlePrint() {
    const w = window.open("", "_blank"); if (!w) return;
    w.document.write(`<html dir="rtl"><head><meta charset="utf-8"><title>تقرير دفتر</title></head><body style="font-family:Arial;padding:30px"><h1>تقرير دفتر</h1><p>${label} — ${fmtDate(range.from)} إلى ${fmtDate(range.to)}</p><p>إجمالي الدخل: ${fmtMoney(incTotal)}</p><p>متوسط الدخل اليومي: ${fmtMoney(avgInc)}</p><p>إجمالي سداد الديون: ${fmtMoney(paymentTotal)}</p><p>إجمالي المصاريف: ${fmtMoney(expTotal)}</p><p>إجمالي الديون: ${fmtMoney(debtTotal)}</p><h2>صافي الربح: ${fmtMoney(net)}</h2></body></html>`);
    w.document.close(); w.print();
  }
  const rc = [0, 1, 2, 3].map((i) => paintBg(`reportCards.${i}`, DEFAULT_THEME.reportCards[i]));
  const fname = `daftar-${range.from}_${range.to}`;
  return <div>
    <PeriodCard kind="reports" label={periodTitle(applied, today)} open={open} onToggle={() => setOpen((o) => !o)}>
      <PeriodFilter value={draft} onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))} onApply={() => { if (!error) { setApplied(draft); FILTER_MEM.reports = draft; } }} dirty={dirty} error={error} years={years} appliedLabel={label} />
    </PeriodCard>
    <div className="grid grid-cols-2 gap-3">
      <StatCard label="صافي الربح" value={net} color={COLORS.netText} bg={rc[0]} />
      <StatCard label="إجمالي المصاريف" value={expTotal} color={COLORS.expense} bg={rc[1]} />
      <StatCard label="إجمالي الدخل" value={incTotal} color={COLORS.incomeText} bg={rc[2]} />
      <StatCard label="إجمالي الديون" value={debtTotal} color={COLORS.debtText} bg={rc[3]} />
    </div>
    <div className="grid grid-cols-2 gap-3 mt-3">
      <MiniStat span label="متوسط الدخل اليومي" main={fmtMoney(avgInc)} sub={range.elapsed === 0 ? "هذه الفترة لم تبدأ بعد" : range.partial ? `على ${range.elapsed} يومًا من ${range.days} (حتى اليوم)` : `على ${range.days} يومًا`} color={COLORS.income} />
    </div>
    <Card className="p-0 mt-4 overflow-hidden text-center" style={{textAlign:"center"}}><div className="px-4 py-[5.7px] text-[15.3px] font-black text-center">تفاصيل الديون</div><div className="grid grid-cols-2 text-[13px]" style={{borderTop:`1px solid ${COLORS.line}`}}>{[["ديون لي",receivable],["ديون عليّ",payable],["مسددة بالكامل",paid],["مسددة جزئيًا",partial],["غير مسددة",unpaid],["سداد الديون",paymentTotal]].map(([k,v],i)=><div key={k} className="px-2 py-[8.7px] flex flex-wrap items-center justify-center gap-x-2 text-center" style={{background:"transparent",textAlign:"center",borderBottom:`1px solid ${COLORS.line}`,borderLeft:i%2===0?`1px solid ${COLORS.line}`:"none"}}><span>{k}</span><Fig>{typeof v === "number" && (k.includes("ديون") || k.includes("سداد")) ? fmtMoney(v) : v}</Fig></div>)}</div></Card>
    <div className="grid grid-cols-3 gap-2 mt-4"><Button className="!py-2.5 !text-[12px]" onClick={handlePrint}>طباعة / PDF</Button><Button variant="ghost" className="!py-2.5 !text-[12px]" onClick={()=>exportRows("csv",periodData,`${fname}.csv`)}>CSV</Button><Button variant="ghost" className="!py-2.5 !text-[12px]" onClick={()=>exportRows("xls",periodData,`${fname}.xls`)}>Excel</Button></div>
  </div>;
}


function SupplierPhotoField({ value, onChange }) {
  const [busy,setBusy]=useState(false); const [err,setErr]=useState(""); const galleryId=useId(); const cameraId=useId();
  const onPick=async e=>{const f=e.target.files?.[0];e.target.value="";endPicking();if(!f)return;setBusy(true);setErr("");try{const c=await compressImage(f);onChange(c.dataUrl)}catch(x){setErr(x?.message||"تعذّر تجهيز الصورة")}finally{setBusy(false)}};
  const lbl="cursor-pointer rounded-xl px-3 py-2.5 text-[12px] font-bold text-center";
  return <Field label="صورة المورد (اختيارية)"><div className="flex items-center gap-3"><div className="w-20 h-20 rounded-full flex items-center justify-center overflow-hidden shrink-0" style={{background:COLORS.avatarBg,color:COLORS.inkSoft}}>{value?<img src={value} alt="المورد" className="w-full h-full object-cover"/>:<PersonIcon/>}</div><div className="flex-1 grid grid-cols-2 gap-2"><label htmlFor={galleryId} className={lbl} style={{background:COLORS.goldBg,color:COLORS.ink}}>{busy?"جارٍ التجهيز...":"📎 من المعرض"}</label><label htmlFor={cameraId} className={lbl} style={{background:COLORS.goldBg,color:COLORS.ink}}>📷 كاميرا</label></div><input id={galleryId} className="sr-only" type="file" accept="image/*" onClick={beginPicking} onCancel={endPicking} onChange={onPick}/><input id={cameraId} className="sr-only" type="file" accept="image/*" capture="environment" onClick={beginPicking} onCancel={endPicking} onChange={onPick}/></div>{err&&<p className="text-[12px] mt-1" style={{color:COLORS.expense}}>{err}</p>}</Field>;
}
// رصيد المورد: المطلوب = فواتير المورد + ديون "عليّ" المتبقية باسمه − ما دُفع له عبر معاملاته.
// المصروف المسجَّل باسمه مالٌ دُفع فعلًا، فيُحسب ضمن "المدفوع" ولا يُعدّ دَينًا.
function supplierBalance(supplier, expenses, debts, tx) {
  const num = (v) => Number(v) || 0;
  const name = (supplier.name || "").trim();
  const purchases = tx.filter((t) => t.type === "purchase").reduce((s, t) => s + num(t.amount), 0);
  const txPaid = tx.filter((t) => t.type === "payment").reduce((s, t) => s + num(t.amount), 0);
  const cashExpenses = expenses.filter((e) => (e.supplier || "").trim() === name).reduce((s, e) => s + num(e.amount), 0);
  const owedDebts = debts.filter((d) => d.type === "payable" && (d.person || "").trim() === name && d.status !== "paid").reduce((s, d) => s + num(d.remainingAmount), 0);
  return { due: Math.max(purchases + owedDebts - txPaid, 0), paid: txPaid + cashExpenses };
}

function SupplierCard({ supplier, expenses, debts, supplierTransactions=[], onOpen, index=0 }) {
  const tx = supplierTransactions.filter(t => t.supplierId === supplier.id);
  const { due, paid: supplierPaid } = supplierBalance(supplier, expenses, debts, tx);
  const bg = paintBg(index % 2 === 0 ? "supplierPaletteA.0" : "supplierPaletteB.0") || COLORS.supplierCard;

  return (
    <Card className="cursor-pointer overflow-hidden" onClick={onOpen} style={{ background: bg, padding: 0 }}>
      <div className="flex items-center gap-3 p-3.5">
        <div className="w-[58px] h-[58px] rounded-2xl overflow-hidden shrink-0 flex items-center justify-center" style={{ background: COLORS.glass, color: COLORS.inkSoft }}>
          {supplier.photo ? <img src={supplier.photo} alt={supplier.name} className="w-full h-full object-cover"/> : <PersonIcon/>}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[16px] font-black truncate" style={{ color: COLORS.ink }}>{supplier.name}</div>
          <div className="text-[12px] mt-0.5 truncate" style={{ color: COLORS.inkSoft }}>{supplier.goods || "السلع غير محددة"}</div>
          <div className="text-[11px] mt-0.5 truncate" style={{ color: COLORS.inkSoft }}>{supplier.location || "المكان غير محدد"}</div>
        </div>
        <div className="flex flex-col gap-1.5 shrink-0">
          {supplier.phone && (
            <a href={`tel:${supplier.phone}`} onClick={e=>e.stopPropagation()} className="w-9 h-9 rounded-full flex items-center justify-center" style={{ background:COLORS.infoBg, color: COLORS.receivable }} title="اتصال"><Ico n="phone" size={22} /></a>
          )}
          {supplier.phone && (
            <a href={`https://wa.me/${whatsappNumber(supplier.phone)}`} target="_blank" rel="noreferrer" onClick={e=>e.stopPropagation()} className="w-9 h-9 rounded-full flex items-center justify-center" style={{ background:COLORS.okBg }} title="واتساب"><WhatsAppIcon/></a>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 px-3.5 py-2.5" style={{ borderTop: `1px solid ${COLORS.line}`, background: COLORS.glass2 }}>
        <div className="flex-1">
          <div className="text-[10px]" style={{ color: COLORS.inkSoft }}>المطلوب منا</div>
          <div className="text-[13px] font-black" style={{ color: COLORS.expense }}>{fmtMoney(due)}</div>
        </div>
        <div className="w-px h-7" style={{ background: COLORS.line }} />
        <div className="flex-1 text-left">
          <div className="text-[10px]" style={{ color: COLORS.inkSoft }}>المدفوع</div>
          <div className="text-[13px] font-black" style={{ color: COLORS.income }}>{fmtMoney(supplierPaid)}</div>
        </div>
      </div>
    </Card>
  );
}

function SupplierFields({ form, setForm }) {
  const set=k=>e=>setForm(f=>({...f,[k]:e.target.value}));
  return <div className="space-y-1"><SupplierPhotoField value={form.photo} onChange={photo=>setForm(f=>({...f,photo}))}/><Field label="اسم المورد"><TextInput value={form.name||""} onChange={set("name")} /></Field><Field label="رقم الهاتف الرئيسي"><TextInput value={form.phone||""} onChange={set("phone")} dir="ltr" type="tel" inputMode="tel" /></Field><Field label="رقم ثانٍ 1"><TextInput value={form.phone2||""} onChange={set("phone2")} dir="ltr" type="tel" inputMode="tel" /></Field><Field label="رقم ثانٍ 2"><TextInput value={form.phone3||""} onChange={set("phone3")} dir="ltr" type="tel" inputMode="tel" /></Field><Field label="المكان"><TextInput value={form.location||""} onChange={set("location")} /></Field><Field label="السلع"><TextInput value={form.goods||""} onChange={set("goods")} /></Field><Field label="ملاحظات"><TextArea value={form.notes||""} onChange={set("notes")} /></Field></div>;
}

function SupplierTransactionForm({ supplier, initialType="purchase", onClose, onSave }) {
  const [type,setType]=useState(initialType); const [amount,setAmount]=useState(""); const [description,setDescription]=useState(""); const [date,setDate]=useState(todayISO()); const [files,setFiles]=useState([]);
  return <Modal title={type==="purchase"?"إضافة فاتورة / سلعة":"تسجيل دفع للمورد"} onClose={onClose} zClass="z-[60]">
    <Field label="نوع العملية"><select value={type} onChange={e=>setType(e.target.value)} className={inputCls} style={inputStyle}><option value="purchase">فاتورة / شراء جديد</option><option value="payment">دفع مبلغ للمورد</option></select></Field>
    <Field label="المبلغ"><TextInput type="number" value={amount} onChange={e=>setAmount(e.target.value)} dir="ltr" inputMode="decimal" /></Field>
    <Field label="الوصف / السلعة"><TextInput value={description} onChange={e=>setDescription(e.target.value)} placeholder={type==="purchase"?"مثال: 10 كراتين زيت":"مثال: دفعة نقدية"} /></Field>
    <Field label="التاريخ"><DateSelect value={date} onChange={setDate} /></Field>
    {type==="purchase"&&<FileAttach files={files} onChange={setFiles} label="صور الفاتورة (اختياري)" />}
    <Button className="w-full" disabled={!amount || Number(amount)<=0} onClick={()=>onSave({supplierId:supplier.id,type,amount:Number(amount),description,date,attachments:files,createdAt:nowISO()})}>حفظ العملية</Button>
  </Modal>;
}

function SuppliersTab({ suppliers, expenses, debts, supplierTransactions = [], onEdit, onDelete, onArchive, onRestore, onAdd, showToast }) {
  const [openId, setOpenId] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [showTx, setShowTx] = useState(null);
  const [confirmDel, setConfirmDel] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [busy, setBusy] = useState(false);
  const live = suppliers.filter((s) => !s.archived);
  const archived = suppliers.filter((s) => s.archived);
  // نشتق المورد المفتوح من القائمة الحية كي تظهر تعديلاته فور حفظها
  const open = openId ? suppliers.find((s) => s.id === openId) || null : null;
  const relatedExpenses = open ? expenses.filter((e) => (e.supplier || "").trim() === (open.name || "").trim()) : [];
  const relatedDebts = open ? debts.filter((d) => (d.person || "").trim() === (open.name || "").trim()) : [];
  const tx = open ? supplierTransactions.filter((t) => t.supplierId === open.id).sort((a, b) => new Date(b.date || b.createdAt) - new Date(a.date || a.createdAt)) : [];
  const { due, paid: supplierPaid } = open ? supplierBalance(open, expenses, debts, tx) : { due: 0, paid: 0 };
  const allPhones = open ? [open.phone, open.phone2, open.phone3].filter(Boolean) : [];
  const linked = tx.length + relatedExpenses.length + relatedDebts.length; // سجلات مالية مرتبطة بالمورد
  const willArchive = !!open && !open.archived && linked > 0;            // الحذف النهائي غير آمن مع وجود سجلات: نؤرشف بدلًا منه
  const closeDetails = () => { setOpenId(null); setConfirmDel(false); };
  const confirmRemove = async () => {
    if (!open || busy) return;
    setBusy(true);
    try { const ok = willArchive ? await onArchive(open) : await onDelete(open.id); if (ok !== false) closeDetails(); }
    finally { setBusy(false); }
  };
  const card = (s, si) => <div key={s.id} className={s.archived ? "opacity-75" : ""}><SupplierCard index={si} supplier={s} expenses={expenses} debts={debts} supplierTransactions={supplierTransactions} onOpen={() => setOpenId(s.id)} /></div>;
  return <div>
    <div className="flex items-center justify-between mb-3"><h2 className="text-[18px] font-black">الموردين</h2><Button className="!py-2 !px-3 !text-[13px]" onClick={() => setShowAdd(true)}>+ مورد</Button></div>
    {live.length === 0 ? <div className="text-center py-10 text-[13px]" style={{ color: COLORS.inkSoft }}>لا يوجد موردون بعد</div> : <div className="space-y-3">{live.map(card)}</div>}
    {archived.length > 0 && <div className="mt-5">
      <button type="button" onClick={() => setShowArchived((v) => !v)} aria-expanded={showArchived} className="w-full flex items-center justify-between rounded-xl px-4 py-2.5 text-[13px] font-bold" style={{ background: COLORS.card, border: `1px solid ${COLORS.line}`, color: COLORS.ink }}><span>الموردون المؤرشفون ({archived.length})</span><span>{showArchived ? "▴" : "▾"}</span></button>
      {showArchived && <div className="space-y-3 mt-3">{archived.map(card)}</div>}
    </div>}
    {showAdd && <SupplierForm onClose={() => setShowAdd(false)} onSave={async (d) => { await onAdd(d); setShowAdd(false); }} />}
    {showTx && <SupplierTransactionForm supplier={showTx.supplier} initialType={showTx.type} onClose={() => setShowTx(null)} onSave={async (d) => {
      try { await addItem("supplierTransaction", d); setShowTx(null); }
      catch (e) { console.error(e); showToast?.("تعذّر حفظ العملية. تحقق من الاتصال ثم حاول مرة أخرى."); }
    }} />}
    {open && <Modal title={`المورد: ${open.name}`} wide onClose={closeDetails}>
      {open.archived && <div className="rounded-xl px-3 py-2 mb-3 text-[12px] font-bold" style={{ background: COLORS.goldBg, color: COLORS.gold }}>هذا المورد مؤرشف: مخفي من القائمة الرئيسية وسجلاته المالية محفوظة كما هي.</div>}
      <div className="flex items-start gap-3 mb-4">
        <div className="w-20 h-20 rounded-full overflow-hidden flex items-center justify-center shrink-0" style={{ background: COLORS.avatarBg, color: COLORS.inkSoft }}>{open.photo ? <img src={open.photo} alt={open.name} className="w-full h-full object-cover" /> : <PersonIcon />}</div>
        <div className="min-w-0 flex-1">
          <div className="text-[20px] font-black">{open.name}</div>
          <div className="text-[12px] mt-1">{open.location || "المكان غير محدد"}</div>
          <div className="flex flex-wrap gap-1.5 mt-2">{allPhones.map((ph, i) => <a key={i} href={`tel:${ph}`} className="px-2.5 py-1.5 rounded-lg text-[11px] font-bold" style={{ background: COLORS.infoBg, color: COLORS.receivable }}><Ico n="phone" size={16} className="inline-block align-text-bottom" /> {ph}</a>)}</div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 mb-4">
        <div className="rounded-xl p-3" style={{ background: COLORS.dangerBg }}><div className="text-[11px]" style={{ color: COLORS.inkSoft }}>إجمالي المطلوب منا</div><div className="font-black mt-1">{fmtMoney(due)}</div></div>
        <div className="rounded-xl p-3" style={{ background: COLORS.goldBg }}><div className="text-[11px]" style={{ color: COLORS.inkSoft }}>إجمالي ما تم سداده</div><div className="font-black mt-1">{fmtMoney(supplierPaid)}</div></div>
      </div>
      <div className="flex gap-2 mb-4">
        <Button className="flex-1 !py-2.5 !text-[12px]" onClick={(e) => { e.stopPropagation(); setShowTx({ supplier: open, type: "purchase" }); }}><Glyph n="plus" size={14} /> فاتورة / سلعة</Button>
        <Button variant="payment" className="flex-1 !py-2.5 !text-[12px]" onClick={(e) => { e.stopPropagation(); setShowTx({ supplier: open, type: "payment" }); }}><Glyph n="minus" size={14} /> دفع للمورد</Button>
      </div>
      <div className="flex gap-2 mb-4">
        {open.phone && <a href={`tel:${open.phone}`} className="flex-1 flex items-center justify-center gap-1.5 text-center rounded-xl py-2.5 text-[12px] font-bold" style={{ background: COLORS.infoBg, color: COLORS.receivable }}><Ico n="call" size={18} />اتصال مباشر</a>}
        {open.phone && <a href={`https://wa.me/${whatsappNumber(open.phone)}`} target="_blank" rel="noreferrer" className="flex-1 flex items-center justify-center gap-1.5 text-center rounded-xl py-2.5 text-[12px] font-bold" style={{ background: COLORS.okBg, color: COLORS.okText }}><Ico n="whatsapp" size={18} />واتساب</a>}
      </div>
      <h3 className="font-extrabold mb-2">سجل الفواتير والمعاملات</h3>
      <div className="space-y-2">
        {tx.map((t) => <Card key={t.id} className="p-3"><div className="flex justify-between gap-2"><span className="font-bold">{t.type === "purchase" ? "شراء / فاتورة" : "سداد للمورد"}</span><Fig>{fmtMoney(t.amount)}</Fig></div><div className="text-[11px] mt-1" style={{ color: COLORS.inkSoft }}>{fmtDate(t.date)} · {t.description || "—"}</div>{t.type === "purchase" && <AttachmentsView item={t} admin />}</Card>)}
        {relatedExpenses.map((e) => <Card key={e.id} className="p-3"><div className="flex justify-between"><span>مصروف قديم — {e.description}</span><Fig>{fmtMoney(e.amount)}</Fig></div><div className="text-[11px]" style={{ color: COLORS.inkSoft }}>{fmtDate(e.date)}</div><AttachmentsView item={e} admin /></Card>)}
        {relatedDebts.map((d) => <Card key={d.id} className="p-3"><div className="flex justify-between"><span>دين مرتبط — {d.type === "receivable" ? "لي" : "عليّ"}</span><Fig>{fmtMoney(d.amount)}</Fig></div><div className="text-[11px]" style={{ color: COLORS.inkSoft }}>{fmtDate(d.date)} · المتبقي {fmtMoney(d.remainingAmount)}</div><AttachmentsView item={d} admin /></Card>)}
        {tx.length === 0 && relatedExpenses.length === 0 && relatedDebts.length === 0 && <p className="text-[13px]" style={{ color: COLORS.inkSoft }}>لا توجد معاملات بعد.</p>}
      </div>
      <div className="mt-4 text-[12px]" style={{ color: COLORS.inkSoft }}>السلع: {open.goods || "—"} · ملاحظات: {open.notes || "—"}</div>

      <div className="mt-5 pt-4" style={{ borderTop: `1px solid ${COLORS.line}` }}>
        <h3 className="font-extrabold mb-2 text-[14px]">إدارة المورد</h3>
        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" className="flex-1 min-w-[140px] flex items-center justify-center gap-1.5 !py-2.5 !text-[13px]" onClick={() => onEdit(open)}><Glyph n="edit" size={15} />تعديل بيانات المورد</Button>
          {open.archived && <Button variant="ghost" className="flex-1 min-w-[140px] !py-2.5 !text-[13px]" disabled={busy} onClick={async () => { const ok = await onRestore(open); if (ok !== false) closeDetails(); }}>استعادة المورد</Button>}
          {(!open.archived || linked === 0) && <Button variant="danger" className="flex-1 min-w-[140px] flex items-center justify-center gap-1.5 !py-2.5 !text-[13px]" onClick={() => setConfirmDel(true)}><Glyph n="trash" size={15} />{open.archived ? "حذف المورد نهائيًا" : "حذف المورد"}</Button>}
        </div>
        {open.archived && linked > 0 && <p className="text-[11px] mt-2" style={{ color: COLORS.inkSoft }}>لا يمكن الحذف النهائي لوجود سجلات مالية مرتبطة بهذا المورد.</p>}
      </div>
    </Modal>}
    {open && confirmDel && <Modal title="تأكيد حذف المورد" onClose={() => setConfirmDel(false)} zClass="z-[70]">
      <p className="text-[14px] leading-7 mb-5">{willArchive
        ? `لهذا المورد ${linked} سجل مالي مرتبط (فواتير ودفعات ومصاريف وديون). لن تُحذف أي عملية مالية: سيُؤرشف المورد ويختفي من القائمة، ويمكنك استعادته في أي وقت من «الموردون المؤرشفون».`
        : `سيُحذف المورد «${open.name}» نهائيًا ولا يمكن التراجع عن هذا الإجراء. لا توجد عمليات مالية مرتبطة به.`}</p>
      <div className="flex gap-2"><Button variant="ghost" className="flex-1" onClick={() => setConfirmDel(false)}>إلغاء</Button><Button variant={willArchive ? "primary" : "danger"} className="flex-1" disabled={busy} onClick={confirmRemove}>{willArchive ? "أرشفة المورد" : "حذف نهائي"}</Button></div>
    </Modal>}
  </div>;
}

function SupplierForm({ onClose, onSave }) { const [form,setForm]=useState({name:"",phone:"",phone2:"",phone3:"",location:"",goods:"",notes:"",photo:""}); return <Modal title="إضافة مورد" onClose={onClose}><SupplierFields form={form} setForm={setForm}/><Button className="w-full" disabled={!form.name} onClick={()=>onSave(form)}>حفظ المورد</Button></Modal>; }

function EditModal({ kind, data, onClose, onSave }) {
  const [form, setForm] = useState({ ...data });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const setNum = (k) => (e) => setForm((f) => ({ ...f, [k]: Number(e.target.value) }));

  const titles = { income: "تعديل الدخل", expense: "تعديل المصروف", debt: "تعديل الدين", payment: "تعديل الدفعة", supplier: "تعديل المورد" };

  return (
    <Modal title={titles[kind]} onClose={onClose} wide>
      {kind !== "supplier" && <Field label="التاريخ">
        <DateSelect value={form.date} onChange={(v) => setForm((f) => ({ ...f, date: v }))} />
      </Field>}

      {kind === "income" && (
        <Field label="المبلغ"><TextInput type="number" value={form.amount} onChange={setNum("amount")} dir="ltr" /></Field>
      )}

      {kind === "expense" && (
        <>
          <Field label="المبلغ"><TextInput type="number" value={form.amount} onChange={setNum("amount")} dir="ltr" /></Field>
          <Field label="الوصف"><TextInput value={form.description} onChange={set("description")} /></Field>
          <Field label="المورد"><TextInput value={form.supplier || ""} onChange={set("supplier")} /></Field>
        </>
      )}

      {kind === "debt" && (
        <>
          <Field label="النوع">
            <select value={form.type} onChange={set("type")} className={inputCls} style={inputStyle}>
              <option value="receivable">لي</option>
              <option value="payable">عليّ</option>
            </select>
          </Field>
          <Field label="الشخص"><TextInput value={form.person} onChange={set("person")} /></Field>
          <Field label="المبلغ الإجمالي"><TextInput type="number" value={form.amount} onChange={(e) => {
            const amt = Number(e.target.value) || 0;
            setForm((f) => { const paid = Number(f.paidAmount) || 0; const rem = Math.max(amt - paid, 0); return { ...f, amount: amt, remainingAmount: rem, status: amt > 0 && rem === 0 ? "paid" : paid > 0 ? "partial" : "unpaid" }; });
          }} dir="ltr" /></Field>
          <Field label="المبلغ المسدد (يتغير بتأكيد السداد فقط)"><div className="rounded-xl px-3 py-2.5 text-[15px] font-bold" style={{ background: COLORS.card, border: `1px solid ${COLORS.line}`, color: COLORS.inkSoft }}><Fig>{fmtMoney(form.paidAmount)}</Fig></div></Field>
          {Number(form.amount) < Number(form.paidAmount) && <p className="text-[12px] mb-2" style={{ color: COLORS.expense }}>المبلغ الإجمالي لا يقل عن المسدد ({fmtMoney(form.paidAmount)}).</p>}
          <Field label="الوصف"><TextArea value={form.description || ""} onChange={set("description")} /></Field>
          <Field label="الحالة (تُحسب تلقائيًا)"><div className="rounded-xl px-3 py-2.5 text-[14px] font-bold" style={{ background: COLORS.card, border: `1px solid ${COLORS.line}`, color: COLORS.inkSoft }}>{form.status === "paid" ? "مسدد بالكامل" : form.status === "partial" ? "مسدد جزئيًا" : "غير مسدد"}</div></Field>
        </>
      )}

      {kind === "payment" && (
        <>
          <Field label="المبلغ"><TextInput type="number" value={form.amount} onChange={setNum("amount")} dir="ltr" /></Field>
          <Field label="الحالة">
            <select value={form.status} onChange={set("status")} className={inputCls} style={inputStyle}>
              <option value="pending">قيد المراجعة</option>
              <option value="rejected">مرفوض</option>
            </select>
          </Field>
        </>
      )}

      {kind !== "income" && kind !== "supplier" && <FileAttach files={form.attachments || []} onChange={(files) => setForm(f => ({ ...f, attachments: files }))} />}
      {kind === "supplier" && <SupplierFields form={form} setForm={setForm} />}
      <Button className="w-full mt-2" disabled={kind === "debt" && !(Number(form.amount) > 0 && Number(form.amount) >= Number(form.paidAmount || 0))} onClick={() => onSave(form)}>حفظ التعديلات</Button>
    </Modal>
  );
}
