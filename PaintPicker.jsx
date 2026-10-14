// منتقي ألوان متقدم يعمل داخل لوحة سفلية لا تتجاوز الشاشة:
//   • مربع التشبع/السطوع + شريط درجة اللون + شريط الشفافية (بخلفية مربعات) + حقل HEX قابل للكتابة + معاينة حية
//   • تبويبان: «لون واحد» و«تدرج لوني» (نقاط متعددة: إضافة/تعديل/حذف/موضع/شفافية، اتجاه، أنماط جاهزة)
// الإغلاق أو الإلغاء لا يمسّ أي تغيير آخر غير محفوظ في شاشة التخصيص: المنتقي يعدّل نسخة محلية ولا يكتب إلا عند «تطبيق».
import React, { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import {
  clamp, parseColor, toHex6, hexToHsv, hsvToHex, rgbaCss, normalizePaint, paintToCss, solidPaint, toGradient, toSolid,
  addStop, removeStop, updateStop, setAngle, isGradient, paintStopHexes, GRADIENT_PRESETS, PALETTE_SWATCHES, ANGLE_CHOICES, MIN_STOPS, MAX_STOPS,
} from "./paints";
import { worstContrast, DARK_TEXT, LIGHT_TEXT } from "./colors";

const toLatin = (s) => String(s ?? "").replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d)).replace(/[۰-۹]/g, (d) => "۰۱۲۳۴۵۶۷۸۹".indexOf(d));

// خلفية المربعات التي توضح الفرق بين الشفاف والمعتم
export const CHECKER = {
  backgroundColor: "#FFFFFF",
  backgroundImage: "linear-gradient(45deg,#C9CED6 25%,transparent 25%,transparent 75%,#C9CED6 75%),linear-gradient(45deg,#C9CED6 25%,transparent 25%,transparent 75%,#C9CED6 75%)",
  backgroundSize: "12px 12px",
  backgroundPosition: "0 0,6px 6px",
};
export function PaintSwatch({ css, className = "", style, children }) {
  return (
    <span className={`relative inline-block overflow-hidden ${className}`} style={{ ...CHECKER, ...style }}>
      <span className="absolute inset-0" style={{ background: css }} />
      {children}
    </span>
  );
}

// ---------- سحب بالمؤشر (ماوس/لمس) ----------
function useDrag(onMove) {
  const ref = useRef(null);
  const dragging = useRef(false);
  const handle = (e) => {
    const el = ref.current; if (!el) return;
    const r = el.getBoundingClientRect();
    onMove(clamp((e.clientX - r.left) / (r.width || 1), 0, 1), clamp((e.clientY - r.top) / (r.height || 1), 0, 1));
  };
  return {
    ref,
    onPointerDown: (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      dragging.current = true;
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* غير مدعوم */ }
      handle(e);
    },
    onPointerMove: (e) => { if (dragging.current) handle(e); },
    onPointerUp: (e) => { dragging.current = false; try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* تجاهل */ } },
    onPointerCancel: () => { dragging.current = false; },
    touchAction: "none",
  };
}
function onSliderKey(e, value, step, lo, hi, set) {
  let d = 0;
  if (e.key === "ArrowRight" || e.key === "ArrowUp") d = step; else if (e.key === "ArrowLeft" || e.key === "ArrowDown") d = -step;
  else if (e.key === "PageUp") d = step * 10; else if (e.key === "PageDown") d = -step * 10; else return;
  e.preventDefault(); set(clamp(value + d, lo, hi));
}
function Thumb({ pos, color, size = 24 }) {
  return <span aria-hidden="true" className="absolute pointer-events-none rounded-full" style={{ top: "50%", left: `calc(${clamp(pos, 0, 100)}% - ${size / 2}px)`, width: size, height: size, transform: "translateY(-50%)", border: "3px solid #fff", boxShadow: "0 0 0 1.5px rgba(0,0,0,.4), 0 2px 6px rgba(0,0,0,.35)", background: color }} />;
}

// ---------- مربع التشبع والسطوع ----------
function SvSquare({ h, s, v, onChange }) {
  const d = useDrag((x, y) => onChange(x, 1 - y));
  const { touchAction, ...props } = d;
  return (
    <div {...props} role="slider" tabIndex={0} aria-label="التشبع والسطوع" aria-valuetext={`تشبع ${Math.round(s * 100)}٪ وسطوع ${Math.round(v * 100)}٪`}
      onKeyDown={(e) => { if (e.key === "ArrowLeft" || e.key === "ArrowRight") onSliderKey(e, s, 0.02, 0, 1, (n) => onChange(n, v)); else onSliderKey(e, v, 0.02, 0, 1, (n) => onChange(s, n)); }}
      className="relative w-full rounded-xl select-none"
      style={{ touchAction, direction: "ltr", height: 176, cursor: "crosshair", background: `linear-gradient(to top,#000,rgba(0,0,0,0)),linear-gradient(to right,#fff,hsl(${Math.round(h)},100%,50%))` }}>
      <span aria-hidden="true" className="absolute pointer-events-none rounded-full" style={{ left: `calc(${s * 100}% - 11px)`, top: `calc(${(1 - v) * 100}% - 11px)`, width: 22, height: 22, border: "3px solid #fff", boxShadow: "0 0 0 1.5px rgba(0,0,0,.45), 0 2px 6px rgba(0,0,0,.4)", background: hsvToHex(h, s, v) }} />
    </div>
  );
}
function HueBar({ h, onChange }) {
  const d = useDrag((x) => onChange(x * 360));
  const { touchAction, ...props } = d;
  return (
    <div {...props} role="slider" tabIndex={0} aria-label="درجة اللون" aria-valuemin={0} aria-valuemax={360} aria-valuenow={Math.round(h)}
      onKeyDown={(e) => onSliderKey(e, h, 3, 0, 360, onChange)}
      className="relative h-6 rounded-full select-none"
      style={{ touchAction, direction: "ltr", cursor: "pointer", background: "linear-gradient(to right,#f00 0%,#ff0 17%,#0f0 33%,#0ff 50%,#00f 67%,#f0f 83%,#f00 100%)" }}>
      <Thumb pos={(h / 360) * 100} color={hsvToHex(h, 1, 1)} />
    </div>
  );
}
function AlphaBar({ color, alpha, min, onChange }) {
  const d = useDrag((x) => onChange(clamp(Math.round(x * 100) / 100, min, 1)));
  const { touchAction, ...props } = d;
  const c = parseColor(color) || { r: 0, g: 0, b: 0 };
  return (
    <div {...props} role="slider" tabIndex={0} aria-label="الشفافية" aria-valuemin={Math.round(min * 100)} aria-valuemax={100} aria-valuenow={Math.round(alpha * 100)}
      onKeyDown={(e) => onSliderKey(e, alpha, 0.02, min, 1, onChange)}
      className="relative h-6 rounded-full select-none"
      style={{ touchAction, direction: "ltr", cursor: "pointer" }}>
      <span className="absolute inset-0 rounded-full overflow-hidden" style={CHECKER}>
        <span className="absolute inset-0" style={{ background: `linear-gradient(to right, rgba(${c.r},${c.g},${c.b},0), rgb(${c.r},${c.g},${c.b}))` }} />
        {min > 0 && <span className="absolute top-0 bottom-0 left-0" style={{ width: `${min * 100}%`, background: "rgba(255,255,255,.7)" }} />}
      </span>
      <Thumb pos={alpha * 100} color={rgbaCss({ ...c, a: alpha })} />
    </div>
  );
}

// ---------- حقول الإدخال ----------
function NumberBox({ value, min, max, onCommit, ui, width = 58, label, lazy = false }) {
  const [txt, setTxt] = useState(String(value));
  useEffect(() => { setTxt(String(value)); }, [value]);
  const commit = (v) => { if (v !== "") onCommit(clamp(parseInt(v, 10), min, max)); };
  return (
    <input dir="ltr" inputMode="numeric" aria-label={label} value={txt}
      className="rounded-lg px-2 py-1.5 text-center text-[13px] font-bold outline-none"
      style={{ width, border: `1px solid ${ui.line}`, background: ui.card, color: ui.ink }}
      onChange={(e) => { const v = toLatin(e.target.value).replace(/[^\d]/g, ""); setTxt(v); if (!lazy) commit(v); }}
      onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
      onBlur={() => { if (lazy) commit(txt); setTxt(String(value)); }} />
  );
}
function HexInput({ value, onCommit, ui }) {
  const [txt, setTxt] = useState(value);
  useEffect(() => { setTxt(value); }, [value]);
  const digits = (s) => String(s).trim().replace(/^#/, "");
  const isHexDigits = (d) => /^[0-9a-fA-F]+$/.test(d);
  return (
    <input dir="ltr" value={txt} spellCheck={false} autoCapitalize="characters" aria-label="قيمة اللون HEX"
      className="w-full rounded-lg px-3 py-2 text-[14px] font-bold outline-none"
      style={{ border: `1px solid ${ui.line}`, background: ui.card, color: ui.ink }}
      onChange={(e) => {
        const v = toLatin(e.target.value); setTxt(v);
        const d = digits(v);
        if (isHexDigits(d) && (d.length === 6 || d.length === 8)) { const c = parseColor("#" + d); if (c) onCommit(c, d.length === 8); }
      }}
      onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
      onBlur={() => {
        const d = digits(txt);
        const c = isHexDigits(d) && [3, 4, 6, 8].includes(d.length) ? parseColor("#" + d) : null;
        if (c) onCommit(c, d.length === 4 || d.length === 8);
        setTxt(value);
      }} />
  );
}

// ---------- شريط التدرج بنقاطه القابلة للسحب ----------
function GradientBar({ paint, sel, onSelect, onMove, ui }) {
  const ref = useRef(null);
  const drag = useRef(-1);
  const posOf = (e) => { const r = ref.current.getBoundingClientRect(); return clamp(((e.clientX - r.left) / (r.width || 1)) * 100, 0, 100); };
  return (
    <div dir="ltr" className="pt-1 pb-9">
      <div ref={ref} className="relative" style={{ touchAction: "none" }}
        onPointerMove={(e) => { if (drag.current >= 0) drag.current = onMove(drag.current, Math.round(posOf(e))); }}
        onPointerUp={(e) => { drag.current = -1; try { ref.current.releasePointerCapture(e.pointerId); } catch { /* تجاهل */ } }}
        onPointerCancel={() => { drag.current = -1; }}>
        <PaintSwatch css={paintToCss({ ...paint, angle: 90 })} className="block w-full rounded-xl" style={{ height: 40, border: `1px solid ${ui.line}` }} />
        {paint.stops.map((s, i) => (
          <button key={i} type="button" aria-label={`النقطة ${i + 1} عند ${Math.round(s.pos)}٪`}
            onPointerDown={(e) => { e.stopPropagation(); drag.current = i; onSelect(i); try { ref.current.setPointerCapture(e.pointerId); } catch { /* تجاهل */ } }}
            className="absolute rounded-full p-0"
            style={{ left: `calc(${s.pos}% - 13px)`, top: 46, width: 26, height: 26, border: `3px solid ${i === sel ? ui.ink : "#FFFFFF"}`, boxShadow: "0 0 0 1.5px rgba(0,0,0,.35), 0 2px 5px rgba(0,0,0,.3)", touchAction: "none", overflow: "hidden" }}>
            <PaintSwatch css={rgbaCss({ ...parseColor(s.color), a: s.alpha })} className="block w-full h-full" />
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------- المنتقي ----------
// value: طلاء (انظر paints.js) · allowGradient: يعرض تبويب التدرج فقط للعناصر التي ترسمه الواجهة فعلًا · minAlpha: أدنى شفافية مسموحة
// showAlpha=false يخفي الشفافية للعناصر التي لا تقبلها · ui: ألوان واجهة التطبيق الحالية · onApply(paint)
export default function PaintPicker({ title = "اختيار اللون", value, allowGradient = false, minAlpha = 0, showAlpha = true, backdrop = "#FFFFFF", textOver = false, ui, icon = null, onApply, onClose }) {
  const alphaMin = showAlpha ? clamp(minAlpha, 0, 0.95) : 1;
  const init = normalizePaint(value);
  const initGrad = isGradient(init) && allowGradient;
  const startSolid = isGradient(init) ? toSolid(init) : init;
  const [mode, setMode] = useState(initGrad ? "linear" : "solid");
  const [solid, setSolid] = useState(() => (showAlpha ? { ...startSolid, alpha: clamp(startSolid.alpha, alphaMin, 1) } : { ...startSolid, alpha: 1 }));
  const [grad, setGradState] = useState(() => (initGrad ? init : toGradient(startSolid)));
  const gradRef = useRef(grad);
  const setGrad = (g) => { gradRef.current = g; setGradState(g); };
  const [touched, setTouched] = useState(initGrad);
  const [sel, setSel] = useState(0);
  const selSafe = Math.min(sel, grad.stops.length - 1);
  const cur = mode === "linear" ? grad.stops[selSafe] : solid;
  const [hsv, setHsv] = useState(() => hexToHsv(cur.color));

  useEffect(() => {
    const f = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", f);
    return () => window.removeEventListener("keydown", f);
  }, [onClose]);

  // ---- تعديل اللون الحالي (لون واحد أو نقطة التدرج المحددة) ----
  const commit = (patch) => {
    const p = { ...patch };
    if (p.alpha !== undefined) p.alpha = clamp(p.alpha, alphaMin, 1);
    if (mode === "solid") setSolid((s) => solidPaint(p.color ?? s.color, p.alpha ?? s.alpha));
    else { setTouched(true); setGrad(updateStop(gradRef.current, selSafe, p).paint); }
  };
  const fromHsv = (n) => { setHsv(n); commit({ color: hsvToHex(n.h, n.s, n.v) }); };
  const applyColor = (c, withAlpha) => { const hex = toHex6(c); setHsv(hexToHsv(hex)); commit(withAlpha && showAlpha ? { color: hex, alpha: c.a } : { color: hex }); };

  // ---- التبويبان ----
  const switchMode = (m) => {
    if (m === mode || (m === "linear" && !allowGradient)) return;
    if (m === "linear") {
      if (!touched) setGrad(toGradient(solid));
      setSel(0); setHsv(hexToHsv(gradRef.current.stops[0].color)); setMode("linear");
    } else {
      const s = toSolid(gradRef.current, selSafe);
      setSolid(s); setHsv(hexToHsv(s.color)); setMode("solid");
    }
  };

  // ---- نقاط التدرج ----
  const selectStop = (i) => { setSel(i); setHsv(hexToHsv(gradRef.current.stops[i].color)); };
  const moveStop = (i, pos) => { const r = updateStop(gradRef.current, i, { pos }); setGrad(r.paint); setSel(r.index); setTouched(true); return r.index; };
  const addPoint = () => { const r = addStop(gradRef.current); if (r.index < 0) return; setGrad(r.paint); setSel(r.index); setHsv(hexToHsv(r.paint.stops[r.index].color)); setTouched(true); };
  const removeAt = (i) => {
    const g = removeStop(gradRef.current, i); if (g === gradRef.current) return;
    const ni = Math.min(i < selSafe ? selSafe - 1 : selSafe, g.stops.length - 1);
    setGrad(g); setSel(ni); setHsv(hexToHsv(g.stops[ni].color)); setTouched(true);
  };
  const choosePreset = (pr) => {
    let g = normalizePaint(pr.paint);
    if (alphaMin > 0) g = { ...g, stops: g.stops.map((s) => ({ ...s, alpha: Math.max(s.alpha, alphaMin) })) };
    setTouched(true); setGrad(g); setSel(0); setHsv(hexToHsv(g.stops[0].color));
  };

  const previewPaint = mode === "linear" ? grad : solid;
  const css = paintToCss(previewPaint);
  const hexes = paintStopHexes(previewPaint, backdrop);
  const dark = worstContrast(DARK_TEXT, hexes), light = worstContrast(LIGHT_TEXT, hexes);
  const prevText = dark >= light ? DARK_TEXT : LIGHT_TEXT;
  const lowContrast = textOver && Math.max(dark, light) < 4.5;
  const summary = mode === "linear" ? `${grad.stops.length} نقاط · ${Math.round(grad.angle)}°` : `${solid.color}${showAlpha ? ` · ${Math.round(solid.alpha * 100)}%` : ""}`;
  const apply = () => onApply(mode === "linear" ? normalizePaint(gradRef.current) : normalizePaint(solid));

  const chip = (on) => (on ? { background: ui.solid, color: ui.solidText } : { background: ui.card, border: `1px solid ${ui.line}`, color: ui.ink });

  return createPortal(
    <div dir="rtl" lang="ar" className="fixed inset-0 z-[95] flex items-end sm:items-center justify-center" onClick={onClose}
      style={{ background: "rgba(10,12,20,.55)", fontFamily: "'Tajawal','Segoe UI',Tahoma,sans-serif", color: ui.ink }}>
      <div role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}
        className="w-full sm:max-w-md rounded-t-3xl sm:rounded-3xl flex flex-col" style={{ background: ui.bg, maxHeight: "92vh" }}>
        <div className="flex items-center gap-3 px-4 py-3 shrink-0" style={{ borderBottom: `1px solid ${ui.line}` }}>
          {icon}
          <h3 className="flex-1 min-w-0 truncate text-[16px] font-extrabold">{title}</h3>
          <button type="button" onClick={onClose} aria-label="إغلاق" className="w-8 h-8 rounded-full flex items-center justify-center" style={{ background: ui.card, color: ui.soft }}>✕</button>
        </div>

        <div className="overflow-y-auto px-4 py-3 space-y-3" style={{ WebkitOverflowScrolling: "touch" }}>
          {allowGradient && (
            <div role="tablist" className="grid grid-cols-2 gap-1.5 p-1 rounded-2xl" style={{ background: ui.card, border: `1px solid ${ui.line}` }}>
              {[["solid", "لون واحد"], ["linear", "تدرج لوني"]].map(([id, l]) => (
                <button key={id} type="button" role="tab" aria-selected={mode === id} onClick={() => switchMode(id)} className="py-2 rounded-xl text-[13px] font-extrabold" style={mode === id ? { background: ui.solid, color: ui.solidText } : { color: ui.ink }}>{l}</button>
              ))}
            </div>
          )}

          <div className="rounded-2xl overflow-hidden" style={{ border: `1px solid ${ui.line}` }}>
            <PaintSwatch css={css} className="block w-full" style={{ height: 64 }}>
              <span className="absolute inset-0 flex items-center justify-center text-[13px] font-extrabold" style={{ color: prevText }}>معاينة اللون</span>
            </PaintSwatch>
            <div className="flex items-center justify-between gap-2 px-3 py-2 text-[11px] font-bold" style={{ background: ui.card, color: ui.soft }}>
              <span dir="ltr">{summary}</span>
              {lowContrast && <span style={{ color: ui.danger }}>قد يصعب قراءة النص فوق هذا اللون</span>}
            </div>
          </div>

          {mode === "linear" && (
            <div className="space-y-3">
              <GradientBar paint={grad} sel={selSafe} onSelect={selectStop} onMove={moveStop} ui={ui} />

              <div>
                <div className="text-[12px] font-bold mb-1.5" style={{ color: ui.soft }}>اتجاه التدرج</div>
                <div className="flex items-center gap-1.5 flex-wrap" dir="ltr">
                  {ANGLE_CHOICES.map(([deg, arrow]) => (
                    <button key={deg} type="button" aria-label={`اتجاه ${deg} درجة`} aria-pressed={Math.round(grad.angle) === deg}
                      onClick={() => { setTouched(true); setGrad(setAngle(gradRef.current, deg)); }}
                      className="w-9 h-9 rounded-xl text-[17px] font-black" style={chip(Math.round(grad.angle) === deg)}>{arrow}</button>
                  ))}
                  <NumberBox value={Math.round(grad.angle)} min={0} max={360} label="زاوية التدرج" ui={ui} onCommit={(n) => { setTouched(true); setGrad(setAngle(gradRef.current, n % 360)); }} />
                  <span className="text-[12px] font-bold">°</span>
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <div className="text-[12px] font-bold" style={{ color: ui.soft }}>نقاط الألوان ({grad.stops.length})</div>
                  <button type="button" onClick={addPoint} disabled={grad.stops.length >= MAX_STOPS} className="text-[12px] font-extrabold px-3 py-1.5 rounded-lg disabled:opacity-40" style={{ background: ui.tint, color: ui.ink }}>+ إضافة نقطة</button>
                </div>
                <div className="space-y-1.5">
                  {grad.stops.map((s, i) => (
                    <div key={i} className="flex items-center gap-2 rounded-xl p-1.5" style={{ background: i === selSafe ? ui.tint : ui.card, border: `1.5px solid ${i === selSafe ? ui.ink : ui.line}` }}>
                      <button type="button" onClick={() => selectStop(i)} aria-label={`تحديد النقطة ${i + 1}`} className="flex items-center gap-2 flex-1 min-w-0 text-right">
                        <PaintSwatch css={rgbaCss({ ...parseColor(s.color), a: s.alpha })} className="w-9 h-9 rounded-lg shrink-0" style={{ border: `1px solid ${ui.line}` }} />
                        <span className="min-w-0">
                          <span className="block text-[12px] font-extrabold">نقطة {i + 1}</span>
                          <span dir="ltr" className="block text-[10px] font-bold truncate" style={{ color: ui.soft }}>{s.color}{showAlpha ? ` · ${Math.round(s.alpha * 100)}%` : ""}</span>
                        </span>
                      </button>
                      <span className="flex items-center gap-1 shrink-0" dir="ltr">
                        <NumberBox lazy value={Math.round(s.pos)} min={0} max={100} width={46} label={`موضع النقطة ${i + 1}`} ui={ui}
                          onCommit={(n) => { const r = updateStop(gradRef.current, i, { pos: n }); setGrad(r.paint); setSel(r.index); setHsv(hexToHsv(r.paint.stops[r.index].color)); setTouched(true); }} />
                        <span className="text-[11px] font-bold">%</span>
                      </span>
                      <button type="button" onClick={() => removeAt(i)} disabled={grad.stops.length <= MIN_STOPS} aria-label={`حذف النقطة ${i + 1}`} className="w-8 h-8 rounded-lg shrink-0 text-[14px] font-black disabled:opacity-30" style={{ background: ui.card, color: ui.danger, border: `1px solid ${ui.line}` }}>✕</button>
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <div className="text-[12px] font-bold mb-1.5" style={{ color: ui.soft }}>أنماط جاهزة</div>
                <div className="flex gap-2 overflow-x-auto pb-1" style={{ WebkitOverflowScrolling: "touch" }}>
                  {GRADIENT_PRESETS.map((pr) => (
                    <button key={pr.id} type="button" onClick={() => choosePreset(pr)} aria-label={`نمط ${pr.label}`} className="shrink-0 text-center">
                      <PaintSwatch css={paintToCss(pr.paint)} className="block rounded-xl" style={{ width: 68, height: 44, border: `1px solid ${ui.line}` }} />
                      <span className="block text-[10px] mt-1 font-bold" style={{ color: ui.soft }}>{pr.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          <div className="space-y-3">
            <div className="text-[12px] font-bold" style={{ color: ui.soft }}>{mode === "linear" ? `لون النقطة ${selSafe + 1}` : "اللون"}</div>
            <SvSquare h={hsv.h} s={hsv.s} v={hsv.v} onChange={(s, v) => fromHsv({ ...hsv, s, v })} />
            <HueBar h={hsv.h} onChange={(h) => fromHsv({ ...hsv, h })} />
            {showAlpha && <AlphaBar color={cur.color} alpha={cur.alpha} min={alphaMin} onChange={(a) => commit({ alpha: a })} />}
            {showAlpha && alphaMin > 0 && <div className="text-[11px]" style={{ color: ui.soft }}>الحد الأدنى للشفافية {Math.round(alphaMin * 100)}٪ حفاظًا على وضوح العنصر.</div>}
            <div className="flex items-end gap-2">
              <div className="flex-1 min-w-0">
                <div className="text-[11px] font-bold mb-1" style={{ color: ui.soft }}>HEX</div>
                <HexInput value={cur.color} onCommit={applyColor} ui={ui} />
              </div>
              {showAlpha && (
                <div className="shrink-0">
                  <div className="text-[11px] font-bold mb-1" style={{ color: ui.soft }}>الشفافية ٪</div>
                  <NumberBox value={Math.round(cur.alpha * 100)} min={Math.round(alphaMin * 100)} max={100} width={70} label="الشفافية بالنسبة المئوية" ui={ui} onCommit={(n) => commit({ alpha: n / 100 })} />
                </div>
              )}
            </div>
            <div className="flex flex-wrap gap-1.5" dir="ltr">
              {PALETTE_SWATCHES.map((hex) => (
                <button key={hex} type="button" onClick={() => applyColor(parseColor(hex), false)} aria-label={`اللون ${hex}`} className="w-7 h-7 rounded-full" style={{ background: hex, border: `2px solid ${ui.line}` }} />
              ))}
            </div>
          </div>
        </div>

        <div className="flex gap-2 px-4 pt-3 shrink-0" style={{ borderTop: `1px solid ${ui.line}`, paddingBottom: "max(12px, env(safe-area-inset-bottom))" }}>
          <button type="button" onClick={onClose} className="flex-1 py-2.5 rounded-xl text-[14px] font-bold" style={{ border: `1px solid ${ui.line}`, color: ui.ink }}>إلغاء</button>
          <button type="button" onClick={apply} className="flex-[2] py-2.5 rounded-xl text-[14px] font-extrabold" style={{ background: ui.btn, color: ui.btnText }}>تطبيق</button>
        </div>
      </div>
    </div>,
    document.body
  );
}
