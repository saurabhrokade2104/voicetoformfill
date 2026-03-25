require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const { Cartesia } = require("@cartesia/cartesia-js");

const cartesia = new Cartesia({ apiKey: process.env.CARTESIA_API_KEY });

/**
 * Convert text to speech using Cartesia's Sonic neural TTS.
 * Returns a Buffer containing WAV audio data (44100 Hz, PCM).
 *
 * @param {string} text  The text to synthesize
 * @returns {Promise<Buffer>}
 */
async function textToSpeech(text) {
    // cartesia.tts.generate() returns a Response-like object with arrayBuffer()
    const response = await cartesia.tts.generate({
        model_id: "sonic-multilingual", // Use multilingual for Indian accents
        transcript: text,
        voice: {
            mode: "id",
            id: "95d51f79-c397-46f9-b49a-23763d3eaa2d", // Arushi – Hinglish Speaker, very natural Indian female voice
        },
        output_format: {
            container: "wav",
            encoding: "pcm_f32le",
            sample_rate: 44100,
        },
        language: "en",
    });

    // The SDK returns a Response-like object; get the raw bytes
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
}

module.exports = { textToSpeech };
