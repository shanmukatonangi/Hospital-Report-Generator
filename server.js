require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const multer = require('multer');
const pdf = require('pdf-parse');
const fs = require('fs/promises');
const rateLimit = require('express-rate-limit');
const { OpenAI } = require('openai');

const app = express();
const PORT = process.env.PORT || 4000;

// Security & parsing
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '200kb' })); // reports should be shortish; increase if needed

// Rate limiter (basic)
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10),
  max: parseInt(process.env.RATE_LIMIT_MAX || '30', 10),
  message: { error: 'Too many requests, slow down.' }
});
app.use('/api/', limiter);

// Static frontend
app.use('/', express.static(path.join(__dirname, 'public')));

// Setup multer for file uploads
const upload = multer({
  limits: {
    fileSize: 8 * 1024 * 1024 // 8MB max file
  },
  storage: multer.memoryStorage()
});

// OpenAI client
if(!process.env.OPENAI_API_KEY) {
  console.warn('OPENAI_API_KEY not set. The /api/simplify route will fail without it.');
}
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Helper: call LLM to simplify
// Helper: call LLM to simplify in layman-friendly format
async function callLLMSimplify({ text, targetLang = 'en', tone = 'friendly' }) {
  const system = `
You are a friendly and empathetic health explainer.
Your goal is to rewrite any diagnostic or medical report into a clear, positive, and easily understandable summary for a layperson.

Rules:
- Avoid jargon completely. Explain terms in plain language.
- Keep explanations short, friendly, and encouraging.
- Use emojis and headers to improve readability.
- Keep medical accuracy.
- Always output in the same structure below.

STRUCTURE TO FOLLOW STRICTLY:
1. **Overall Summary**
2. **Vital Signs**
3. **Blood Tests (Hematology)**
4. **Biochemistry (Liver, Kidney, Sugar, Cholesterol)**
5. **Thyroid Profile**
6. **Urine Test**
7. **Doctor’s Remarks**
8. **Simple Health Advice**
9. **Final Verdict**

Each section should have simple sentences (max 3–4 per section).
If some data is missing in the report, skip that section gracefully.
`;

  const user = `
Simplify and explain this medical report for a non-medical person.
Make it warm, encouraging, and conversational.

Report text:
"""${text}"""
Target language: ${targetLang}
Tone: ${tone}
Return plain text only with emojis and formatting.
`;

  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';

  const MAX_INPUT_CHARS = 8000;
  if (text.length > MAX_INPUT_CHARS) {
    text = text.slice(0, MAX_INPUT_CHARS) + "\n\n[TRUNCATED]";
  }

  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ];

  try {
    const resp = await openai.chat.completions.create({
      model,
      messages,
      temperature: 0.6,
      max_tokens: 1000
    });

    const raw = resp?.choices?.[0]?.message?.content?.trim() || '';
    return {
      simplified: raw,
      short_summary: raw.split('\n').slice(0, 3).join(' '),
      visual_keywords: ['healthy', 'blood', 'heart', 'fitness']
    };
  } catch (err) {
    console.error('LLM simplify error', err);
    return {
      simplified: 'Unable to simplify at the moment. Please try again later.',
      visual_keywords: [],
      short_summary: ''
    };
  }
}


// API: Upload file (pdf/txt) -> extracts text
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const { originalname, mimetype } = req.file;
    if (mimetype === 'text/plain' || originalname.endsWith('.txt')) {
      const txt = req.file.buffer.toString('utf8');
      return res.json({ text: txt });
    }
    // PDF parsing
    if (mimetype === 'application/pdf' || originalname.endsWith('.pdf')) {
      const data = await pdf(req.file.buffer);
      const text = (data && data.text) ? data.text.replace(/\r\n/g, '\n') : '';
      return res.json({ text });
    }
    return res.status(400).json({ error: 'Unsupported file type. Use .txt or .pdf' });
  } catch (err) {
    console.error('upload error', err);
    return res.status(500).json({ error: 'Failed to parse uploaded file' });
  }
});

// API: Simplify text
// current route
app.post('/api/simplify', async (req, res) => {
  try {
    const { report, targetLang='en', tone='friendly' } = req.body || {};
    if (!report || String(report).trim().length === 0) {
      return res.status(400).json({ error: 'report text required' });
    }

    // Basic sanitation
    const clean = String(report).trim();

    // ✅ Call LLM
    const result = await callLLMSimplify({ text: clean, targetLang, tone });

    // return JSON to frontend
    const visualFallbacks = (result.visual_keywords && result.visual_keywords.length)
      ? result.visual_keywords.slice(0,4).map(k => ({
          keyword: k,
          image_hint: `https://source.unsplash.com/featured/?${encodeURIComponent(k)}`
        }))
      : [
        { keyword: 'doctor-patient', image_hint: 'https://source.unsplash.com/featured/?doctor,patient' },
        { keyword: 'heart', image_hint: 'https://source.unsplash.com/featured/?heart' }
      ];

    return res.json({
      simplified: result.simplified || '',
      short_summary: result.short_summary || '',
      visual_cards: visualFallbacks
    });
  } catch (err) {
    console.error('simplify error', err);
    return res.status(500).json({ error: 'Failed to simplify. Check server logs.' });
  }
});


// Fallback to serve index
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
