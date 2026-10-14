import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";

// البنية المسطّحة: كل ملفات المشروع في جذر المستودع (بدون مجلدي src و public).
// Vite ينسخ مجلد public إلى dist كما هو، لذلك ننشئه هنا تلقائيًا قبل البناء من
// الملفات الموجودة في الجذر — بنفس المسارات التي يتوقعها التطبيق (icons/... إلخ).
// إن كان مجلد public موجودًا أصلًا بملفاته فلا يُستبدل شيء.
const STATIC_FILES = {
  "manifest.json": "manifest.json",
  "sw.js": "sw.js",
  "icon-192.png": "icon-192.png",
  "icon-512.png": "icon-512.png",
  "logout.png": "icons/logout.png",
  "more.png": "icons/more.png",
  "notification.png": "icons/notification.png",
  "search.png": "icons/search.png",
  "settings.png": "icons/settings.png",
  "support.png": "icons/support.png",
  "store.png": "icons/store.png",
  "person.png": "icons/person.png",
  "whatsapp.png": "icons/whatsapp.png",
  "phone.png": "icons/phone.png",
  "calculator.png": "icons/calculator.png",
  "workers.png": "icons/workers.png",
  "audit.png": "icons/audit.png",
  "sun.png": "icons/sun.png",
  "clock.png": "icons/clock.png",
  "color-wheel.png": "icons/color-wheel.png",
  "moon.png": "icons/moon.png",
  "call.png": "icons/call.png",
};
const root = process.cwd();
for (const [from, to] of Object.entries(STATIC_FILES)) {
  const src = path.join(root, from);
  const dest = path.join(root, "public", to);
  if (fs.existsSync(src)) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

export default defineConfig({
  plugins: [react()],
  // رقم الإصدار الظاهر في القائمة: يأتي من CI (APP_VERSION) وإلا نسخة التطوير
  define: { __APP_VERSION__: JSON.stringify(process.env.APP_VERSION || `${pkg.version}-dev`) },
  base: "./", // important for Capacitor: assets must use relative paths
});
