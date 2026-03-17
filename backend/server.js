const express = require("express");
const cors = require("cors");
const path = require("path");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const serverless = require("serverless-http");
require("dotenv").config();

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
  app.listen(PORT, () => {
    console.log(`\n🚀 Voice Form AI Server running at http://localhost:${PORT}`);
    console.log(`📋 POST /extract  — Speech → LLM → JSON form data`);
    console.log(`💚 GET  /health   — Server health check\n`);
  });
}
