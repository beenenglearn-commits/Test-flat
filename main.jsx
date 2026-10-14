import React from "react";
import ReactDOM from "react-dom/client";
// الخطوط مدمجة في الحزمة (تعمل دون إنترنت): تجوّل للنص العربي واللاتيني، وJetBrains Mono للأرقام
import "@fontsource/tajawal/arabic-400.css";
import "@fontsource/tajawal/arabic-500.css";
import "@fontsource/tajawal/arabic-700.css";
import "@fontsource/tajawal/arabic-900.css";
import "@fontsource/tajawal/latin-400.css";
import "@fontsource/tajawal/latin-500.css";
import "@fontsource/tajawal/latin-700.css";
import "@fontsource/tajawal/latin-900.css";
import "@fontsource/jetbrains-mono/latin-500.css";
import "@fontsource/jetbrains-mono/latin-600.css";
import "@fontsource/jetbrains-mono/latin-700.css";
import App from "./App.jsx";
import "./index.css";

// خطأ عرض واحد كان يُنتج شاشة بيضاء؛ الآن تظهر رسالة وزر إعادة التحميل (البيانات المحفوظة محليًا لا تُمسّ)
class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { failed: false }; }
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error, info) { console.error("UI error:", error, info?.componentStack); }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div dir="rtl" lang="ar" style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, background: "#F6F3EC", fontFamily: "'Tajawal','Segoe UI',Tahoma,sans-serif", color: "#182620", textAlign: "center" }}>
        <div>
          <div style={{ fontSize: 40, marginBottom: 8 }}>⚠️</div>
          <h1 style={{ fontSize: 18, fontWeight: 800, marginBottom: 8 }}>حدث خطأ غير متوقع</h1>
          <p style={{ fontSize: 13, opacity: 0.75, marginBottom: 16 }}>بياناتك محفوظة. أعد تحميل التطبيق للمتابعة.</p>
          <button onClick={() => window.location.reload()} style={{ background: "#182620", color: "#fff", border: 0, borderRadius: 12, padding: "10px 22px", fontSize: 14, fontWeight: 700 }}>إعادة التحميل</button>
        </div>
      </div>
    );
  }
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}
