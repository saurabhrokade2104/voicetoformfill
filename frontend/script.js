/* ─────────────────────────────────────────────────────────────────────────────
   Voice-to-Voice Form Filler — script.js
   FLOW:
     1. User clicks "Start Voice Assistant"
     2. WebSocket connects to /live
     3. Backend sends {type: "speak", text: "..."}
     4. Frontend speaks using browser SpeechSynthesis API -> mic is MUTED
     5. Frontend finishes speaking -> sends {type: "speak_done"} to backend
     6. Backend sends ready_for_input -> mic is UNMUTED, STT starts
     7. Browser STT with interimResults + 1.5 s silence timer = natural pauses
     8. Final/pause transcript sent to backend -> LLM -> loop repeats
───────────────────────────────────────────────────────────────────────────── */

const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
const WS_URL = `${wsProtocol}//${window.location.host}/live`;

// ─── State ────────────────────────────────────────────────────────────────────
let recognition = null;
let isCallActive = false;
let micEnabled = false;        // true only when AI is NOT speaking
let currentLang = "en-IN";
let ws = null;
let silenceTimer = null;       // pause-detection timer
let interimBuffer = "";        // accumulates interim STT results

const PAUSE_TIMEOUT_MS = 1500;  // 1.5 s of silence → send accumulated text

const FIELD_IDS = [
    "name", "email", "phone", "city",
    "college", "degree", "branch", "graduation_year", "cgpa", "skills"
];

// ─── Browser Speech Synthesis (TTS) ───────────────────────────────────────────

function speakText(text) {
    if (!text) return;

    // Cancel any ongoing speech
    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);

    // Try to find a good English voice
    const voices = window.speechSynthesis.getVoices();
    const preferredVoice = voices.find(v => v.lang.includes("en-US") || v.lang.includes("en-GB") || v.lang.includes("en-IN"));
    if (preferredVoice) {
        utterance.voice = preferredVoice;
    }

    utterance.rate = 1.0;
    utterance.pitch = 1.0;

    utterance.onstart = () => {
        setAvatarSpeaking(true);
    };

    utterance.onend = () => {
        setAvatarSpeaking(false);
        // Tell backend we finished speaking so it can unmute us
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "speak_done" }));
        }
    };

    utterance.onerror = (e) => {
        console.error("SpeechSynthesis error:", e);
        setAvatarSpeaking(false);
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "speak_done" })); // fallback
        }
    };

    window.speechSynthesis.speak(utterance);
}

function stopAudio() {
    window.speechSynthesis.cancel();
}

// ─── Call Lifecycle ───────────────────────────────────────────────────────────

function handleMicClick() {
    isCallActive ? endCall() : startCall();
}

function startCall() {
    isCallActive = true;
    micEnabled = false;
    hideMissing(); hideTranscript();
    setStatus("processing", "Connecting to voice agent…");
    document.getElementById("micBtn").classList.add("recording");
    document.getElementById("micLabel").textContent = "End Call";
    showLoader(true);

    // Ensure voices are loaded (Chrome quirk)
    window.speechSynthesis.getVoices();

    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
        setStatus("processing", "AI is preparing your greeting…");
        showLoader(false);
        addChatBubble("system", "🔗 Connected. Wait for the AI to greet you…");
    };

    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);

            if (data.type === "speak") {
                // Backend wants us to speak this text natively
                speakText(data.text);

            } else if (data.type === "speaking_state") {
                if (data.isSpeaking) {
                    // AI is speaking — mute mic immediately
                    micEnabled = false;
                    pauseMicRecognition();
                    setStatus("processing", "AI Speaking…");
                    document.getElementById("aiAvatar").classList.add("speaking");
                    document.getElementById("aiAvatar").classList.remove("listening");
                } else {
                    document.getElementById("aiAvatar").classList.remove("speaking");
                }

            } else if (data.type === "ready_for_input") {
                // AI finished speaking — unmute mic
                micEnabled = true;
                setAvatarSpeaking(false);
                setStatus("listening", "Your turn — speak now…");
                document.getElementById("aiAvatar").classList.add("listening");
                resumeMicRecognition();

            } else if (data.type === "form_update") {
                fillForm(data.data);
                updateProgress();
                if (data.isConfirmed) {
                    handleFinalConfirm();
                } else if (data.textReply) {
                    addChatBubble("ai", data.textReply);
                }

            } else if (data.type === "error") {
                addChatBubble("system", "⚠️ " + data.message);
            }
        } catch (e) {
            console.error("WS parse error:", e);
        }
    };

    ws.onclose = () => endCall();
    ws.onerror = () => { setStatus("idle", "Connection error. Retry."); endCall(); };
}

function endCall() {
    isCallActive = false;
    micEnabled = false;
    clearSilenceTimer();
    if (recognition) { try { recognition.stop(); } catch (e) { } recognition = null; }
    if (ws) { ws.close(); ws = null; }
    stopAudio();
    document.getElementById("micBtn").classList.remove("recording");
    document.getElementById("micLabel").textContent = "Start Voice Assistant";
    document.getElementById("aiAvatar").classList.remove("listening", "speaking");
    setStatus("idle", "Live call ended. Click to restart.");
    showLoader(false);
}

// ─── Speech Recognition with Pause Detection ─────────────────────────────────

function initRecognition() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
        alert("Web Speech API not supported.\nPlease use Google Chrome or Microsoft Edge.");
        return null;
    }
    const r = new SR();
    r.continuous = true;
    r.interimResults = true;   // ← key: get partial results for pause detection
    r.lang = currentLang;
    r.maxAlternatives = 1;

    r.onresult = (e) => {
        if (!micEnabled) return; // drop results while AI is talking

        let interimText = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
            const t = e.results[i][0].transcript;
            if (e.results[i].isFinal) {
                // Final result: clear interim, send immediately
                clearSilenceTimer();
                interimBuffer = "";
                const finalText = t.trim();
                if (finalText) sendUserSpeech(finalText);
            } else {
                interimText += t;
            }
        }

        if (interimText) {
            // Update interim display
            interimBuffer = interimText;
            showInterim(interimText);
            // Reset pause timer each time new speech arrives
            resetSilenceTimer();
        }
    };

    r.onerror = (e) => {
        if (e.error === "no-speech") return;
        if (e.error === "aborted") return;   // triggered by our own stop() — normal
        console.error("STT error:", e.error);
    };

    r.onend = () => {
        // Auto-restart if call is still active AND mic is enabled
        if (isCallActive && micEnabled) {
            try { r.start(); } catch (e) { }
        }
    };

    return r;
}

function resumeMicRecognition() {
    if (!recognition) {
        recognition = initRecognition();
    }
    if (recognition && micEnabled) {
        try { recognition.start(); } catch (e) { /* already running */ }
    }
}

function pauseMicRecognition() {
    clearSilenceTimer();
    // Flush any interim text before muting
    if (interimBuffer.trim()) {
        sendUserSpeech(interimBuffer.trim());
        interimBuffer = "";
    }
    if (recognition) {
        try { recognition.stop(); } catch (e) { }
    }
    hideInterim();
}

function resetSilenceTimer() {
    clearSilenceTimer();
    silenceTimer = setTimeout(() => {
        // Pause detected — send accumulated interim text
        const text = interimBuffer.trim();
        interimBuffer = "";
        hideInterim();
        if (text && micEnabled) {
            sendUserSpeech(text);
        }
    }, PAUSE_TIMEOUT_MS);
}

function clearSilenceTimer() {
    if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
}

function sendUserSpeech(text) {
    if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
    addChatBubble("user", text);
    setStatus("processing", "AI Thinking…");
    ws.send(JSON.stringify({ type: "text", text }));
}

// ─── UI Helpers ───────────────────────────────────────────────────────────────

function setAvatarSpeaking(val) {
    const av = document.getElementById("aiAvatar");
    if (!av) return;
    val ? av.classList.add("speaking") : av.classList.remove("speaking");
}

function addChatBubble(role, text) {
    const wrap = document.getElementById("chatLog");
    if (!wrap) { showTranscript(text); return; }
    const div = document.createElement("div");
    div.className = `chat-bubble chat-${role}`;
    div.textContent = text;
    wrap.appendChild(div);
    wrap.scrollTop = wrap.scrollHeight;
}

function showInterim(text) {
    let el = document.getElementById("interimDisplay");
    if (!el) return;
    el.textContent = text;
    el.style.display = "block";
}

function hideInterim() {
    const el = document.getElementById("interimDisplay");
    if (el) { el.textContent = ""; el.style.display = "none"; }
}

function fillForm(data) {
    if (!data) return;
    FIELD_IDS.forEach((fieldId) => {
        const input = document.getElementById(fieldId);
        const indEl = document.getElementById(`ind-${fieldId}`);
        if (!input) return;
        let value = data[fieldId];
        if (Array.isArray(value)) value = value.join(", ");
        if (value && String(value).trim() !== "") {
            if (input.value !== String(value).trim()) {
                input.value = String(value).trim();
                input.classList.add("filled", "voice-filled");
                if (indEl) indEl.classList.add("filled");
                input.addEventListener("animationend", () => input.classList.remove("voice-filled"), { once: true });
            }
        }
    });
}

function handleFinalConfirm() {
    endCall();
    document.getElementById("modalOverlay").style.display = "flex";
}

function setLanguage(lang) {
    currentLang = lang;
    document.getElementById("btnEn").classList.toggle("active", lang === "en-IN");
    document.getElementById("btnHi").classList.toggle("active", lang === "hi-IN");
    setStatus("idle", `Language: ${lang === "hi-IN" ? "Hindi" : "English"}`);
    // Restart recognition with new language if active
    if (recognition) {
        try { recognition.stop(); } catch (e) { }
        recognition = null;
    }
}

function updateProgress() {
    const total = FIELD_IDS.length;
    const filled = FIELD_IDS.filter((id) => {
        const el = document.getElementById(id);
        return el && el.value && el.value.trim() !== "";
    }).length;
    const pct = Math.round((filled / total) * 100);
    document.getElementById("progressFill").style.width = `${pct}%`;
    document.getElementById("progressLabel").textContent = `${filled} / ${total} fields filled`;
}

function resetAll() {
    endCall();
    FIELD_IDS.forEach((id) => {
        const input = document.getElementById(id);
        const ind = document.getElementById(`ind-${id}`);
        if (input) { input.value = ""; input.classList.remove("filled", "voice-filled"); }
        if (ind) ind.classList.remove("filled");
    });
    const chatLog = document.getElementById("chatLog");
    if (chatLog) chatLog.innerHTML = "";
    setStatus("idle", "Click to start Live Agent");
    hideMissing(); hideTranscript();
    showLoader(false);
    updateProgress();
}

function setStatus(type, text) {
    const icon = document.getElementById("statusIcon");
    const txt = document.getElementById("statusText");
    icon.className = `status-icon ${type}`;
    const icons = {
        idle: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M12 15c1.66 0 3-1.34 3-3V6c0-1.66-1.34-3-3-3S9 4.34 9 6v6c0 1.66 1.34 3 3 3z" fill="currentColor"/><path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" fill="currentColor"/></svg>`,
        listening: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="8" fill="currentColor" opacity="0.3"/><circle cx="12" cy="12" r="4" fill="currentColor"/></svg>`,
        processing: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
        done: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M9 12l2 2 4-4M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    };
    icon.innerHTML = icons[type] || icons.idle;
    txt.textContent = text;
}

function showTranscript(text) {
    document.getElementById("transcriptText").textContent = text;
    document.getElementById("transcriptWrap").style.display = "block";
}
function hideTranscript() {
    const w = document.getElementById("transcriptWrap");
    if (w) { w.style.display = "none"; const t = document.getElementById("transcriptText"); if (t) t.textContent = ""; }
}
function showLoader(show) {
    document.getElementById("loaderWrap").style.display = show ? "block" : "none";
}
function showMissing(text) {
    document.getElementById("missingText").textContent = text;
    document.getElementById("missingWrap").style.display = "block";
}
function hideMissing() {
    document.getElementById("missingWrap").style.display = "none";
}
function closeModal() {
    document.getElementById("modalOverlay").style.display = "none";
}

document.getElementById("placementForm").addEventListener("submit", (e) => {
    e.preventDefault();
    handleFinalConfirm();
});

window.addEventListener("load", () => {
    updateProgress();
    setTimeout(() => setStatus("idle", "Click to start Live Agent"), 500);
});
