# Gloxy AI

مساعد ذكي باللغة العربية يعمل كموقع ويب باستخدام Gemini API.

## التشغيل
1. ثبّت Node.js 20 أو أحدث.
2. نفّذ `npm install`.
3. أنشئ ملف `.env` اعتماداً على `.env.example` وأضف مفتاح Gemini API.
4. نفّذ `npm start` وافتح `http://localhost:3000`.

## النشر على Render
- Runtime: Node
- Build command: `npm install`
- Start command: `npm start`
- أضف `GEMINI_API_KEY` كمتغير بيئة سري في Render، ولا تضعه في GitHub.

يدعم التطبيق المحادثة والصور وPDF وDOCX والملفات النصية. يوجد حد أولي 30 طلباً لكل عنوان IP في الساعة. هذا لا يضمن 20,000 سؤال يومياً. حصص Gemini المجانية تتغير وقد تُستخدم بياناتها لتحسين منتجات Google؛ تجنب إرسال معلومات حساسة.
