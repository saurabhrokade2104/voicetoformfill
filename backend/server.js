require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const serverless = require("serverless-http");
const http = require("http");
const WebSocket = require("ws");
const ConversationManager = require("./conversation");

const app = express();

app.use(cors());
app.use(express.json());

// Serve static files from the frontend directory
// This is needed for standard deployments like Railway
app.use(express.static(path.join(__dirname, "../frontend")));

// Initialize Gemini AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite" });

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

// Export the handler for serverless use (Netlify)
module.exports.handler = serverless(app);

// Standard listener for Railway and local development
// We check if we are NOT running in a serverless environment
if (!process.env.NETLIFY && !process.env.LAMBDA_TASK_ROOT) {
  const PORT = process.env.PORT || 3000;

  app.use(express.urlencoded({ extended: true })); // Important for Twilio POST

  // ─── Twilio Phase 2: Inbound Call Handler ───
  app.post("/incoming-call", (req, res) => {
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
    <Response>
        <Say voice="Polly.Joey">Connecting you to the AI placement assistant. Please wait.</Say>
        <Connect>
            <Stream url="wss://${req.headers.host}/twilio-media" />
        </Connect>
    </Response>`;
    res.type("text/xml");
    res.send(twiml);
  });

  // ─── WebSocket Server Setup ───
  const server = http.createServer(app);
  const wss = new WebSocket.Server({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const pathname = url.pathname;

    if (pathname === "/live" || pathname === "/twilio-media") {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on("connection", (ws, req) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    if (pathname === "/twilio-media") {
      console.log("🎙️ Twilio Media Stream connected.");
      handleTwilioStream(ws);
    } else {
      console.log("🎙️ New Browser Live Connection.");
      const conversation = new ConversationManager(ws, "browser");
      ws.on("message", async (message) => {
        try {
          const data = JSON.parse(message);
          if (data.type === "text") {
            await conversation.handleUserSpeech(data.text);
          }
        } catch (e) {
          console.error("WS message error:", e);
        }
      });
    }

    ws.on("close", () => console.log("📵 Connection closed."));
  });

  // ─── Phase 2: Twilio Media Stream & Deepgram Bridge ───
  async function handleTwilioStream(ws) {
    const { createClient } = require("@deepgram/sdk");
    const deepgram = createClient(process.env.DEEPGRAM_API_KEY);

    // 1. Initialize Conversation Manager for Twilio
    const conversation = new ConversationManager(ws, "twilio");

    // 2. Setup Deepgram live transcription
    let dgConnection = deepgram.listen.live({
      model: "nova-2",
      language: "en-US",
      smart_format: true,
      encoding: "mulaw",
      sample_rate: 8000,
      interim_results: false,
      no_delay: true,
    });

    // Link them so manager can update deepgram language if needed
    conversation.setDeepgram(dgConnection, deepgram);

    dgConnection.on("open", () => {
      console.log("☁️ Deepgram STT connected.");
    });

    dgConnection.on("Transcript", async (data) => {
      const transcript = data.channel.alternatives[0].transcript;
      if (transcript && data.is_final) {
        console.log("Twilio User Speech:", transcript);
        await conversation.handleUserSpeech(transcript);
      }
    });

    dgConnection.on("error", (err) => console.error("Deepgram Error:", err));

    let streamSid = null;

    ws.on("message", (message) => {
      try {
        const msg = JSON.parse(message);
        if (msg.event === "start") {
          streamSid = msg.start.streamSid;
          conversation.setTwilioStream(streamSid);
          console.log("Twilio Stream SID:", streamSid);
          // Trigger first greeting after SID is known
          conversation.handleUserSpeech("hello");
        } else if (msg.event === "media") {
          // Forward raw mu-law audio to Deepgram
          const audioBuffer = Buffer.from(msg.media.payload, "base64");
          dgConnection.send(audioBuffer);
        }
      } catch (e) {
        // ignore
      }
    });

    ws.on("close", () => {
      dgConnection.finish();
    });
  }

  server.listen(PORT, () => {
    console.log(`\n🚀 Voice Form AI Server running at http://localhost:${PORT}`);
    console.log(`📋 POST /extract  — Speech → LLM → JSON form data`);
    console.log(`📞 POST /incoming-call — Twilio webhook for inbound calls`);
    console.log(`🔌 WS   /live     — Live real-time audio pipeline (Browser)`);
    console.log(`🔌 WS   /twilio-media — Live real-time audio pipeline (Twilio)`);
    console.log(`💚 GET  /health   — Server health check\n`);
  });
}
