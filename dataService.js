import { db, auth, firebaseConfig } from "./firebase";
import { initializeApp, getApps, getApp } from "firebase/app";
import {
  getAuth,
  createUserWithEmailAndPassword,
  signOut,
  deleteUser,
  updatePassword,
  reauthenticateWithCredential,
  EmailAuthProvider,
} from "firebase/auth";
import {
  collection,
  doc,
  addDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  setDoc,
  getDoc,
  getDocs,
  query,
  where,
  writeBatch,
  runTransaction,
  orderBy,
  limit,
} from "firebase/firestore";

const COLLECTIONS = {
  income: "incomes",
  expense: "expenses",
  debt: "debts",
  payment: "payments",
  support: "supportRequests",
  supplier: "suppliers",
  supplierTransaction: "supplierTransactions",
};

// ---------- سياق الحفظ: المتجر والعامل الحاليان ----------
// كل سجل جديد يُختم تلقائيًا بـ storeId (المتجر) و workerId/workerName (من نفّذ العملية)،
// فلا يعتمد الفصل بين المتاجر على ما تختاره الواجهة، وقواعد Firestore تتحقق منه أيضًا.
let ctx = { storeId: "", workerId: "", workerName: "", isAdmin: false };
export function setDataContext(next) { ctx = { ...ctx, ...next }; }

// Subscribes to a collection (filtered by store) and calls `callback` with a live array.
// كل عنصر يحمل _pending: true إذا كان قد كُتب على هذا الهاتف ولم يصل إلى الخادم بعد.
// عدّاد العمليات المكتوبة على هذا الهاتف ولم تصل إلى الخادم بعد (مجموع كل الاشتراكات)
const pendingByKey = new Map();
const pendingListeners = new Set();
function pendingTotal() { let n = 0; pendingByKey.forEach((v) => { n += v; }); return n; }
function emitPending() { const n = pendingTotal(); pendingListeners.forEach((f) => { try { f(n); } catch {} }); }
export function subscribePending(cb) {
  pendingListeners.add(cb);
  cb(pendingTotal());
  return () => { pendingListeners.delete(cb); };
}
let subSeq = 0;

export function subscribe(kind, callback, opts = {}) {
  const pendKey = `${kind}#${++subSeq}`;
  const colRef = collection(db, COLLECTIONS[kind]);
  const constraints = [];
  if (opts.storeId) constraints.push(where("storeId", "==", opts.storeId));
  if (opts.senderUid) constraints.push(where("senderUid", "==", opts.senderUid));
  const source = constraints.length ? query(colRef, ...constraints) : colRef;
  const unsub = onSnapshot(
    source,
    { includeMetadataChanges: true },
    (snap) => {
      const items = snap.docs.map((d) => ({ id: d.id, ...d.data(), _pending: d.metadata.hasPendingWrites }));
      const n = items.reduce((c, it) => c + (it._pending ? 1 : 0), 0);
      if (pendingByKey.get(pendKey) !== n) { pendingByKey.set(pendKey, n); emitPending(); }
      callback(items, { fromCache: snap.metadata.fromCache });
    },
    (error) => {
      console.error(`subscribe(${kind}) failed:`, error);
    }
  );
  return () => { pendingByKey.delete(pendKey); emitPending(); unsub(); };
}

export async function addItem(kind, data, opts = {}) {
  if (!ctx.storeId) throw new Error("لم يتم تحديد المتجر");
  const who = kind === "supplier" ? {} : { workerId: ctx.workerId || "", workerName: ctx.workerName || "" };
  // العامل: هويته من جلسته دائمًا ولا تطغى عليها بيانات النموذج. الأدمن (الاستيراد): يحتفظ باسم المنفّذ الأصلي إن وُجد.
  const payload = ctx.isAdmin ? { ...who, ...data, storeId: ctx.storeId } : { ...data, ...who, storeId: ctx.storeId };
  // معرّف ثابت: يمنع تكرار السجل (مثل دخل اليوم الواحد) لأن القواعد لا تسمح للعامل بالتعديل
  if (opts.id) return setDoc(doc(db, COLLECTIONS[kind], opts.id), payload);
  return addDoc(collection(db, COLLECTIONS[kind]), payload);
}

// استعادة نسخة احتياطية بلا تكرار: يُتخطى أي سجل معرّفه موجود. يرجع true إن أُضيف.
export async function restoreItem(kind, id, data) {
  if (!ctx.storeId) throw new Error("لم يتم تحديد المتجر");
  const ref = doc(db, COLLECTIONS[kind], id);
  const snap = await getDoc(ref);
  if (snap.exists()) return false;
  await setDoc(ref, { ...data, storeId: ctx.storeId });
  return true;
}

// ---------- سجل التدقيق (إضافة فقط؛ تفرضه القواعد) ----------
const AUDIT_SKIP = new Set(["attachments", "attachment", "image", "photo", "dataUrl", "logo", "_pending", "id"]);
function slim(obj) {
  const r = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (AUDIT_SKIP.has(k) || v === undefined || (v !== null && typeof v === "object")) continue;
    r[k] = typeof v === "string" && v.length > 160 ? v.slice(0, 160) : v;
  }
  return r;
}
function changedOnly(before, patch) {
  const b = {}, a = {};
  for (const [k, v] of Object.entries(slim(patch))) {
    if (before?.[k] !== v) { b[k] = before?.[k] ?? null; a[k] = v; }
  }
  return { before: b, after: a };
}
function auditEntry(action, kind, recordId, storeId, before, after) {
  return { at: new Date().toISOString(), byUid: ctx.workerId || auth.currentUser?.uid || "", byName: ctx.workerName || "", action, kind, recordId, storeId: storeId || ctx.storeId || "", before, after };
}
async function readBefore(ref) {
  try { const s = await getDoc(ref); return s.exists() ? s.data() : {}; } catch { return {}; }
}
async function auditedUpdate(ref, patch, kind, storeIdOf) {
  const before = await readBefore(ref);
  const ch = changedOnly(before, patch);
  const batch = writeBatch(db);
  batch.update(ref, patch);
  batch.set(doc(collection(db, "auditLog")), auditEntry("update", kind, ref.id, storeIdOf(before), ch.before, ch.after));
  return batch.commit();
}
export function subscribeAudit(callback) {
  return onSnapshot(query(collection(db, "auditLog"), orderBy("at", "desc"), limit(300)), (snap) => callback(snap.docs.map((x) => ({ id: x.id, ...x.data() }))), (e) => console.error("audit", e));
}

export async function updateItem(kind, id, patch) {
  // لا نسمح بتغيير المتجر عبر نموذج التعديل
  const { _pending, id: _drop, storeId: _store, ...clean } = patch;
  return auditedUpdate(doc(db, COLLECTIONS[kind], id), clean, kind, (b) => b.storeId);
}

export async function deleteItem(kind, id) {
  const ref = doc(db, COLLECTIONS[kind], id);
  const before = await readBefore(ref);
  const batch = writeBatch(db);
  batch.delete(ref);
  batch.set(doc(collection(db, "auditLog")), auditEntry("delete", kind, id, before.storeId, slim(before), {}));
  return batch.commit();
}

// ---------- الجلسة: من هو المستخدم الحالي؟ ----------
export const workerEmail = (username) => `${String(username || "").trim().toLowerCase()}@workers.daftar.app`;
export const validUsername = (u) => /^[a-z0-9._-]{3,20}$/.test(String(u || "").trim().toLowerCase());

export async function resolveSession(user) {
  const a = await getDoc(doc(db, "admins", user.uid));
  if (a.exists()) return { role: "admin", uid: user.uid, email: user.email || "", workerName: a.data().name || "الأدمن" };
  const w = await getDoc(doc(db, "workers", user.uid));
  if (!w.exists()) return null;
  const d = w.data();
  if (d.active === false) return { blocked: true };
  let storeName = "";
  try { const st = await getDoc(doc(db, "stores", d.storeId)); storeName = st.exists() ? st.data().name || "" : ""; } catch {}
  return { role: "worker", uid: user.uid, storeId: d.storeId, storeName, workerName: d.name || d.username || "" };
}

// إنشاء حساب الأدمن لأول مرة. تسمح القواعد بذلك مرة واحدة فقط (قبل وجود meta/setup).
export async function bootstrapAdmin(email, password, name) {
  const cred = await createUserWithEmailAndPassword(auth, email, password);
  try {
    const batch = writeBatch(db);
    const at = new Date().toISOString();
    batch.set(doc(db, "admins", cred.user.uid), { name: name || "الأدمن", email, createdAt: at });
    batch.set(doc(db, "meta", "setup"), { done: true, by: cred.user.uid, at });
    await batch.commit();
  } catch (e) {
    await deleteUser(cred.user).catch(() => {});
    throw new Error("تم إنشاء حساب الأدمن مسبقًا — استخدم تسجيل الدخول");
  }
}

// تغيير كلمة مرور الحساب الحالي (أدمن أو عامل)
export async function changeMyPassword(current, next) {
  const user = auth.currentUser;
  if (!user || !user.email) throw new Error("لا توجد جلسة دخول");
  await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, current));
  await updatePassword(user, next);
}

// ---------- المتاجر والعمال ----------
export function subscribeStores(callback) {
  return onSnapshot(collection(db, "stores"), (snap) => callback(snap.docs.map((d) => ({ id: d.id, ...d.data() }))), (e) => console.error("stores", e));
}
export function subscribeWorkers(callback) {
  return onSnapshot(collection(db, "workers"), (snap) => callback(snap.docs.map((d) => ({ id: d.id, ...d.data() }))), (e) => console.error("workers", e));
}
export async function addStore({ name, type }) {
  const ref = await addDoc(collection(db, "stores"), { name: name.trim(), type: (type || "").trim(), createdAt: new Date().toISOString() });
  return ref.id;
}
export function subscribeStoreDoc(id, callback) {
  return onSnapshot(doc(db, "stores", id), (snap) => callback(snap.exists() ? snap.data() : null), (e) => console.error("store", e));
}
// tzOffsetMin: فرق توقيت المتجر عن UTC بالدقائق؛ تستعمله القواعد لفرض نافذة الدخل بوقت الخادم
export const saveStoreHours = (id, incomeStart, incomeEnd) =>
  auditedUpdate(doc(db, "stores", id), { incomeStart, incomeEnd, hoursSetAt: new Date().toISOString(), tzOffsetMin: -new Date().getTimezoneOffset() }, "store", () => id);

// مراقبة ملف العامل نفسه: إيقاف فوري عند تعطيله، وتحديث اسمه إن غيّره الأدمن
export function subscribeOwnWorker(uid, callback) {
  return onSnapshot(doc(db, "workers", uid), (snap) => callback(snap.exists() ? snap.data() : null), () => {});
}
export const setWorkerActive = (uid, active) => updateDoc(doc(db, "workers", uid), { active });

// نسخة Firebase ثانوية تُستخدم لإنشاء حسابات العمال فقط، كي لا يُسجَّل خروج الأدمن
function secondaryAuth() {
  const app = getApps().find((a) => a.name === "secondary") || initializeApp(firebaseConfig, "secondary");
  return getAuth(app);
}
export async function createWorker({ name, username, pin, storeId, extra = {} }) {
  const uname = String(username).trim().toLowerCase();
  const sec = secondaryAuth();
  const cred = await createUserWithEmailAndPassword(sec, workerEmail(uname), pin);
  try {
    await setDoc(doc(db, "workers", cred.user.uid), { name: name.trim(), username: uname, storeId, active: true, createdAt: new Date().toISOString(), lastLoginAt: "", ...extra });
  } catch (e) {
    await deleteUser(cred.user).catch(() => {});
    throw e;
  }
  await signOut(sec).catch(() => {});
  return cred.user.uid;
}

// ---------- ترحيل البيانات القديمة (بلا storeId) إلى متجر ----------
export async function migrateLegacy(storeId) {
  let n = 0;
  for (const name of Object.values(COLLECTIONS)) {
    const snap = await getDocs(collection(db, name));
    const todo = snap.docs.filter((d) => !d.data().storeId);
    for (let i = 0; i < todo.length; i += 400) {
      const batch = writeBatch(db);
      const part = todo.slice(i, i + 400);
      part.forEach((d) => batch.update(d.ref, { storeId }));
      await batch.commit();
      n += part.length;
    }
  }
  return n;
}

// تأكيد السداد: قراءة السداد والدين وتحديثهما معًا أو لا شيء.
// يرفض: سدادًا غير معلّق (تأكيد مكرر)، أو مبلغًا أكبر من المتبقي، أو دينًا من متجر آخر.
export async function confirmPaymentTx(paymentId) {
  const payRef = doc(db, COLLECTIONS.payment, paymentId);
  await runTransaction(db, async (tx) => {
    const pSnap = await tx.get(payRef);
    if (!pSnap.exists()) throw new Error("طلب السداد غير موجود");
    const p = pSnap.data();
    if (p.status !== "pending") throw new Error("تمت معالجة هذا الطلب مسبقًا");
    const debtRef = doc(db, COLLECTIONS.debt, p.debtId);
    const dSnap = await tx.get(debtRef);
    if (!dSnap.exists()) throw new Error("الدين المرتبط بهذا السداد غير موجود");
    const d = dSnap.data();
    if (d.storeId !== p.storeId) throw new Error("السداد والدين من متجرين مختلفين");
    const amount = Number(p.amount) || 0;
    const total = Number(d.amount) || 0;
    const paidBefore = Number(d.paidAmount) || 0;
    const remainingBefore = Math.max(total - paidBefore, 0);
    if (amount <= 0) throw new Error("مبلغ السداد غير صالح");
    if (amount > remainingBefore + 0.0001) throw new Error(`المبلغ أكبر من المتبقي من الدين (${remainingBefore})`);
    const paid = paidBefore + amount;
    const remaining = Math.max(total - paid, 0);
    tx.update(payRef, { status: "confirmed", confirmedBy: auth.currentUser?.uid || "", confirmedAt: new Date().toISOString() });
    tx.set(doc(collection(db, "auditLog")), auditEntry("confirm", "payment", paymentId, p.storeId, { status: "pending" }, { status: "confirmed", amount, debtId: p.debtId }));
    tx.update(debtRef, { paidAmount: paid, remainingAmount: remaining, status: remaining === 0 ? "paid" : "partial" });
  });
}

// ---------- ملف العامل: إدارة ----------
export const updateWorker = (id, patch) => auditedUpdate(doc(db, "workers", id), patch, "worker", (b) => b.storeId);
export async function deleteWorker(id) {
  const ref = doc(db, "workers", id);
  const before = await readBefore(ref);
  const batch = writeBatch(db);
  batch.delete(ref);
  batch.set(doc(collection(db, "auditLog")), auditEntry("delete", "worker", id, before.storeId, slim(before), {}));
  return batch.commit();
}
export const updateStore = (id, patch) => auditedUpdate(doc(db, "stores", id), patch, "store", () => id);
// آخر دخول للعامل (يكتبه العامل نفسه؛ القواعد تسمح له بهذا الحقل وحده)
export const touchLogin = (uid) => updateDoc(doc(db, "workers", uid), { lastLoginAt: new Date().toISOString() });

// ---------- PIN إظهار نموذج دخول الأدمن ----------
// هذا إخفاء للواجهة وليس مصادقة: المصادقة الحقيقية حساب Firebase. الـPIN يُخزَّن مُجزَّأً (SHA-256 + salt).
const GATE_CACHE = "daftar_gate_cache";
async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export async function verifyGatePin(pin) {
  let gate = null;
  try {
    const snap = await getDoc(doc(db, "meta", "gate"));
    gate = snap.exists() ? snap.data() : null;
    try { localStorage.setItem(GATE_CACHE, JSON.stringify(gate)); } catch {}
  } catch {
    try { gate = JSON.parse(localStorage.getItem(GATE_CACHE) || "null"); } catch {}
  }
  if (!gate || !gate.hash) return pin === "000000"; // القيمة الافتراضية حتى يغيّرها الأدمن
  return (await sha256Hex(`${gate.salt}:${pin}`)) === gate.hash;
}
export async function setGatePin(pin) {
  const salt = [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const gate = { salt, hash: await sha256Hex(`${salt}:${pin}`), updatedAt: new Date().toISOString() };
  await setDoc(doc(db, "meta", "gate"), gate);
  try { localStorage.setItem(GATE_CACHE, JSON.stringify(gate)); } catch {}
}

// ---------- الأجهزة المسموح لها بإظهار فورم الأدمن ----------
// الحالة المحلية: "" (غير مسموح) | "pending" (أُظهر بالـPIN ولم يسجّل الأدمن دخوله بعد) | "registered" (مسجَّل في الخادم)
const DEVICE_ID_KEY = "daftar_device_id";
const DEVICE_STATE_KEY = "daftar_admin_device";
export function getDeviceId() {
  try {
    let id = localStorage.getItem(DEVICE_ID_KEY);
    if (!id) { id = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join(""); localStorage.setItem(DEVICE_ID_KEY, id); }
    return id;
  } catch { return "unknown"; }
}
export const getLocalDeviceState = () => { try { return localStorage.getItem(DEVICE_STATE_KEY) || ""; } catch { return ""; } };
const setLocalDeviceState = (v) => { try { if (v) localStorage.setItem(DEVICE_STATE_KEY, v); else localStorage.removeItem(DEVICE_STATE_KEY); } catch {} };
export const markDevicePending = () => setLocalDeviceState("pending");
function deviceLabel() {
  const ua = (typeof navigator !== "undefined" && navigator.userAgent) || "";
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Windows/.test(ua) ? "Windows" : /Mac/.test(ua) ? "Mac" : "جهاز";
  const br = /wv\)|Capacitor/.test(ua) ? "التطبيق" : /Chrome/.test(ua) ? "Chrome" : /Safari/.test(ua) ? "Safari" : "متصفح";
  return `${os} · ${br}`;
}
// يُنفَّذ بعد دخول الأدمن (الكتابة تتطلب صلاحية الأدمن)
export async function registerAdminDevice() {
  const id = getDeviceId();
  await setDoc(doc(db, "adminDevices", id), { label: deviceLabel(), addedAt: new Date().toISOString() });
  setLocalDeviceState("registered");
}
// قبل الدخول: هل يُظهر هذا الجهاز فورم الأدمن؟ (القراءة بالمعرّف العشوائي فقط مسموحة قبل المصادقة)
export async function checkDeviceAllowed() {
  const st = getLocalDeviceState();
  if (!st) return false;
  if (st === "pending") return true;
  try {
    const snap = await getDoc(doc(db, "adminDevices", getDeviceId()));
    if (snap.exists()) return true;
    setLocalDeviceState(""); // أزالها الأدمن من الإعدادات
    return false;
  } catch { return true; } // بلا اتصال: نثق بالحالة المحلية
}
export function subscribeAdminDevices(callback) {
  return onSnapshot(collection(db, "adminDevices"), (snap) => callback(snap.docs.map((d) => ({ id: d.id, ...d.data() }))), (e) => console.error("devices", e));
}
export async function removeAdminDevice(id) {
  await deleteDoc(doc(db, "adminDevices", id));
  if (id === getDeviceId()) setLocalDeviceState("");
}
