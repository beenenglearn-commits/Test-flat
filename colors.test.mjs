import * as C from './colors.js';
let pass=0,fail=0;const ok=(n,c,x)=>{c?pass++:(fail++,console.log('FAIL',n,x??''))};
// ---- دوال التباين
ok('contrast bw',Math.abs(C.contrast('#000000','#FFFFFF')-21)<0.01);
ok('textOn light bg keeps dark ink',C.textOn('#FFFFFF','#182620')==='#182620');
ok('textOn dark bg flips to light',C.textOn('#182620','#182620')===C.LIGHT_TEXT);
ok('textOn mid purple',C.contrast(C.textOn('#6631DB','#182620'),'#6631DB')>=4.5);
const t1=C.cardTone('#1B3347','#182620','#4F5F56');ok('cardTone dark card → light text',C.contrast(t1.ink,'#1B3347')>=7&&C.contrast(t1.soft,'#1B3347')>=4.5,JSON.stringify(t1));
const t2=C.cardTone('#FFFFFF','#182620','#9AA3AE');ok('cardTone fixes pale soft on light',C.contrast(t2.soft,'#FFFFFF')>=4.5,JSON.stringify(t2));
// ---- تدقيق كل ثيم
const light={...C.BASE_COLORS,...C.BASE_GROUPS,mode:'light'};
const themes={default:light,purple:{...light,...C.THEME_PRESETS.purple.colors},blue:{...light,...C.THEME_PRESETS.blue.colors},classic:{...light,...C.THEME_PRESETS.classic.colors},dark:{...light,...C.DARK_PALETTE,mode:'dark'}};
const cardKeys=['card','incomeCard','expenseCard','debtCard','paymentCard','supplierCard','invoiceCard','tabBg'];
for(const [name,t] of Object.entries(themes)){
  for(const r of C.auditTheme(t)) ok(`${name}: ${r.label} (${r.ratio.toFixed(1)}≥${r.min})`,r.ok);
  // الخط الرئيسي/الثانوي فوق كل خلفيات الكاردات (بعد التكيّف التلقائي) يحقق التباين
  const bgs=[...cardKeys.map(k=>t[k]),...(t.reportCards||[]),...(t.supplierPaletteA||[]),...(t.supplierPaletteB||[])];
  for(const bg of bgs){ const tone=C.cardTone(bg,t.ink,t.inkSoft); ok(`${name}: tone on ${bg}`,C.contrast(tone.ink,bg)>=7&&C.contrast(tone.soft,bg)>=4.5,JSON.stringify(tone)); }
  // خام: النص الثانوي المختار نفسه مقروء على الكاردات الرئيسية بدون تكيّف
  for(const k of ['card','incomeCard','expenseCard','debtCard','paymentCard','supplierCard']) ok(`${name}: raw inkSoft on ${k}`,C.contrast(t.inkSoft,t[k])>=4.5,C.contrast(t.inkSoft,t[k]).toFixed(2));
  // اتساق مجموعات الكاردات: لا أسود بجانب أبيض
  for(const [gk,arr] of [['reportCards',t.reportCards],['supplierA',t.supplierPaletteA],['supplierB',t.supplierPaletteB]]){
    const L=arr.map(C.lum); const spread=Math.max(...L)-Math.min(...L);
    ok(`${name}: ${gk} luminance spread ${spread.toFixed(2)}`,spread<=0.30);
  }
  // لا أبيض/أسود قاطع بين مجموعتي الموردين A و B
  const la=C.lum(t.supplierPaletteA[0]), lb=C.lum(t.supplierPaletteB[0]); ok(`${name}: supplier A/B close`,Math.abs(la-lb)<=0.30);
}
// الوضع الداكن: الكاردات أفتح من الخلفية (طبقات)
const d=themes.dark;
for(const k of ['card','surface','tabBg','supplierCard','incomeCard','expenseCard','debtCard','paymentCard']) ok(`dark elevation: ${k} lighter than bg`,C.lum(d[k])>C.lum(d.bg),k);
ok('dark inkSoft kept #AEBBB4',d.inkSoft==='#AEBBB4');
ok('dark weekLine light',C.contrast(d.weekLine,d.bg)>=7);
// weekLine/line المطلوبة: كحلي داكن جدًا في الفاتح
ok('default weekLine navy',themes.default.weekLine==='#1A1A2E'&&themes.purple.weekLine==='#1A1A2E');
ok('purple inkSoft #4A4A6A',themes.purple.inkSoft==='#4A4A6A');
// الإصلاح التلقائي يُنتج ثيمًا ناجحًا من ثيم سيّئ
const bad={...light,bg:'#6631DB',card:'#7B45F0',ink:'#8A5BFF',inkSoft:'#B796FE',weekLine:'#6631DB',line:'#7B45F0'};
ok('bad theme fails audit',C.auditTheme(bad).some(r=>!r.ok));
const fixed=C.autoFixTheme(bad);ok('autoFix passes audit',C.auditTheme(fixed).every(r=>r.ok),JSON.stringify(C.auditTheme(fixed).filter(r=>!r.ok)));
console.log(`colors.js: ${pass} passed, ${fail} failed`);
