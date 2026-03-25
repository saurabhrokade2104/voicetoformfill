const express = require("express");
const router = express.Router();
const sessionService = require("../services/session");
const { processSpeechText, getOpeningGreeting } = require("../services/gemini");

// Helper to generate TwiML response
function generateTwiML(sayText, gatherPath = '/twilio/process-speech') {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Gather input="speech" action="${gatherPath}" speechTimeout="1.2">
        <Say>${sayText}</Say>
    </Gather>
</Response>`;
}

// ─── Call Initiation (Hit when user calls the Twilio number) ──────────────
router.post("/voice", async (req, res) => {
    const callSid = req.body.CallSid;
    console.log(`[Twilio] New Call Started! SID: ${callSid}`);

    // Create new session for this caller
    sessionService.clearSession(callSid); // fresh start
    const callSession = sessionService.getSession(callSid);

    const greeting = getOpeningGreeting();
    callSession.history.push({ role: "assistant", content: greeting });

    res.type("text/xml");
    res.send(generateTwiML(greeting));
});

// ─── Process Speech (Hit when user finishes speaking) ─────────────────────
router.post("/process-speech", async (req, res) => {
    const callSid = req.body.CallSid;
    const speechResult = req.body.SpeechResult || "";

    console.log(`[Twilio] Received speech: "${speechResult}" from SID: ${callSid}`);

    const callSession = sessionService.getSession(callSid);

    res.type("text/xml");

    // If no speech detected, prompt them again
    if (!speechResult.trim()) {
        const lastAssistantMsg = callSession.history.filter(h => h.role === "assistant").pop();
        const reprompt = lastAssistantMsg ? lastAssistantMsg.content : "I didn't hear anything. Hello?";
        return res.send(generateTwiML(reprompt));
    }

    // Process with Gemini LLM
    try {
        const { newState, replyText, isConfirmed, history } = await processSpeechText(
            callSession.state,
            callSession.history,
            speechResult
        );

        // Update session
        sessionService.updateSession(callSid, newState, history, isConfirmed);

        if (isConfirmed) {
            console.log(`[Twilio] Form Completed for SID: ${callSid}`);
            return res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say>Form submitted successfully. Thank you and goodbye!</Say><Hangup/></Response>`);
        }

        // Send next question back to caller
        res.send(generateTwiML(replyText));

    } catch (err) {
        console.error("[Twilio] Error processing speech:", err);
        res.send(generateTwiML("I encountered an error. Let's try that again."));
    }
});

// ─── Call Status Callbacks ────────────────────────────────────────────────
router.post("/status", (req, res) => {
    const { CallSid, CallStatus } = req.body;
    console.log(`[Twilio] Call ${CallSid} status changed to: ${CallStatus}`);

    if (CallStatus === "completed" || CallStatus === "failed" || CallStatus === "busy" || CallStatus === "no-answer" || CallStatus === "canceled") {
        sessionService.clearSession(CallSid);
        console.log(`[Twilio] Cleared session for SID: ${CallSid}`);
    }

    res.sendStatus(200);
});

module.exports = router;
