import mammoth from "mammoth";
import multer from "multer";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GoogleGenAI, createPartFromUri } from "@google/genai";

export const config = {
  api: { bodyParser: false },
  maxDuration: 60
};

const MAX_FILE_SIZE = 3 * 1024 * 1024;
const MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";
const ai = process.env.GEMINI_API_KEY
  ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
  : null;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE, files: 1 }
});
const requestCounts = new Map();
const systemInstruction =
  "أنت Gloxy AI، مساعد ذكي يتحدث العربية ويفهم الصور والملفات. أجب بلغة المستخدم بوضوح. اعتمد على محتوى الملفات ولا تخترع معلومات. اذكر بوضوح إن كان جزء من الملف غير مقروء.";
const safeText = (value, max = 6000) =>
  typeof value === "string" ? value.slice(0, max) : "";

function applyBasicRateLimit(req, res) {
  const now = Date.now();
  const forwarded = req.headers["x-forwarded-for"];
  const ip = (typeof forwarded === "string" ? forwarded.split(",")[0].trim() : "") ||
    req.socket?.remoteAddress || "unknown";
  let entry = requestCounts.get(ip);
  if (!entry || now >= entry.resetAt) entry = { count: 0, resetAt: now + 3600000 };
  entry.count += 1;
  requestCounts.set(ip, entry);
  if (requestCounts.size > 1000) {
    for (const [key, value] of requestCounts) {
      if (now >= value.resetAt) requestCounts.delete(key);
    }
  }
  if (entry.count > 30) {
    res.setHeader("Retry-After", String(Math.max(1, Math.ceil((entry.resetAt - now) / 1000))));
    res.status(429).json({ error: "وصلت إلى الحد المؤقت للطلبات. حاول لاحقاً." });
    return false;
  }
  return true;
}

function runUpload(req, res) {
  return new Promise((resolve, reject) => {
    upload.single("file")(req, res, error => error ? reject(error) : resolve());
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "طريقة الطلب غير مدعومة." });
  }
  if (!applyBasicRateLimit(req, res)) return;

  let tempDir;
  try {
    await runUpload(req, res);
    if (!ai) {
      return res.status(503).json({
        error: "الخدمة تحتاج إعداد مفتاح Gemini API في إعدادات المشروع أولاً."
      });
    }

    const userText = safeText(req.body?.message);
    let history = [];
    try {
      const parsed = JSON.parse(req.body?.history || "[]");
      if (Array.isArray(parsed)) history = parsed;
    } catch {}

    const contents = history.slice(-8).map(item => ({
      role: item?.role === "assistant" || item?.role === "model" ? "model" : "user",
      parts: [{ text: safeText(item?.content) }]
    })).filter(item => item.parts[0].text);

    const latestParts = [];
    if (userText) latestParts.push({ text: userText });
    const file = req.file;
    if (!userText && !file) {
      return res.status(400).json({ error: "اكتب رسالة أو أرفق ملفاً أولاً." });
    }

    if (file) {
      const originalName = path.basename(file.originalname || "attachment");
      const ext = path.extname(originalName).toLowerCase();
      const mime = file.mimetype || "application/octet-stream";

      if (ext === ".docx") {
        const result = await mammoth.extractRawText({ buffer: file.buffer });
        latestParts.push({
          text: "محتوى ملف Word (" + originalName + "):\n" + result.value.slice(0, 60000)
        });
      } else if (
        [".txt", ".md", ".csv", ".js", ".html", ".css", ".json", ".xml", ".py", ".java", ".c", ".cpp", ".sql"].includes(ext) ||
        mime.startsWith("text/") || mime === "application/json"
      ) {
        latestParts.push({
          text: "محتوى الملف (" + originalName + "):\n" + file.buffer.toString("utf8").slice(0, 60000)
        });
      } else if (mime === "application/pdf" || mime.startsWith("image/")) {
        const allowedImages = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];
        if (mime.startsWith("image/") && !allowedImages.includes(mime)) {
          return res.status(415).json({ error: "صيغة الصورة غير مدعومة. استخدم JPG أو PNG أو WEBP." });
        }
        if (mime !== "application/pdf" && !allowedImages.includes(mime)) {
          return res.status(415).json({ error: "نوع الملف غير مدعوم." });
        }
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gloxy-"));
        const safeName = originalName.replace(/[^\w.\-]/g, "_").slice(0, 100) || "attachment";
        const tempPath = path.join(tempDir, safeName);
        await fs.writeFile(tempPath, file.buffer);
        const uploaded = await ai.files.upload({
          file: tempPath,
          config: { mimeType: mime, displayName: originalName.slice(0, 100) }
        });
        latestParts.push(createPartFromUri(uploaded.uri, uploaded.mimeType));
      } else {
        return res.status(415).json({
          error: "نوع الملف غير مدعوم. استخدم صورة أو PDF أو DOCX أو TXT أو MD أو CSV أو ملفاً نصياً."
        });
      }
    }

    contents.push({ role: "user", parts: latestParts });
    const result = await ai.models.generateContent({
      model: MODEL,
      contents,
      config: { systemInstruction, temperature: 0.65, maxOutputTokens: 4096 }
    });
    return res.status(200).json({
      answer: result.text || "لم أتمكن من إنشاء إجابة. حاول مرة أخرى.",
      model: MODEL
    });
  } catch (error) {
    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ error: "حجم الملف يجب ألا يتجاوز 3 MB." });
    }
    console.error("Gloxy API error:", error);
    const status = error?.status || 500;
    let message = "حدث خطأ أثناء الاتصال بالنموذج. تحقق من المفتاح والاتصال وحدود الاستخدام.";
    if (status === 429) message = "وصلت إلى حد الاستخدام المجاني مؤقتاً. انتظر قليلاً ثم أعد المحاولة.";
    if (status === 400) message = "تعذر فهم الطلب أو الملف. تحقق من صيغة الملف وحجمه.";
    return res.status(status >= 400 && status < 600 ? status : 500).json({ error: message });
  } finally {
    if (tempDir) {
      try { await fs.rm(tempDir, { recursive: true, force: true }); } catch {}
    }
  }
}
