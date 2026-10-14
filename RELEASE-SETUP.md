# إعداد الإصدارات الموقَّعة (مرة واحدة فقط)

الهدف: تحديث التطبيق فوق النسخة المثبتة **دون حذفه**، فلا تضيع عمليات لم تُرفع.
السبب الذي كان يمنع ذلك: كل APK debug يُوقَّع بمفتاح مختلف فيرفضه أندرويد كتحديث.

## 1) توليد مفتاح التوقيع (مرة واحدة)
1. GitHub ← Actions ← **Create signing key (run ONCE)** ← Run workflow.
2. افتح التشغيل ← Artifacts ← نزّل `daftar-signing-key-KEEP-PRIVATE` وفُكّ ضغطه.
3. **احفظ الملفات الثلاثة (`daftar.jks`, `keystore.b64`, `secrets.txt`) في مكانين خارج GitHub** (مدير كلمات مرور + فلاش/حساب آخر).
   ضياع المفتاح = لا تحديث بعد اليوم إلا بالحذف وإعادة التثبيت.
4. Settings ← Secrets and variables ← Actions ← New repository secret، أضف:
   - `KEYSTORE_BASE64` = محتوى `keystore.b64` كاملًا
   - `KEYSTORE_PASSWORD` = القيمة في `secrets.txt`
   - `KEY_ALIAS` = `daftar`
   - `KEY_PASSWORD` = القيمة في `secrets.txt`
5. احذف الـ artifact من صفحة التشغيل. لا تشغّل workflow المفتاح مرة ثانية (سينتج مفتاحًا مختلفًا).

## 2) بناء APK
Actions ← **Build Android APK (signed release)** ← Run workflow (اكتب ملاحظة إن شئت).
- `versionCode` يزيد تلقائيًا مع كل تشغيل، والإصدار الظاهر `1.0.<رقم التشغيل>`.
- في سجل الخطوة Sign APK تظهر **بصمة SHA-256**: يجب أن تبقى نفسها في كل إصدار.

## 3) توزيع التحديثات على العمال (Firebase App Distribution، مجاني)
1. Firebase Console ← Project settings ← Add app ← Android، اسم الحزمة **`com.daftar.app`** (انسخ App ID).
2. Release & Monitor ← App Distribution ← Get started ← Testers & Groups ← أنشئ مجموعة اسمها **`workers`** وأضف إيميلات العمال.
3. Project settings ← Service accounts ← Generate new private key (ملف JSON).
4. أضف سرّين: `FIREBASE_APP_ID` (من الخطوة 1) و`FIREBASE_SERVICE_ACCOUNT` (محتوى ملف JSON كاملًا).
5. بعدها كل بناء يُرسَل تلقائيًا للمجموعة، ويصل العمال إشعار بالتحديث، ويُثبَّت **فوق** النسخة القديمة.
   إن لم تضف السرّين يُبنى APK ويُرفع كـ artifact فقط (نزّله ووزّعه يدويًا).

## قواعد تشغيل للعمال
- لا يحذف أحد التطبيق قبل التأكد من اختفاء مؤشر «عمليات لم تُرفع».
- حدّث التطبيق مساءً بعد الإغلاق لا أثناء العمل.
- أول تثبيت: يحتاج العامل السماح بالتثبيت من المصدر (App Distribution / المتصفح) مرة واحدة.
