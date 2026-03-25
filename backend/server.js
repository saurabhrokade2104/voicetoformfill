require("dotenv").config({ path: require("path").join(__dirname, ".env") });
const express = require("express");
const cors = require("cors");
const path = require("path");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const serverless = require("serverless-http");
const http = require("http");
const WebSocket = require("ws");
const ConversationManager = require("./conversation");
const { textToSpeech } = require("./services/tts");

const app = express();

app.use(cors());
app.use(express.json());

// Serve static files from the frontend directory
app.use(express.static(path.join(__dirname, "../frontend")));

// Parse Twilio's application/x-www-form-urlencoded webhooks
app.use(express.urlencoded({ extended: true }));

// Mount Twilio voice routes
const twilioRoutes = require("./routes/twilio");
app.use("/twilio", twilioRoutes);

// Initialize Gemini AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

// ─── /extract endpoint ────────────────────────────────────────────────────────
app.post("/extract", async (req, res) => {
  const { speech_text, fields } = req.body;

  if (!speech_text) {
    return res.status(400).json({ error: "No speech text provided." });
  }

  // Build dynamic field list from frontend (or fallback to placement defaults)
  const fieldList = fields && fields.length > 0
    ? fields
    : [
      "name",
      "email",
      "phone",
      "city",
      "college",
      "degree",
      "branch",
      "graduation_year",
      "cgpa",
      "skills",
    ];

  const fieldNames = fieldList.join(", ");

  const systemPrompt = `You are an AI that extracts form data from spoken text.

Extract the following fields: ${fieldNames}

Rules:
- Return ONLY valid JSON with no extra text, no markdown, no explanation.
- If a field is not mentioned in the text, set its value to an empty string "".
- Normalize email addresses (lowercase).
- Phone numbers should contain only digits.
- Skills should be an array if multiple skills are mentioned.

Return format example:
{
  "name": "Saurabh Rokade",
  "email": "saurabh@gmail.com",
  "phone": "9876543210",
  "city": "Pune",
  "college": "",
  "degree": "",
  "branch": "",
  "graduation_year": "",
  "cgpa": "",
  "skills": []
}`;

  const userPrompt = `Text: ${speech_text}`;
  const fullPrompt = `${systemPrompt}\n\n${userPrompt}`;

  try {
    const result = await model.generateContent(fullPrompt);
    const response = await result.response;
    const rawContent = response.text().trim();

    // Parse and validate JSON
    let extracted;
    try {
      // Strip markdown code fences if any
      const jsonStr = rawContent.replace(/```json?\n?/gi, "").replace(/```/gi, "").trim();
      extracted = JSON.parse(jsonStr);
    } catch (parseErr) {
      console.error("JSON parse error:", parseErr.message, "\nRaw:", rawContent);
      return res.status(500).json({ error: "LLM returned invalid JSON.", raw: rawContent });
    }

    return res.json({ success: true, data: extracted });
  } catch (err) {
    console.error("Gemini error:", err.message);
    return res.status(500).json({ error: "LLM request failed.", details: err.message });
  }
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ─── /tts endpoint — Cartesia neural TTS ─────────────────────────────────────
app.post("/tts", async (req, res) => {
  const { text } = req.body;
  if (!text || !text.trim()) {
    return res.status(400).json({ error: "No text provided." });
  }
  try {
    const audioBuffer = await textToSpeech(text.trim());
    res.set("Content-Type", "audio/wav");
    res.set("Cache-Control", "no-store");
    res.send(audioBuffer);
  } catch (err) {
    console.error("[TTS] Cartesia error:", err.message || err);
    res.status(500).json({ error: "TTS synthesis failed.", details: err.message });
  }
});

module.exports.handler = serverless(app);

// Standard listener for Railway and local development
// We check if we are NOT running in a serverless environment
if (!process.env.NETLIFY && !process.env.LAMBDA_TASK_ROOT) {
  const PORT = process.env.PORT || 3000;
  const server = http.createServer(app);

  // Initialize WebSocket server for real-time live calling
  const wss = new WebSocket.Server({ server, path: "/live" });

  wss.on("connection", (ws) => {
    console.log("🎙️ New Live Call connection established.");
    const manager = new ConversationManager(ws);

    // AI speaks first — no user input needed
    manager.startConversation();

    ws.on("message", async (msg) => {
      try {
        const payload = JSON.parse(msg);
        if (payload.type === "text") {
          await manager.handleUserSpeech(payload.text);
        } else if (payload.type === "speak_done") {
          // Frontend finished speaking TTS — unmute mic
          manager.onSpeakDone();
        }
      } catch (err) {
        console.error("Message error:", err);
      }
    });

    ws.on("close", () => {
      console.log("📵 Live Call connection closed.");
    });
  });

  server.listen(PORT, () => {
    console.log(`\n🚀 Voice Form AI Server running at http://localhost:${PORT}`);
    console.log(`📋 POST /extract  — Speech → LLM → JSON form data`);
    console.log(`🔌 WS   /live     — Live real-time audio pipeline`);
    console.log(`💚 GET  /health   — Server health check\n`);
  });
}
