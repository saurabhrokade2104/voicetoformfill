/**
 * Simple in-memory session store for tracking Twilio calls and WS connections.
 * Maps a sessionId (e.g. Twilio CallSid or Phone Number) to its form state and history.
 */
const { getInitialState } = require("./gemini");

const activeSessions = new Map();

function getSession(sessionId) {
    if (!activeSessions.has(sessionId)) {
        activeSessions.set(sessionId, {
            state: getInitialState(),
            history: [],
            isConfirmed: false
        });
    }
    return activeSessions.get(sessionId);
}

function updateSession(sessionId, newState, newHistory, isConfirmed) {
    if (activeSessions.has(sessionId)) {
        const session = activeSessions.get(sessionId);
        session.state = newState || session.state;
        session.history = newHistory || session.history;
        session.isConfirmed = isConfirmed !== undefined ? isConfirmed : session.isConfirmed;
    }
}

function clearSession(sessionId) {
    activeSessions.delete(sessionId);
}

module.exports = {
    getSession,
    updateSession,
    clearSession
};
