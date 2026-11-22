import "dotenv/config";
import express from "express";
import multer from "multer";
import mammoth from "mammoth";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GoogleGenAI, createPartFromUri } from "@google/genai";

const app = express();
app.set("trust proxy", 1);
const PORT = process.env.PORT || 3000;
const MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";
const MAX_FILE_SIZE = 25 * 1024 * 1024;
const ai = process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_SIZE, files: 1 } });
const requestCounts = new Map();
app.use(express.static("public"));

app.use("/api/chat", (req, res, next) => {
  const now = Date.now();
  const key = req.ip || req.socket.remoteAddress || "unknown";
  let entry = requestCounts.get(key);
  if (!entry || now >= entry.resetAt) entry = { count: 0, resetAt: now + 3600000 };
  entry.count++;
  requestCounts.set(key, entry);
  if (entry.count > 30) {
    res.set("Retry-After", String(Math.max(1, Math.ceil((entry.resetAt - now) / 1000))));
    return res.status(429).json({ error: "وصلت إلى الحد المؤقت للطلبات. حاول لاحقاً." });
  }
  if (requestCounts.size > 1000) for (const [ip, value] of requestCounts) if (now >= value.resetAt) requestCounts.delete(ip);
  next();
});

const systemInstruction = "أنت Gloxy AI، مساعد ذكي يتحدث العربية ويفهم الصور والملفات. أجب بلغة المستخدم بوضوح. اعتمد على محتوى الملفات ولا تخترع معلومات. اذكر بوضوح إن كان جزء من الملف غير مقروء.";
const safeText = (v, max = 12000) => typeof v === "string" ? v.slice(0, max) : "";

app.post("/api/chat", upload.single("file"), async (req, res) => {
  let tempPath;
  try {
    if (!ai) return res.status(503).json({ error: "الخدمة تحتاج إعداد مفتاح Gemini API في إعدادات الخادم أولاً." });
    const userText = safeText(req.body.message);
    let history = [];
    try { history = JSON.parse(req.body.history || "[]"); if (!Array.isArray(history)) history = []; } catch {}
    const contents = history.slice(-16).map(m => ({
      role: m.role === "assistant" || m.role === "model" ? "model" : "user",
      parts: [{ text: safeText(m.content) }]
    })).filter(m => m.parts[0].text);
    const latestParts = [];
    if (userText) latestParts.push({ text: userText });
    const file = req.file;
    if (!userText && !file) return res.status(400).json({ error: "اكتب رسالة أو أرفق ملفاً أولاً." });

    if (file) {
      const originalName = file.originalname || "attachment";
      const ext = path.extname(originalName).toLowerCase();
      const mime = file.mimetype || "application/octet-stream";
      if (ext === ".docx") {
        const result = await mammoth.extractRawText({ buffer: file.buffer });
        latestParts.push({ text: "محتوى ملف Word (" + originalName + "):\n" + result.value.slice(0, 90000) });
      } else if ([".txt",".md",".csv",".js",".html",".css",".json",".xml",".py",".java",".c",".cpp",".sql"].includes(ext) || mime.startsWith("text/") || mime === "application/json") {
        latestParts.push({ text: "محتوى الملف (" + originalName + "):\n" + file.buffer.toString("utf8").slice(0, 90000) });
      } else if (mime === "application/pdf" || mime.startsWith("image/")) {
        const allowed = ["image/jpeg","image/png","image/webp","image/heic","image/heif"];
        if (mime.startsWith("image/") && !allowed.includes(mime)) return res.status(415).json({ error: "صيغة الصورة غير مدعومة. استخدم JPG أو PNG أو WEBP." });
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gloxy-"));
        tempPath = path.join(dir, originalName.replace(/[^\w.\-]/g, "_"));
        await fs.writeFile(tempPath, file.buffer);
        const uploaded = await ai.files.upload({ file: tempPath, config: { mimeType: mime, displayName: originalName.slice(0,100) } });
        latestParts.push(createPartFromUri(uploaded.uri, uploaded.mimeType));
      } else {
        return res.status(415).json({ error: "نوع الملف غير مدعوم. استخدم صورة أو PDF أو DOCX أو TXT أو MD أو CSV أو ملفاً نصياً." });
      }
    }
    contents.push({ role: "user", parts: latestParts });
    const result = await ai.models.generateContent({
      model: MODEL, contents,
      config: { systemInstruction, temperature: 0.65, maxOutputTokens: 4096 }
    });
    res.json({ answer: result.text || "لم أتمكن من إنشاء إجابة. حاول مرة أخرى.", model: MODEL });
  } catch (err) {
    console.error("Gloxy API error:", err);
    const status = err?.status || 500;
    let message = "حدث خطأ أثناء الاتصال بالنموذج. تحقق من المفتاح والاتصال وحدود الاستخدام.";
    if (status === 429) message = "وصلت إلى حد الاستخدام المجاني مؤقتاً. انتظر قليلاً ثم أعد المحاولة.";
    if (status === 400) message = "تعذر فهم الطلب أو الملف. تحقق من صيغة الملف وحجمه.";
    res.status(status >= 400 && status < 600 ? status : 500).json({ error: message });
  } finally {
    if (tempPath) try { await fs.rm(path.dirname(tempPath), { recursive: true, force: true }); } catch {}
  }
});
app.get("/api/health", (_req, res) => res.json({ ok: true, model: MODEL, configured: Boolean(ai) }));
app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: "حجم الملف يتجاوز 25 MB." });
  console.error("Request error:", err);
  res.status(500).json({ error: "حدث خطأ غير متوقع. حاول لاحقاً." });
});
app.listen(PORT, "0.0.0.0", () => console.log("Gloxy AI listening on port " + PORT));
