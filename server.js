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
async function callLLMSimplify({ text, targetLang='en', tone='friendly' }) {
  // Build system + user prompt
  const system = `You are a helpful medical-language simplifier. Convert clinical medical report text into clear, empathetic, patient-friendly language.
- Keep medical accuracy.
- Explain lab values simply (what they mean, normal ranges when relevant).
- Use short sentences and headings.
- Provide a short "what to do" section (1-3 action items).
- Output JSON with keys: "simplified", "visual_keywords" (array), "short_summary".`;

  const user = `Input report:\n"""${text}"""\nTarget language: ${targetLang}\nTone: ${tone}\nReturn JSON only (no extra commentary).`;

  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';

  // Basic safety: truncate excessively long input
  const MAX_INPUT_CHARS = 8000;
  if (text.length > MAX_INPUT_CHARS) {
    text = text.slice(0, MAX_INPUT_CHARS) + "\n\n[TRUNCATED]";
  }

  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ];

  // Call OpenAI Chat Completion
  const resp = await openai.chat.completions.create({
    model,
    messages,
    temperature: 0.2,
    max_tokens: 800
  });

  // The API returns choices; we parse the text (expecting JSON)
  const raw = resp?.choices?.[0]?.message?.content || resp?.choices?.[0]?.text || '';
  // Try parse JSON; fallback to a simple wrapper
  try {
    const parsed = JSON.parse(raw);
    return parsed;
  } catch (err) {
    // If not JSON, attempt to extract JSON inside text
    const jsonMatch = raw.match(/\{[\s\S]*\}$/);
    if(jsonMatch) {
      try { return JSON.parse(jsonMatch[0]); } catch(e) {}
    }
    // Fallback: return raw simplified text in structure
    return {
      simplified: raw,
      visual_keywords: [],
      short_summary: raw.split('\n').slice(0,3).join(' ')
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
app.post('/api/simplify', async (req, res) => {
  try {
    const { report, targetLang='en', tone='friendly' } = req.body || {};
    if (!report || String(report).trim().length === 0) {
      return res.status(400).json({ error: 'report text required' });
    }

    // Basic sanitation
    const clean = String(report).trim();

    // Call LLM
    const result = await callLLMSimplify({ text: clean, targetLang, tone });

    // Provide a few stock images keyed by likely visual keywords (fallback)
    const visualFallbacks = (result.visual_keywords && result.visual_keywords.length)
      ? result.visual_keywords.slice(0,4).map(k => ({
          keyword: k,
          // leave these as search hints for the frontend or simple unsplash links
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
