// ==============================
// BACKGROUND.JS — Truth Layer API Proxy
// BUG FIXES:
//   1. Added full Gemini Flash API support (was missing entirely)
//   2. Added proper provider routing (auto / groq / gemini)
//   3. Robust JSON parsing with markdown fence stripping
//   4. Proper error propagation so content.js knows when API fails
// ==============================

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const GEMINI_API_URL = (key) =>
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`;

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "PING") {
        console.log("[TruthLayer] Received PING from content script");
        sendResponse({ pong: true, timestamp: Date.now() });
        return;
    }
    
    if (request.action === "ANALYZE") {
        console.log("[TruthLayer] Analyzing text (length: " + request.text.length + ")");
        analyzeAccuracyAPI(request.text)
            .then(data => {
                console.log("[TruthLayer] ✅ Analysis successful:", data);
                sendResponse({ success: true, data });
            })
            .catch(err => {
                console.error("[TruthLayer] ❌ Analysis FAILED:", err.message);
                console.error("[TruthLayer] Stack:", err.stack);
                sendResponse({ success: false, error: err.message });
            });
        return true; // keep message channel open for async
    }
    return false;
});

// ── Shared prompt ──────────────────────────────────────────────────────────────
function buildPrompt(text) {
    return `You are a strict factual accuracy evaluator for AI-generated text.

Evaluate if the following SENTENCE contains factual hallucinations, errors, or unverifiable claims.

Return ONLY a valid JSON object — no markdown, no extra text:
{
  "accuracy_score": <0.0 to 1.0  — 1.0 = fully accurate, 0.0 = completely wrong>,
  "verdict": "<accurate | uncertain | inaccurate>",
  "correction": "<corrected version if wrong/uncertain, else empty string>",
  "source": "<trusted reference if applicable, else empty string>"
}

Scoring guide:
  0.8 – 1.0  →  accurate   (verifiable, factually correct)
  0.5 – 0.79 →  uncertain  (vague, hedged, or cannot be verified)
  0.0 – 0.49 →  inaccurate (contains clear factual errors or hallucinations)

Be skeptical. Prefer "uncertain" over "accurate" when in doubt.

Sentence:
"""${text}"""`;
}

// ── Provider routing ────────────────────────────────────────────────────────────
async function analyzeAccuracyAPI(responseText) {
    const storage = await chrome.storage.local.get(['groqApiKey', 'geminiApiKey', 'aiProvider']);

    const groqKey   = (storage.groqApiKey   || "").trim();
    const geminiKey = (storage.geminiApiKey || "").trim();
    const provider  = storage.aiProvider || "auto";

    const hasGroq   = groqKey.length   > 10 && !groqKey.includes("YOUR_");
    const hasGemini = geminiKey.length > 10 && !geminiKey.includes("YOUR_");

    console.log("[TruthLayer] 🔍 Provider check:");
    console.log("  - aiProvider setting:", provider);
    console.log("  - hasGroq:", hasGroq, "(key length: " + groqKey.length + ")");
    console.log("  - hasGemini:", hasGemini, "(key length: " + geminiKey.length + ")");

    if (!hasGroq && !hasGemini) {
        throw new Error("No API key configured. Open the Truth Layer popup and add a Groq or Gemini key.");
    }

    // Determine primary and fallback providers
    let primary = null, secondary = null;

    if (provider === "groq" && hasGroq) {
        primary = "groq";
        secondary = hasGemini ? "gemini" : null;
    } else if (provider === "gemini" && hasGemini) {
        primary = "gemini";
        secondary = hasGroq ? "groq" : null;
    } else if (provider === "auto") {
        // Auto mode: prefer Groq, fallback to Gemini
        if (hasGroq) {
            primary = "groq";
            secondary = hasGemini ? "gemini" : null;
        } else if (hasGemini) {
            primary = "gemini";
            secondary = null;
        }
    }

    console.log("[TruthLayer] Primary provider:", primary, "| Secondary:", secondary);

    // Try primary provider first, fallback to secondary if it fails
    try {
        if (primary === "gemini") {
            return await analyzeWithGemini(responseText, geminiKey);
        } else {
            return await analyzeWithGroq(responseText, groqKey);
        }
    } catch (primaryErr) {
        console.warn(`[TruthLayer] ⚠️ ${primary} failed, attempting fallback:`, primaryErr.message);
        
        if (secondary) {
            try {
                if (secondary === "gemini") {
                    console.log("[TruthLayer] 🟪 Falling back to Gemini...");
                    return await analyzeWithGemini(responseText, geminiKey);
                } else {
                    console.log("[TruthLayer] 🟦 Falling back to Groq...");
                    return await analyzeWithGroq(responseText, groqKey);
                }
            } catch (secondaryErr) {
                console.error(`[TruthLayer] ❌ Fallback ${secondary} also failed:`, secondaryErr.message);
                throw new Error(`Both providers failed. ${primary}: ${primaryErr.message}; ${secondary}: ${secondaryErr.message}`);
            }
        } else {
            throw primaryErr;
        }
    }
}

// ── Groq (OpenAI-compatible) ────────────────────────────────────────────────────
async function analyzeWithGroq(text, key) {
    console.log("[TruthLayer] 🟦 Trying Groq...");
    
    // Try models in order of preference
    const models = [
        "llama-3.1-70b-versatile",
        "llama3-70b-versatile", 
        "mixtral-8x7b-32768",
        "llama-3.3-70b-versatile"
    ];
    
    for (const model of models) {
        try {
            console.log(`[TruthLayer] Attempting Groq with model: ${model}`);
            const res = await fetch(GROQ_API_URL, {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${key}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    model: model,
                    messages: [{ role: "user", content: buildPrompt(text) }],
                    temperature: 0.1,
                    max_tokens: 256,
                }),
            });

            console.log(`[TruthLayer] Groq (${model}) response status: ${res.status}`);
            
            if (!res.ok) {
                const body = await res.text().catch(() => "");
                console.warn(`[TruthLayer] Groq (${model}) ${res.status}: ${body}`);
                
                // If it's a model not found error, try next model
                if (res.status === 400 && body.includes("model")) {
                    console.log(`[TruthLayer] Model ${model} not available, trying next...`);
                    continue;
                }
                
                throw new Error(`Groq ${res.status}: ${body}`);
            }

            const data = await res.json();
            console.log(`[TruthLayer] ✅ Groq (${model}) successful!`);
            console.log("[TruthLayer] Groq response:", JSON.stringify(data).slice(0, 500));
            
            if (!data.choices || !data.choices[0] || !data.choices[0].message) {
                console.error("[TruthLayer] Unexpected Groq response structure:", data);
                throw new Error("Groq returned unexpected response structure");
            }
            
            return parseJsonResponse(data.choices[0].message.content);
        } catch (err) {
            console.error(`[TruthLayer] Groq (${model}) failed:`, err.message);
            // Continue to next model
        }
    }
    
    // If we get here, all models failed
    throw new Error("All Groq models failed");
}

// ── Gemini Flash ────────────────────────────────────────────────────────────────
async function analyzeWithGemini(text, key) {
    try {
        console.log("[TruthLayer] 🟪 Trying Gemini 2.0...");
        const res = await fetch(GEMINI_API_URL(key), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                contents: [{ parts: [{ text: buildPrompt(text) }] }],
                generationConfig: { temperature: 0.1, maxOutputTokens: 256 },
            }),
        });

        console.log("[TruthLayer] Gemini response status:", res.status);
        if (!res.ok) {
            const body = await res.text().catch(() => "");
            console.error("[TruthLayer] Gemini error body:", body);
            throw new Error(`Gemini ${res.status}: ${body.slice(0, 200)}`);
        }

        const data = await res.json();
        
        // Debug log
        console.log("[TruthLayer] Gemini response structure:", {
            hasCandidates: !!data.candidates,
            candidateCount: data.candidates?.length,
            hasContent: !!data.candidates?.[0]?.content,
            hasParts: !!data.candidates?.[0]?.content?.parts,
            hasText: !!data.candidates?.[0]?.content?.parts?.[0]?.text,
        });
        
        // Handle API errors in response
        if (data.error) {
            throw new Error(`Gemini API error: ${data.error.message || JSON.stringify(data.error)}`);
        }
        
        const raw  = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
        if (!raw) {
            console.warn("[TruthLayer] No text in Gemini response:", data);
            throw new Error("Gemini returned no text content");
        }
        
        console.log("[TruthLayer] Gemini raw response (first 200 chars):", raw.slice(0, 200));
        return parseJsonResponse(raw);
    } catch (err) {
        console.error("[TruthLayer] Gemini error:", err.message);
        throw err;
    }
}

// ── Shared JSON parser ──────────────────────────────────────────────────────────
function parseJsonResponse(raw) {
    try {
        if (!raw || typeof raw !== "string") {
            throw new Error("Raw response is not a string");
        }
        
        console.log("[TruthLayer] Parsing JSON from:", raw.slice(0, 150));
        
        // Strip ```json ... ``` fences that models sometimes add
        const clean = raw
            .replace(/```json\s*/gi, "")
            .replace(/```\s*/gi, "")
            .trim();

        const match = clean.match(/\{[\s\S]*\}/);
        if (!match) throw new Error("No JSON object in API response: " + clean.slice(0, 200));

        console.log("[TruthLayer] Extracted JSON:", match[0].slice(0, 150));
        const parsed = JSON.parse(match[0]);
        console.log("[TruthLayer] Parsed object:", parsed);

        // Normalise score
        let score = parseFloat(parsed.accuracy_score);
        if (isNaN(score)) score = 0.5;
        if (score > 1)    score = score / 100;   // guard against 0-100 scale
        score = Math.max(0, Math.min(1, score));
        parsed.accuracy_score = score;

        // Normalise verdict
        if (!["accurate", "uncertain", "inaccurate"].includes(parsed.verdict)) {
            if (score >= 0.8)      parsed.verdict = "accurate";
            else if (score >= 0.5) parsed.verdict = "uncertain";
            else                   parsed.verdict = "inaccurate";
        }

        parsed.correction = parsed.correction || "";
        parsed.source      = parsed.source      || "";

        console.log("[TruthLayer] ✅ Final result:", parsed);
        return parsed;
    } catch (err) {
        console.error("[TruthLayer] Parse error:", err.message);
        throw err;
    }
}
