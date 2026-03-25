/* ─────────────────────────────────────────────────────────────────────────────
   Voice Conversational Form Filler — script.js (Phase 1: WebSocket Real-Time)
   FLOW:
     1. User clicks "Start Voice Assistant".
     2. Connects to backend WebSocket `/live`.
     3. Backend natively says Hello via TTS.
     4. Browser STT listens continuously & sends mapped text to Backend WS.
     5. Backend LLM checks state & Cartesia streams back audio chunks.
     6. Frontend plays chunks natively via AudioContext.
     7. Form visually updates instantly via WS events.
───────────────────────────────────────────────────────────────────────────── */

const WS_URL = `ws://${window.location.host}/live`;

// ─── State ────────────────────────────────────────────────────────────────────
let recognition = null;
let isCallActive = false;
let currentLang = "en-IN";
let ws = null;

// Audio context for playing Cartesia streaming audio
let audioCtx = null;
let nextPlayTime = 0;

const FIELD_IDS = [
    "name", "email", "phone", "city",
    "college", "degree", "branch", "graduation_year", "cgpa", "skills"
];

// ─── Audio Playback via AudioContext ─────────────────────────────────────────

function initAudioContext() {
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    }
    if (audioCtx.state === 'suspended') {
        audioCtx.resume();
    }
}

function playAudioChunk(base64Str) {
    if (!audioCtx) return;

    try {
        const binaryString = window.atob(base64Str);
        const len = binaryString.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }

        // Ensure we only process even number of bytes for Int16
        const alignedLength = len - (len % 2);
        const int16 = new Int16Array(bytes.buffer, 0, alignedLength / 2);
        const float32 = new Float32Array(int16.length);

        for (let i = 0; i < int16.length; i++) {
            float32[i] = int16[i] / 32768.0;
        }

        const buffer = audioCtx.createBuffer(1, float32.length, 16000);
        buffer.getChannelData(0).set(float32);

        const source = audioCtx.createBufferSource();
        source.buffer = buffer;
        source.connect(audioCtx.destination);

        const currentTime = audioCtx.currentTime;
        if (nextPlayTime < currentTime) {
            nextPlayTime = currentTime + 0.1; // 100ms buffer to handle network jitter
        }

        source.start(nextPlayTime);
        nextPlayTime += buffer.duration;

        // Visual feedback
        document.getElementById("aiAvatar").classList.add("speaking");
        source.onended = () => {
            // Only remove if this was the last chunk
            if (audioCtx && audioCtx.currentTime >= nextPlayTime - 0.1) {
                document.getElementById("aiAvatar").classList.remove("speaking");
            }
        };

    } catch (e) {
        console.error("Audio playback error:", e);
    }
}

function stopAudio() {
    if (audioCtx) {
        audioCtx.close();
        audioCtx = null;
    }
    nextPlayTime = 0;
}


// ─── Live Connection Management ──────────────────────────────────────────────

function handleMicClick() {
    if (isCallActive) {
        endCall();
    } else {
        startCall();
    }
}

function startCall() {
    initAudioContext();
    isCallActive = true;
    hideMissing();
    hideTranscript();
    setStatus("processing", "Connecting to live voice agent...");
    document.getElementById("micBtn").classList.add("recording");
    document.getElementById("micLabel").textContent = "End Call";
    showLoader(true);

    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
        setStatus("listening", "Call Connected. Listening...");
        showLoader(false);
        document.getElementById("aiAvatar").classList.add("listening");
        startListening(); // Start browser STT
    };

    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            if (data.type === "form_update") {
                fillForm(data.data);
                updateProgress();
                if (data.isConfirmed) {
                    handleFinalConfirm();
                } else if (data.textReply) {
                    showTranscript("Agent: " + data.textReply);
                }
            } else if (data.type === "audio_chunk" && data.audioData) {
                playAudioChunk(data.audioData);
            } else if (data.type === "audio_end") {
                // Done playing current turn
            }
        } catch (e) {
            console.error("WS error:", e);
        }
    };

    ws.onclose = () => {
        endCall();
    };

    ws.onerror = () => {
        setStatus("idle", "Connection error. Retry.");
        endCall();
    };
}

function endCall() {
    isCallActive = false;
    if (ws) {
        ws.close();
        ws = null;
    }

    if (recognition) {
        try { recognition.stop(); } catch (e) { }
    }

    stopAudio();

    document.getElementById("micBtn").classList.remove("recording");
    document.getElementById("micLabel").textContent = "Start Voice Assistant";
    document.getElementById("aiAvatar").classList.remove("listening");
    setStatus("idle", "Live call ended. Click to restart.");
    showLoader(false);
}

// ─── Step 2: Listen for user's speech ────────────────────────────────────────
function startListening() {
    recognition = initRecognition();
    if (!recognition) return;
    try { recognition.start(); } catch (e) { console.error("Recognition start error:", e); }
}

function initRecognition() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
        alert("Web Speech API not supported.\nPlease use Google Chrome or Microsoft Edge.");
        return null;
    }
    const r = new SR();
    // Continuous listening to mimic real-time call
    r.continuous = true;
    r.interimResults = false; // Only send final text segments to LLM
    r.lang = currentLang;
    r.maxAlternatives = 1;

    r.onresult = (e) => {
        // Find the newly finalized text
        for (let i = e.resultIndex; i < e.results.length; ++i) {
            if (e.results[i].isFinal) {
                const transcript = e.results[i][0].transcript.trim();
                showTranscript("You: " + transcript);

                // Stop any audio playing if user interrupts
                if (audioCtx && audioCtx.state === 'running') {
                    // Primitive interruption logic: skip queued audio
                    // nextPlayTime = audioCtx.currentTime; 
                }

                // Send to backend via WS
                if (ws && ws.readyState === WebSocket.OPEN && transcript.length > 0) {
                    ws.send(JSON.stringify({ type: "text", text: transcript }));
                    setStatus("processing", "AI Thinking...");
                    setTimeout(() => setStatus("listening", "Call Active. Listening..."), 1500);
                }
            }
        }
    };

    r.onerror = (e) => {
        // Ignore simple no-speech errors in continuous mode
        if (e.error === 'no-speech') return;
        console.error("Speech recognition error:", e.error);
    };

    r.onend = () => {
        // Auto-restart if we are still in call
        if (isCallActive) {
            try { r.start(); } catch (e) { }
        }
    };

    return r;
}

// ─── UI Helpers ───────────────────────────────────────────────────────────

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
    hideReviewPrompt();
}

function showReviewPrompt() {
    const wrap = document.getElementById("reviewWrap");
    if (wrap) wrap.style.display = "block";
}
function hideReviewPrompt() {
    const wrap = document.getElementById("reviewWrap");
    if (wrap) wrap.style.display = "none";
}

function setLanguage(lang) {
    currentLang = lang;
    document.getElementById("btnEn").classList.toggle("active", lang === "en-IN");
    document.getElementById("btnHi").classList.toggle("active", lang === "hi-IN");
    setStatus("idle", `Language set to ${lang === "hi-IN" ? "Hindi" : "English"}`);
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

    setStatus("idle", "Click to start Live Agent");
    hideTranscript();
    hideMissing();
    hideReviewPrompt();
    showLoader(false);
    updateProgress();
}

document.getElementById("placementForm").addEventListener("submit", (e) => {
    e.preventDefault();
    handleFinalConfirm();
});

function closeModal() {
    document.getElementById("modalOverlay").style.display = "none";
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
    document.getElementById("transcriptWrap").style.display = "none";
    document.getElementById("transcriptText").textContent = "";
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

window.addEventListener("load", () => {
    updateProgress();
    setTimeout(() => {
        setStatus("idle", "Click to start Live Agent");
    }, 500);
});
