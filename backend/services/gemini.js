require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const { GoogleGenerativeAI } = require("@google/generative-ai");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

const REQUIRED_FIELDS = [
    "name", "email", "phone", "city", "college",
    "degree", "branch", "graduation_year", "cgpa", "skills"
];

const SYSTEM_PROMPT = `You are a helpful and polite voice assistant helping a user fill out a placement registration form over a live phone-style call.

Required fields: ${REQUIRED_FIELDS.join(", ")}

Instructions:
1. Examine the user's latest input and extract any matching field values.
2. Update the form state — do NOT overwrite already-filled fields unless the user explicitly corrects them. Keep existing values if the user's speech is unrelated to them.
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

/**
 * Pure Gemini Service to handle generating the next AI turn.
 * @param {Object} currentState - The current JSON state of the form
 * @param {Array<{role: string, content: string}>} history - Previous messages
 * @param {string} userInput - The latest text the user spoke
 * @returns {Promise<{newState: Object, replyText: string, isConfirmed: boolean}>}
 */
async function processSpeechText(currentState, history, userInput) {
    if (userInput) {
        history.push({ role: "user", content: userInput });
    }

    const stateContext = `Current form state:\n${JSON.stringify(currentState, null, 2)}`;
    const historyContext = `Conversation so far:\n${history.slice(-6).map(h => `${h.role}: ${h.content}`).join("\n")}`;
    const promptText = `${SYSTEM_PROMPT}\n\n${stateContext}\n\n${historyContext}`;

    try {
        const result = await model.generateContent(promptText);
        const rawContent = await result.response.text();

        const jsonStr = rawContent.replace(/```json?\n?/gi, "").replace(/```/gi, "").trim();
        const llmResponse = JSON.parse(jsonStr);

        // Merge state — keep existing values if LLM returns empty
        const merged = { ...currentState };
        for (const key of REQUIRED_FIELDS) {
            const newVal = llmResponse.updatedState[key];
            const isEmpty = !newVal || (Array.isArray(newVal) && newVal.length === 0) || String(newVal).trim() === "";
            if (!isEmpty) merged[key] = newVal;
        }

        if (llmResponse.replyText) {
            history.push({ role: "assistant", content: llmResponse.replyText });
        }

        return {
            newState: merged,
            replyText: llmResponse.replyText || "I'm sorry, I didn't quite catch that. Could you repeat?",
            isConfirmed: !!llmResponse.isConfirmed,
            history: history
        };

    } catch (err) {
        console.error("Gemini Service Error:", err.message || err);
        const errMsg = err.message && err.message.includes("API key not valid")
            ? "I am sorry, the Gemini API key appears to be invalid."
            : "I am sorry, I had a small hiccup. Could you please repeat that?";

        // Push the error as assistant reply so the conversation can recover
        history.push({ role: "assistant", content: errMsg });

        return {
            newState: currentState, // no changes
            replyText: errMsg,
            isConfirmed: false,
            history: history
        };
    }
}

function getInitialState() {
    return REQUIRED_FIELDS.reduce((acc, field) => {
        acc[field] = "";
        return acc;
    }, {});
}

function getOpeningGreeting() {
    return "Hello! Welcome to the placement registration assistant. " +
        "I will help you fill out your placement form using your voice. " +
        "Let's get started — could you please tell me your full name?";
}

module.exports = {
    processSpeechText,
    getInitialState,
    getOpeningGreeting
};
