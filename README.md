# Voice Conversational Form Filler 🎤

An AI-powered web app that lets you fill placement registration forms using just your **voice**.

## Tech Stack

| Layer | Tech |
|---|---|
| Frontend | HTML + CSS + Vanilla JS |
| Speech Recognition | Web Speech API (browser built-in) |
| Speech Synthesis | Speech Synthesis API (browser built-in) |
| Backend | Node.js + Express |
| LLM | OpenAI GPT-4o-mini |

---

## Project Structure

```
speechtoform/
├── backend/
│   ├── server.js       ← Express API server
│   ├── package.json
│   └── .env            ← OpenAI API key
└── frontend/
    ├── index.html      ← Placement form + AI panel
    ├── style.css       ← Premium dark UI
    └── script.js       ← Voice pipeline logic
```

---

## How to Run Locally

### Step 1 — Install dependencies

```bash
cd backend
npm install
```

### Step 2 — Start the backend server

```bash
npm start
```

You should see:
```
🚀 Voice Form AI Server running at http://localhost:3000
```

### Step 3 — Open the frontend

Open the file directly in Chrome or Edge:

```
frontend/index.html
```

Or use the VS Code Live Server extension.

> ⚠️ **Important:** Use **Google Chrome** or **Microsoft Edge** — the Web Speech API is not supported in Firefox or Safari.

---

## How to Use

1. Open `frontend/index.html` in Chrome
2. Allow microphone access when prompted
3. Click **"Start Voice Assistant"** button
4. Speak naturally, for example:
   > *"My name is Saurabh Rokade, email saurabh@gmail.com, phone 9876543210, I live in Pune, I study at MIT Pune, doing B.Tech in Computer Engineering, graduating in 2025, my CGPA is 8.5 and my skills are Java, React and Python."*
5. The form fills automatically in real time!
6. If any fields are missing, the system will ask you to say them again.

---

## Features

- 🎤 Voice input using Web Speech API
- 🔊 System voice speaks back using Speech Synthesis
- 🤖 GPT-4o-mini extracts structured JSON from speech
- 📝 10-field placement form auto-filled in real time
- ⚠️ Missing field detection + re-prompting
- 🌐 English and Hindi (hi-IN) language support
- 📊 Live form completion progress bar
- 🔁 Reset button to start over
- 💅 Premium dark UI with animations
