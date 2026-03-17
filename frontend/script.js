/* ─────────────────────────────────────────────────────────────────────────────
   Voice Conversational Form Filler — script.js
   FLOW:
     1. User clicks mic
     2. System ASKS for details via speech synthesis
     3. After speaking, system starts LISTENING for user's reply
     4. Speech → Backend /extract → OpenAI → JSON → form filled
     5. System READS BACK the details it filled
     6. System asks user to review and submit
     7. User clicks Submit → success modal
───────────────────────────────────────────────────────────────────────────── */

const BACKEND_URL = "/api";

// ─── State ────────────────────────────────────────────────────────────────────
let recognition = null;
let isListening = false;
let currentLang = "en-IN";
let synth = window.speechSynthesis;
let voices = [];
let flowStarted = false;

// All form field IDs
const FIELD_IDS = [
    "name", "email", "phone", "city",
    "college", "degree", "branch", "graduation_year", "cgpa", "skills"
];

// ─── Load voices (some browsers load asynchronously) ─────────────────────────
function loadVoices() {
    voices = synth.getVoices();
}
loadVoices();
if (speechSynthesis.onvoiceschanged !== undefined) {
    speechSynthesis.onvoiceschanged = loadVoices;
}

// ─── Speech Synthesis helper ─────────────────────────────────────────────────
function speak(text, onDone) {
    synth.cancel();
    const utt = new SpeechSynthesisUtterance(text);
    utt.lang = currentLang === "hi-IN" ? "hi-IN" : "en-IN";
    utt.rate = 0.92;
    utt.pitch = 1;
    utt.volume = 1;

    // Prefer a natural English/Hindi voice if available
    const preferred = voices.find(v =>
        v.lang === utt.lang && v.name.toLowerCase().includes("female")
    ) || voices.find(v => v.lang === utt.lang) || null;
    if (preferred) utt.voice = preferred;

    if (typeof onDone === "function") utt.onend = onDone;
    synth.speak(utt);
}

// ─── Step 1: Start the full voice flow ───────────────────────────────────────
function handleMicClick() {
    if (isListening) {
        stopRecording();
        return;
    }

    if (!flowStarted) {
        startConversationalFlow();
    } else {
        startListening();
    }
}

function startConversationalFlow() {
    flowStarted = true;
    hideMissing();
    hideTranscript();
    setStatus("processing", "Preparing to ask you for details…");

    const question =
        currentLang === "hi-IN"
            ? "नमस्ते! कृपया मुझे अपना नाम, ईमेल पता, फोन नंबर, शहर, कॉलेज, डिग्री, ब्रांच, स्नातक वर्ष, सी जी पी ए और कौशल बताएं।"
            : "Hello! Please tell me your full name, email address, phone number, city, college name, degree, branch, graduation year, CGPA, and your key skills. Go ahead and speak after the beep.";

    setStatus("processing", "Speaking — listen for the question…");
    playBeepAndAsk(question);
}

function playBeepAndAsk(question) {
    // Visual cue that system is about to ask
    document.getElementById("aiAvatar").classList.add("listening");
    speak(question, () => {
        // After system finishes asking → start listening
        document.getElementById("aiAvatar").classList.remove("listening");
        playBeep();
        setTimeout(() => startListening(), 300);
    });
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
    r.continuous = false;
    r.interimResults = false;
    r.lang = currentLang;
    r.maxAlternatives = 1;

    r.onstart = () => {
        isListening = true;
        setStatus("listening", "Listening… speak now 🎤");
        document.getElementById("micBtn").classList.add("recording");
        document.getElementById("micLabel").textContent = "Stop Recording";
        document.getElementById("aiAvatar").classList.add("listening");
        hideMissing();
    };

    r.onresult = (e) => {
        const transcript = e.results[0][0].transcript;
        showTranscript(transcript);
        processTranscript(transcript);
    };

    r.onerror = (e) => {
        console.error("Speech recognition error:", e.error);
        const msgs = {
            "no-speech": "No speech detected. Click the mic and try again.",
            "audio-capture": "Microphone not found. Check your device.",
            "not-allowed": "Microphone access denied. Please allow mic access.",
            "network": "Network error. Please try again.",
        };
        setStatus("idle", msgs[e.error] || `Error: ${e.error}. Please retry.`);
        stopRecording();
        flowStarted = false;
    };

    r.onend = () => { if (isListening) stopRecording(); };

    return r;
}

function stopRecording() {
    isListening = false;
    if (recognition) { try { recognition.stop(); } catch (_) { } }
    document.getElementById("micBtn").classList.remove("recording");
    document.getElementById("micLabel").textContent = "Start Voice Assistant";
    document.getElementById("aiAvatar").classList.remove("listening");
}

// ─── Step 3: Send to Backend → OpenAI → Get JSON ─────────────────────────────
async function processTranscript(text) {
    setStatus("processing", "Analysing with AI…");
    showLoader(true);

    try {
        const response = await fetch(`${BACKEND_URL}/extract`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ speech_text: text, fields: FIELD_IDS }),
        });

        const result = await response.json().catch(() => ({}));

        if (!response.ok) {
            const errorMsg = result.details ? `${result.error} (${result.details})` : (result.error || `HTTP ${response.status}`);
            throw new Error(errorMsg);
        }

        if (result.success && result.data) {
            fillForm(result.data);
            updateProgress();
            const missing = getMissingFields(result.data);
            if (missing.length > 0) {
                handleMissingFields(missing);
            } else {
                readBackDetails(result.data);
            }
        } else {
            throw new Error("Invalid response from server.");
        }
    } catch (err) {
        console.error("Extract error:", err);
        setStatus("idle", `❌ ${err.message}`);
        flowStarted = false;
    } finally {
        showLoader(false);
    }
}

// ─── Step 4a: Fill DOM form fields ───────────────────────────────────────────
function fillForm(data) {
    FIELD_IDS.forEach((fieldId) => {
        if (!(fieldId in data)) return;
        const input = document.getElementById(fieldId);
        const indEl = document.getElementById(`ind-${fieldId}`);
        if (!input) return;

        let value = data[fieldId];
        if (Array.isArray(value)) value = value.join(", ");

        if (value && String(value).trim() !== "") {
            input.value = String(value).trim();
            input.classList.add("filled", "voice-filled");
            if (indEl) indEl.classList.add("filled");
            input.addEventListener("animationend", () => input.classList.remove("voice-filled"), { once: true });
        }
    });
}

// ─── Step 4b: Read back filled details ───────────────────────────────────────
function readBackDetails(data) {
    setStatus("done", "Details filled! Reviewing with you…");

    const parts = [];
    const labelMap = {
        name: "Name", email: "Email", phone: "Phone",
        city: "City", college: "College", degree: "Degree",
        branch: "Branch", graduation_year: "Graduation Year",
        cgpa: "CGPA", skills: "Skills"
    };

    // Only read back fields that were actually filled
    FIELD_IDS.forEach((id) => {
        const inputEl = document.getElementById(id);
        const val = (inputEl && inputEl.value) || (data && data[id]);
        if (val && String(val).trim() !== "") {
            const displayVal = Array.isArray(val) ? val.join(", ") : String(val).trim();
            parts.push(`${labelMap[id]}: ${displayVal}`);
        }
    });

    const summary = parts.length > 0
        ? `I have filled in the following details. ${parts.join(". ")}. Please review the form and click Submit Application if everything looks correct. Or click Reset to start over.`
        : "I could not extract any details. Please click the microphone and try again.";

    speak(summary);

    // Show review prompt in UI
    showReviewPrompt();
}

// ─── Step 4c: Handle missing fields ──────────────────────────────────────────
function getMissingFields(data) {
    return FIELD_IDS.filter((id) => {
        const inputEl = document.getElementById(id);
        const val = (inputEl && inputEl.value) || (data && data[id]);
        return !val || (Array.isArray(val) ? val.length === 0 : String(val).trim() === "");
    });
}

function handleMissingFields(missingIds) {
    const labels = missingIds.map(fieldLabel).join(", ");
    const msg = `Some fields are missing: ${labels}. Please say those details again.`;
    const speech = `I did not hear your ${missingIds.slice(0, 3).map(fieldLabel).join(" and ")}. Please say ${missingIds.length === 1 ? "it" : "them"} again.`;

    showMissing(msg);
    setStatus("idle", `Missing: ${labels}`);
    flowStarted = false;   // allow re-trigger on next mic click

    speak(speech);
}

function fieldLabel(id) {
    const labels = {
        name: "Full Name", email: "Email", phone: "Phone Number",
        city: "City", college: "College", degree: "Degree",
        branch: "Branch", graduation_year: "Graduation Year",
        cgpa: "CGPA", skills: "Skills"
    };
    return labels[id] || id;
}

// ─── Review prompt UI ─────────────────────────────────────────────────────────
function showReviewPrompt() {
    const wrap = document.getElementById("reviewWrap");
    if (wrap) wrap.style.display = "block";
}
function hideReviewPrompt() {
    const wrap = document.getElementById("reviewWrap");
    if (wrap) wrap.style.display = "none";
}

// ─── Language toggle ──────────────────────────────────────────────────────────
function setLanguage(lang) {
    currentLang = lang;
    document.getElementById("btnEn").classList.toggle("active", lang === "en-IN");
    document.getElementById("btnHi").classList.toggle("active", lang === "hi-IN");
    setStatus("idle", `Language set to ${lang === "hi-IN" ? "Hindi" : "English"}`);
    speak(lang === "hi-IN" ? "हिंदी भाषा चुनी गई है।" : "English language selected.");
}

// ─── Progress bar ─────────────────────────────────────────────────────────────
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

// ─── Reset ────────────────────────────────────────────────────────────────────
function resetAll() {
    stopRecording();
    synth.cancel();
    flowStarted = false;

    FIELD_IDS.forEach((id) => {
        const input = document.getElementById(id);
        const ind = document.getElementById(`ind-${id}`);
        if (input) { input.value = ""; input.classList.remove("filled", "voice-filled"); }
        if (ind) ind.classList.remove("filled");
    });

    setStatus("idle", "Click the mic to start");
    hideTranscript();
    hideMissing();
    hideReviewPrompt();
    showLoader(false);
    updateProgress();
    document.getElementById("micBtn").classList.remove("recording");
    document.getElementById("micLabel").textContent = "Start Voice Assistant";
    document.getElementById("aiAvatar").classList.remove("listening");
}

// ─── Beep sound ───────────────────────────────────────────────────────────────
function playBeep() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.frequency.value = 880;
        gain.gain.setValueAtTime(0.3, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.25);
    } catch (_) { }
}

// ─── Form submit ──────────────────────────────────────────────────────────────
document.getElementById("placementForm").addEventListener("submit", (e) => {
    e.preventDefault();
    synth.cancel();

    // Show success modal
    document.getElementById("modalOverlay").style.display = "flex";

    // Speak success
    setTimeout(() => {
        speak("Congratulations! Your placement application has been submitted successfully. We wish you all the best!");
    }, 400);

    hideReviewPrompt();
});

function closeModal() {
    document.getElementById("modalOverlay").style.display = "none";
}

// ─── UI helpers ───────────────────────────────────────────────────────────────
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

// ─── Init ─────────────────────────────────────────────────────────────────────
window.addEventListener("load", () => {
    updateProgress();
    setTimeout(() => {
        setStatus("idle", "Click the mic to start");
    }, 500);
});
