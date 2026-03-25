const { GoogleGenerativeAI } = require("@google/generative-ai");
const Cartesia = require("@cartesia/cartesia-js").default;

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

// Initialize Cartesia (requires CARTESIA_API_KEY in .env)
const cartesia = new Cartesia({
    apiKey: process.env.CARTESIA_API_KEY || "YOUR_CARTESIA_KEY",
});

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

        // We can hold previous dialogue in history for better LLM context
        this.history = [];
        this.accumulatedText = "";
        this.llmTimeout = null;
    }

    async handleUserSpeech(text) {
        if (!text || text.trim() === "") return;

        this.accumulatedText += text + " ";
        if (this.llmTimeout) clearTimeout(this.llmTimeout);
        this.llmTimeout = setTimeout(() => this.processAccumulated(), 1200);
    }

    async processAccumulated() {
        const textToProcess = this.accumulatedText.trim();
        this.accumulatedText = "";
        if (!textToProcess) return;

        this.history.push({ role: "user", content: textToProcess });

        const missingFields = REQUIRED_FIELDS.filter(f => !this.state[f] || (Array.isArray(this.state[f]) && this.state[f].length === 0));

        const systemPrompt = `You are a helpful and polite voice assistant helping a user fill out a placement registration form.
You are currently on a live call with the user.

Your goal is to extract the following fields from what the user just said:
${REQUIRED_FIELDS.join(", ")}

Here is the current state of the form (some fields might be filled already):
${JSON.stringify(this.state, null, 2)}

Instructions:
1. Examine the User's latest input. Extract any details that match the required fields.
2. Update the form state accordingly.
3. Look at what fields are STILL MISSING.
4. Formulate a short, conversational response asking the user for 1 or 2 of the missing fields. Do not ask for everything at once. Keep it natural like a phone call.
5. If ALL fields are filled, your reply text should be: "Great! I have all your details. Please say 'confirm' to submit the form."
6. If the user says something like "confirm", "submit", or "yes", and all details are filled, set "isConfirmed" to true.

You MUST respond strictly with a valid JSON object matching this schema:
{
  "updatedState": {
    "name": "...",
    "email": "...",
    "phone": "...",
    "city": "...",
    "college": "...",
    "degree": "...",
    "branch": "...",
    "graduation_year": "...",
    "cgpa": "...",
    "skills": ["..."]
  },
  "replyText": "The conversational reply to the user, spoken out loud.",
  "isConfirmed": false
}`;

        const promptText = `${systemPrompt}\n\nRecent History:\n${this.history.slice(-3).map(h => h.role + ": " + h.content).join("\n")}`;

        try {
            const result = await model.generateContent(promptText);
            const rawContent = await result.response.text();

            const jsonStr = rawContent.replace(/```json?\n?/gi, "").replace(/```/gi, "").trim();
            const llmResponse = JSON.parse(jsonStr);

            // Update local state
            this.state = { ...this.state, ...llmResponse.updatedState };
            this.history.push({ role: "assistant", content: llmResponse.replyText });

            // 1. Send form update to frontend
            this.ws.send(JSON.stringify({
                type: "form_update",
                data: this.state,
                textReply: llmResponse.replyText,
                isConfirmed: llmResponse.isConfirmed
            }));

            // 2. Stream audio response via Cartesia to frontend
            if (llmResponse.replyText) {
                await this.streamAudio(llmResponse.replyText);
            }

        } catch (err) {
            console.error("LLM Error:", err.message || err);
            // Bulletproof error fallback so the voice still speaks the error!
            if (err.message && err.message.includes("API key not valid")) {
                this.ws.send(JSON.stringify({ type: "error", message: "Gemini API key is invalid." }));
                await this.streamAudio("I'm sorry, but my Gemini A P I key is currently invalid. Please provide a working key.");
            } else {
                this.ws.send(JSON.stringify({ type: "error", message: "Failed to process text." }));
                await this.streamAudio("I'm sorry, I encountered a temporary error. Could you repeat that?");
            }
        }
    }

    async streamAudio(text) {
        if (!process.env.CARTESIA_API_KEY) {
            console.warn("No CARTESIA_API_KEY found, skipping TTS.");
            return;
        }

        console.log(`🔊 Streaming TTS for: "${text.substring(0, 30)}..."`);

        try {
            const ttsWebsocket = cartesia.tts.websocket({
                container: "raw",
                encoding: "pcm_s16le",
                sampleRate: 16000
            });

            const stream = await ttsWebsocket.send({
                model_id: "sonic-english",
                voice: {
                    mode: "id",
                    id: "a0e99841-438c-4a64-b679-ae501e7d6091", // Reverting to initial reliable voice id
                },
                transcript: text,
            });

            console.log("📡 TTS Stream started...");
            let chunksSent = 0;

            for await (const message of stream) {
                if (message && message.data) {
                    chunksSent++;
                    this.ws.send(JSON.stringify({
                        type: "audio_chunk",
                        audioData: message.data // base64 string
                    }));
                }
            }

            console.log(`✅ TTS Stream finished. Sent ${chunksSent} chunks.`);
            this.ws.send(JSON.stringify({ type: "audio_end" }));

        } catch (err) {
            console.error("Cartesia TTS Error:", err);
        }
    }
}

module.exports = ConversationManager;
