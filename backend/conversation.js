require("dotenv").config({ path: require("path").join(__dirname, ".env") });
const { GoogleGenerativeAI } = require("@google/generative-ai");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

const REQUIRED_FIELDS = [
    "name", "email", "phone", "city", "college",
    "degree", "branch", "graduation_year", "cgpa", "skills"
];

class ConversationManager {
    constructor(ws) {
        this.ws = ws;
        this.state = REQUIRED_FIELDS.reduce((acc, field) => {
            acc[field] = "";
            return acc;
        }, {});
        this.history = [];
        this.accumulatedText = "";
        this.llmTimeout = null;
        this.isSpeaking = false;
    }

    // ── Called once on new connection: AI speaks first ────────────────────────
    async startConversation() {
        const openingQuestion =
            "Hello! Welcome to the placement registration assistant. " +
            "I will help you fill out your placement form using your voice. " +
            "Let's get started — could you please tell me your full name?";

        this.history.push({ role: "assistant", content: openingQuestion });
        this.speak(openingQuestion);
    }

    // ── Send text to frontend to be spoken via browser SpeechSynthesis ────────
    speak(text) {
        if (!text) return;
        console.log(`🔊 Speaking: "${text.substring(0, 60)}"`);

        // Tell frontend: mute mic, speak this text, then re-enable mic
        this.isSpeaking = true;
        this.ws.send(JSON.stringify({
            type: "speak",
            text: text
        }));
        // speaking_state true — mic muted on frontend
        this.ws.send(JSON.stringify({ type: "speaking_state", isSpeaking: true }));
    }

    // ── Called by frontend when TTS finishes playing ──────────────────────────
    onSpeakDone() {
        this.isSpeaking = false;
        this.ws.send(JSON.stringify({ type: "speaking_state", isSpeaking: false }));
        if (this.ws.readyState === 1) {
            this.ws.send(JSON.stringify({ type: "ready_for_input" }));
        }
    }

    // ── Receives transcribed speech from the frontend ─────────────────────────
    async handleUserSpeech(text) {
        if (!text || text.trim() === "") return;
        if (this.isSpeaking) return; // guard against echo

        this.accumulatedText += text + " ";
        if (this.llmTimeout) clearTimeout(this.llmTimeout);
        this.llmTimeout = setTimeout(() => this.processAccumulated(), 600);
    }

    async processAccumulated() {
        const textToProcess = this.accumulatedText.trim();
        this.accumulatedText = "";
        if (!textToProcess) return;

        this.history.push({ role: "user", content: textToProcess });

        const systemPrompt = `You are a helpful and polite voice assistant helping a user fill out a placement registration form over a live phone-style call.

Required fields: ${REQUIRED_FIELDS.join(", ")}

Current form state:
${JSON.stringify(this.state, null, 2)}

Instructions:
1. Examine the user's latest input and extract any matching field values.
2. Update the form state — do NOT overwrite already-filled fields unless the user explicitly corrects them.
3. Identify which fields are STILL MISSING (empty string or empty array).
4. Reply naturally — ask for only 1 or 2 missing fields at a time. Keep it conversational, like a friendly phone call.
5. If ALL fields are filled, reply: "Great! I now have all your details. Please say confirm to submit the form."
6. If the user says "confirm", "submit", or "yes please" AND all fields appear filled, set isConfirmed to true.

IMPORTANT: Return ONLY a valid JSON — no markdown, no extra text:
{
  "updatedState": {
    "name": "",
    "email": "",
    "phone": "",
    "city": "",
    "college": "",
    "degree": "",
    "branch": "",
    "graduation_year": "",
    "cgpa": "",
    "skills": []
  },
  "replyText": "Your conversational spoken reply here.",
  "isConfirmed": false
}`;

        const promptText = `${systemPrompt}\n\nConversation so far:\n${this.history.slice(-6).map(h => `${h.role}: ${h.content}`).join("\n")}`;

        try {
            const result = await model.generateContent(promptText);
            const rawContent = await result.response.text();

            const jsonStr = rawContent.replace(/```json?\n?/gi, "").replace(/```/gi, "").trim();
            const llmResponse = JSON.parse(jsonStr);

            // Merge state — keep existing values if LLM returns empty
            const merged = { ...this.state };
            for (const key of REQUIRED_FIELDS) {
                const newVal = llmResponse.updatedState[key];
                const isEmpty = !newVal || (Array.isArray(newVal) && newVal.length === 0) || String(newVal).trim() === "";
                if (!isEmpty) merged[key] = newVal;
            }
            this.state = merged;
            this.history.push({ role: "assistant", content: llmResponse.replyText });

            // Send form update + speak reply
            this.ws.send(JSON.stringify({
                type: "form_update",
                data: this.state,
                textReply: llmResponse.replyText,
                isConfirmed: !!llmResponse.isConfirmed
            }));

            if (llmResponse.replyText) {
                this.speak(llmResponse.replyText);
            }

        } catch (err) {
            console.error("LLM Error:", err.message || err);
            const errMsg = err.message && err.message.includes("API key not valid")
                ? "I am sorry, the Gemini API key appears to be invalid."
                : "I am sorry, I had a small hiccup. Could you please repeat that?";
            this.ws.send(JSON.stringify({ type: "error", message: errMsg }));
            this.speak(errMsg);
        }
    }
}

module.exports = ConversationManager;
