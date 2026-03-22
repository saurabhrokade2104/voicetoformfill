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
    constructor(ws, mode = "browser") {
        this.ws = ws;
        this.mode = mode; // "browser" or "twilio"
        this.streamSid = null;
        this.language = "en-US";
        this.hasSelectedLanguage = false;
        this.dgConnection = null;
        this.dgClient = null;

        this.state = REQUIRED_FIELDS.reduce((acc, field) => {
            acc[field] = "";
            return acc;
        }, {});

        this.history = [];
        this.accumulatedText = "";
        this.llmTimeout = null;
    }

    setTwilioStream(streamSid) {
        this.streamSid = streamSid;
    }

    setDeepgram(dgConnection, dgClient) {
        this.dgConnection = dgConnection;
        this.dgClient = dgClient;
    }

    async handleUserSpeech(text) {
        if (!text || text.trim() === "") return;
        console.log(`📥 Received [${this.mode}] speech: ${text}`);

        // Language selection logic for Twilio
        if (this.mode === "twilio" && !this.hasSelectedLanguage) {
            const lowerText = text.toLowerCase();
            if (lowerText.includes("hindi") || lowerText.includes("hi")) {
                this.language = "hi-IN";
                this.hasSelectedLanguage = true;
                await this.streamAudio("नमस्ते! ठीक है, हम हिंदी में जारी रखेंगे। कृपया अपना पूरा नाम बताएं।");
                return;
            } else if (lowerText.includes("english") || lowerText.includes("hello")) {
                this.language = "en-US";
                this.hasSelectedLanguage = true;
                if (lowerText === "hello") {
                    await this.streamAudio("Hello! Which language would you prefer: English or Hindi?");
                    this.hasSelectedLanguage = false;
                    return;
                }
                await this.streamAudio("Perfect, let's continue in English. Please tell me your full name.");
                return;
            } else {
                await this.streamAudio("Welcome. Please say English or Hindi to continue.");
                return;
            }
        }

        this.accumulatedText += text + " ";
        if (this.llmTimeout) clearTimeout(this.llmTimeout);
        this.llmTimeout = setTimeout(() => this.processAccumulated(), 1200);
    }

    async processAccumulated() {
        const textToProcess = this.accumulatedText.trim();
        this.accumulatedText = "";
        if (!textToProcess) return;

        console.log(`🧠 [${this.mode}] Processing with Gemini:`, textToProcess);
        this.history.push({ role: "user", content: textToProcess });

        const systemPrompt = `You are a professional, realistic human voice assistant helping a user fill out a placement registration form.
The current language is ${this.language === "hi-IN" ? "Hindi" : "English"}. You MUST respond ONLY in this language.
Your goal is to be extremely helpful and natural over the phone.

Current Form (some fields may be filled):
${JSON.stringify(this.state, null, 2)}

STRICT RULES:
1. Extract any new info from the latest user input.
2. If most fields are filled, ask for the remaining ones.
3. ONCE ALL FIELDS ARE FILLED: Summarize EVERYTHING and ask: "I have all your details. Would you like to confirm and submit?"
4. IF THE USER SAYS YES/CONFIRM/SUBMIT to that final prompt, YOU MUST SET "isConfirmed" to true and say "Thank you! I have submitted your form. Goodbye!"

Response format (JSON only):
{
  "updatedState": { ... },
  "replyText": "Conversational reply as a human assistant.",
  "isConfirmed": boolean
}`;

        const promptText = `${systemPrompt}\n\nRecent History:\n${this.history.slice(-3).map(h => h.role + ": " + h.content).join("\n")}`;

        try {
            const result = await model.generateContent(promptText);
            const rawContent = await result.response.text();

            const jsonStr = rawContent.replace(/```json?\n?/gi, "").replace(/```/gi, "").trim();
            const llmResponse = JSON.parse(jsonStr);

            console.log("🤖 LLM Decision:", JSON.stringify(llmResponse, null, 2));

            // Update local state
            this.state = { ...this.state, ...llmResponse.updatedState };
            this.history.push({ role: "assistant", content: llmResponse.replyText });

            // 1. Send form update to frontend
            this.ws.send(JSON.stringify({
                type: "form_update",
                data: this.state,
                textReply: llmResponse.replyText,
                isConfirmed: llmResponse.isConfirmed === true
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

        try {
            const WebSocket = require("ws");
            const cartesiaWs = new WebSocket(`wss://api.cartesia.ai/tts/websocket?api_key=${process.env.CARTESIA_API_KEY}&cartesia_version=2024-06-10`);

            cartesiaWs.on("open", () => {
                const request = {
                    context_id: "ctx_" + Date.now(),
                    model_id: "sonic-english",
                    transcript: text,
                    voice: { mode: "id", id: "51475510-6bc3-48b7-a37a-e37456d2cf93" }, // High-quality, natural voice
                    output_format: { container: "raw", encoding: "pcm_s16le", sample_rate: 16000 }
                };
                cartesiaWs.send(JSON.stringify(request));
            });

            cartesiaWs.on("message", (data) => {
                try {
                    const msg = JSON.parse(data);
                    if (msg.data && (msg.type === "chunk" || !msg.type)) {
                        if (this.mode === "twilio") {
                            // TRANSCODE: 16kHz PCM -> 8kHz Mu-law
                            const { WaveFile } = require("wavefile");
                            const wav = new WaveFile();
                            const buffer = Buffer.from(msg.data, "base64");

                            // Load as 16-bit PCM, 16kHz, mono
                            wav.fromScratch(1, 16000, '16', new Int16Array(buffer.buffer, buffer.byteOffset, buffer.length / 2));

                            // Resample to 8kHz
                            wav.toSampleRate(8000);

                            // Convert to mu-law
                            wav.toMuLaw();

                            // Send to Twilio
                            this.ws.send(JSON.stringify({
                                event: "media",
                                streamSid: this.streamSid,
                                media: {
                                    payload: Buffer.from(wav.data.samples).toString("base64")
                                }
                            }));
                        } else {
                            // Browser mode
                            this.ws.send(JSON.stringify({
                                type: "audio_chunk",
                                audioData: msg.data
                            }));
                        }
                    } else if (msg.type === "done") {
                        if (this.mode === "browser") {
                            this.ws.send(JSON.stringify({ type: "audio_end" }));
                        }
                        cartesiaWs.close();
                    } else if (msg.type === "error") {
                        console.error("Cartesia API Error:", msg.error);
                        cartesiaWs.close();
                    }
                } catch (e) {
                    console.error("Cartesia parse error", e);
                }
            });

            cartesiaWs.on("error", (err) => {
                console.error("Cartesia WS Error:", err);
            });

        } catch (err) {
            console.error("Cartesia TTS Error:", err);
        }
    }
}

module.exports = ConversationManager;
