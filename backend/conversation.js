const { processSpeechText, getInitialState, getOpeningGreeting } = require("./services/gemini");

class ConversationManager {
    constructor(ws) {
        this.ws = ws;
        this.state = getInitialState();
        this.history = [];
        this.accumulatedText = "";
        this.llmTimeout = null;
        this.isSpeaking = false;
    }

    // ── Called once on new connection: AI speaks first ────────────────────────
    async startConversation() {
        const openingQuestion = getOpeningGreeting();
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

        try {
            // Process the user speech via the unified Gemini Service
            const { newState, replyText, isConfirmed, history: updatedHistory } = await processSpeechText(
                this.state,
                this.history,
                textToProcess
            );

            // Update internal state
            this.state = newState;
            this.history = updatedHistory;

            // Send form update + speak reply
            this.ws.send(JSON.stringify({
                type: "form_update",
                data: this.state,
                textReply: replyText,
                isConfirmed: isConfirmed
            }));

            if (replyText) {
                this.speak(replyText);
            }

        } catch (err) {
            console.error("WS Manager Error:", err.message || err);
            const errMsg = "I am sorry, I encountered an error processing your speech.";
            this.ws.send(JSON.stringify({ type: "error", message: errMsg }));
            this.speak(errMsg);
        }
    }
}

module.exports = ConversationManager;
