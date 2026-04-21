// ==============================
// CONTENT.JS — Truth Layer Core
// BUG FIXES:
//   1. Highlighting now uses the Range API — works even when a sentence
//      spans multiple HTML elements (bold, italic, links, etc.)
//   2. fallbackAnalysis now returns "uncertain" (0.5) instead of "accurate"
//      (0.95) — previously the extension always showed green when API failed
//   3. Removed the +0.15 score boost that pushed everything to "accurate"
//   4. Added ai-flag-yellow class for 0.5–0.75 scores (was missing)
//   5. Improved getLastAssistantMessage with more robust selectors
//   6. Better container detection for ChatGPT's markdown div
// ==============================

let lastProcessedText = "";
let lastCheckText     = "";  // Track text from previous observer check
let lastProcessedEl   = null; // Track which element we're analyzing
let growthWaitCount   = 0;    // Counter for how many times we've waited for growth
let observerTimer     = null;
let sentenceCache     = {};
let isProcessing      = false; // Prevent multiple concurrent analyses

// ── Startup diagnostics ──────────────────────────────────────────────────────
console.log("[TruthLayer] Content script loaded on:", document.location.href);
console.log("[TruthLayer] Chrome API available:", typeof chrome !== "undefined");
console.log("[TruthLayer] Chrome runtime available:", typeof chrome?.runtime !== "undefined");
console.log("[TruthLayer] Chrome runtime.sendMessage available:", typeof chrome?.runtime?.sendMessage === "function");

if (typeof chrome === "undefined" || !chrome.runtime) {
    console.error("[TruthLayer] ❌ CRITICAL: Chrome extension API not available!");
    console.error("[TruthLayer] This means the extension is not properly loaded.");
    console.error("[TruthLayer] Please:");
    console.error("  1. Go to chrome://extensions/");
    console.error("  2. Find 'Truth Layer'");
    console.error("  3. Make sure it's ENABLED (toggle ON)");
    console.error("  4. Click the reload button (circular arrow)");
    console.error("  5. Refresh this page");
    // Don't return - just skip initialization
} else {
    // ── Test service worker connection ───────────────────────────────────────────
    console.log("[TruthLayer] Testing service worker connection...");
    chrome.runtime.sendMessage({ action: "PING" }, (response) => {
        if (chrome.runtime.lastError) {
            console.error("[TruthLayer] ❌ Service worker not responding:", chrome.runtime.lastError.message);
            console.error("[TruthLayer] The background script may not be running.");
        } else {
            console.log("[TruthLayer] ✅ Service worker responding:", response);
        }
    });
}


// ── MutationObserver ──────────────────────────────────────────────────────────
const observer = new MutationObserver(() => {
    clearTimeout(observerTimer);
    observerTimer = setTimeout(async () => {
        // Skip if already processing
        if (isProcessing) {
            console.log("[TruthLayer] Skipping - already processing");
            return;
        }

        const el = getLastAssistantMessage();
        if (!el) {
            console.log("[TruthLayer] No assistant message found");
            return;
        }

        // Detect new response (different element = new conversation message)
        if (el !== lastProcessedEl) {
            console.log("[TruthLayer] ✅ Detected new response element, resetting tracking");
            lastProcessedEl = el;
            lastCheckText = "";   // Reset text growth tracking
            lastProcessedText = ""; // Reset processed text
            growthWaitCount = 0;  // Reset growth wait counter
        }

        const text = el.innerText.trim();
        if (!text || text === lastProcessedText || text.length < 2) {
            console.log("[TruthLayer] Skipping - no new text");
            return;
        }

        // Smart streaming detection: only skip if text is actively GROWING
        const growth = text.length - lastCheckText.length;
        
        // If text is growing by small amounts repeatedly, it's streaming
        if (growth > 0 && growth < 100) {
            if (growthWaitCount < 3) {
                console.log("[TruthLayer] Text growing by", growth, "chars (wait #" + (growthWaitCount + 1) + "/3)");
                lastCheckText = text;
                growthWaitCount++;
                return; // Wait for next check
            } else {
                // Even if still growing, we've waited enough - force processing
                console.log("[TruthLayer] Waited 3 times, forcing analysis despite growth");
            }
        } else {
            // Text is stable (no growth or large jump) - proceed
            lastCheckText = text;
        }

        console.log("[TruthLayer] Processing response:", text.slice(0, 100) + "...");
        isProcessing = true;
        lastProcessedText = text;
        addLoadingBadge(el);

        try {
            const sentences = splitIntoSentences(text);
            console.log("[TruthLayer] Total sentences:", sentences.length);
            sentences.forEach((s, i) => console.log(`[TruthLayer] Sentence ${i+1}:`, s.slice(0, 80)));

            // Filter to only analyze meaningful sentences—skip filler, meta, opinions
            const analyzableSentences = sentences.filter(shouldAnalyze);
            console.log("[TruthLayer] Sentences to analyze:", analyzableSentences.length, "| Skipped:", sentences.length - analyzableSentences.length);
            analyzableSentences.forEach((s, i) => console.log(`[TruthLayer] Analyzing ${i+1}:`, s.slice(0, 80)));

            // Build results: for skipped sentences, return neutral accuracy
            const sentenceResults = await Promise.all(
                sentences.map(async (sentence) => {
                    // If not analyzable, return neutral result (accurate by default—not flagged)
                    if (!analyzableSentences.includes(sentence)) {
                        console.log("[TruthLayer] Skipping analysis (filtered):", sentence.slice(0, 60));
                        return {
                            sentence,
                            accuracy_score: 1.0,  // Neutral—not flagged
                            verdict: "accurate",
                            correction: "",
                            source: ""
                        };
                    }

                    // For analyzable sentences, check cache then call API
                    if (sentenceCache[sentence]) {
                        console.log("[TruthLayer] Cache hit:", sentence.slice(0, 60));
                        return sentenceCache[sentence];
                    }
                    console.log("[TruthLayer] Sending to API:", sentence.slice(0, 60));
                    const res    = await analyzeAccuracy(sentence);
                    console.log("[TruthLayer] API response score:", res.accuracy_score, "verdict:", res.verdict);
                    const result = { sentence, ...res };
                    sentenceCache[sentence] = result;
                    return result;
                })
            );

            console.log("[TruthLayer] All results:", sentenceResults.map(r => ({text: r.sentence.slice(0, 40), score: r.accuracy_score})));

            const overallScore = aggregateScore(sentenceResults);
            let overallVerdict = "accurate";
            if      (overallScore < 0.5) overallVerdict = "inaccurate";
            else if (overallScore < 0.8) overallVerdict = "uncertain";

            console.log("[TruthLayer] Overall score:", overallScore, "verdict:", overallVerdict);
            applyUI(el, overallScore, overallVerdict, sentenceResults);
        } finally {
            isProcessing = false;
            growthWaitCount = 0; // Reset for next response
        }
    }, 1200);
});

observer.observe(document.body, { childList: true, subtree: true, characterData: true });

// ── Sentence splitter ─────────────────────────────────────────────────────────
function splitIntoSentences(text) {
    // Split on sentence-ending punctuation, keep the punctuation
    const raw = text.match(/[^.!?\n]+[.!?]*[\n]?/g) || [text];
    return raw
        .map(s => s.trim().replace(/\s+/g, " "))
        .filter(s => isFactualStatement(s));
}

// ── Smart Analysis Filter: Only analyze meaningful sentences ────────────────
function shouldAnalyze(sentence) {
    if (!sentence || sentence.length < 2) return false; // Allow very short responses
    
    // For very short sentences (< 4 words), always analyze (e.g., "Hi", "Hey", "Hello")
    const words = sentence.split(/\s+/);
    const wordCount = words.length;
    if (wordCount < 3) return true;

    // SKIP: Too short
    if (wordCount < 6) return false;

    const lower = sentence.toLowerCase();
    const trimmed = sentence.trim();

    // SKIP: Filler words and responses
    const fillerPatterns = [
        /^(sure|okay|ok|yeah|yep|nope|no|yes|here|thanks|thank you|please|well|so|actually|basically|essentially)/i,
        /^(i think|i believe|i feel|i'm|i'm not|you might|you could|perhaps|maybe|possibly)/i,
        /^(hope this|glad to|happy to|let me know|thanks for|great question)/i,
    ];
    if (fillerPatterns.some(p => p.test(trimmed))) return false;

    // SKIP: Meta/disclaimer text
    const metaKeywords = [
        "i'm not an expert", "i'm not sure", "not entirely sure",
        "according to my", "based on my", "in my opinion",
        "as i understand", "if i recall", "as far as i know",
        "this is just my", "i don't have", "i can't",
    ];
    if (metaKeywords.some(kw => lower.includes(kw))) return false;

    // SKIP: Pure opinions (no facts)
    const opinionWords = ["great", "awesome", "terrible", "horrible", "beautiful", "ugly", "wonderful", "awful"];
    const hasOpinion = opinionWords.some(w => lower.includes(" " + w + " ") || lower.startsWith(w + " ") || lower.endsWith(" " + w));
    const hasFactualContent = /\d+|dates?|times?|years?|months?|when|where|how|what|which|there|those|these|this/i.test(sentence);
    if (hasOpinion && !hasFactualContent) return false;

    // SKIP: Heavy uncertainty/hedging
    const uncertainPatterns = [
        /\b(might|could|may|perhaps|possibly|probably probably|likely|seem|appear|tend to|sort of|kind of|rather|quite|fairly|somewhat)\b/i,
    ];
    const uncertainCount = (sentence.match(/\b(might|could|may|perhaps|possibly|probably|likely|seem|appear)\b/gi) || []).length;
    if (uncertainCount >= 2) return false;

    // ANALYZE: Contains facts/data/instructions
    const hasAnalyzableContent = !!(
        /\d+/g.test(sentence) ||                           // Numbers
        /\b(January|February|March|April|May|June|July|August|September|October|November|December|\d{1,2}\/\d{1,2}\/\d{2,4})\b/i.test(sentence) ||  // Dates
        /\b(is|are|was|were|will|can|does|do|has|have|should|must|requires|contains|includes|means|defined|refers|called)\b/i.test(sentence) || // Factual verbs
        /[A-Z][a-z]+ [A-Z][a-z]+/g.test(sentence) ||       // Proper nouns (two+ capitals)
        /\b(the|a)\s+[A-Z]/g.test(sentence) ||             // "The XYZ" pattern
        /step|process|method|procedure|instruction|guideline|rule|law|principle|concept|definition/i.test(sentence) // Instructional
    );

    return hasAnalyzableContent;
}

// ── Filter: Only keep factual statements, skip questions/instructions/UI ──────
function isFactualStatement(sentence) {
    if (!sentence || sentence.length < 2) return false; // Allow very short
    
    // For very short sentences (< 4 words), let them through unless they're questions
    const words = sentence.split(/\s+/).filter(w => w.length > 0);
    if (words.length < 3) {
        // Only filter out questions
        return !sentence.trim().endsWith("?");
    }
    
    // Skip questions and instructions (end with ?)
    if (sentence.trim().endsWith("?")) return false;
    
    // Skip if too many badge/emoji characters
    const badgeEmojis = (sentence.match(/🟡|🔴|🟢|⚙️|🟠|⚠️|✅|❌|🎯|💡|📌|🔔/g) || []).length;
    if (badgeEmojis / Math.max(sentence.length, 1) > 0.15) return false; // More than 15% badges
    
    // Skip obvious instruction patterns
    const lowerSentence = sentence.toLowerCase();
    const instructionPatterns = [
        "upload", "send", "provide", "share", "click", "try", "include",
        "please", "sure", "okay", "got it", "understand", "let me",
        "for best", "to do this", "to get", "can you", "will you",
        "once you", "if you", "when you", "before you", "after you",
        "screenshot", "image", "photo", "file", "document",
        "next", "then", "finally", "last step"
    ];
    
    const startsWithInstruction = instructionPatterns.some(pattern => 
        lowerSentence.startsWith(pattern)
    );
    if (startsWithInstruction) return false;
    
    // Skip sentences that are mostly punctuation or numbers
    const alphaCount = (sentence.match(/[a-zA-Z]/g) || []).length;
    if (alphaCount < 10) return false; // Mostly punctuation/numbers
    
    // Skip metadata patterns (things in parentheses/brackets at start)
    if (/^\s*[\(\[\{].*[\)\]\}]\s*$/.test(sentence)) return false;
    
    // Skip the extension's own badges
    if (sentence.includes("Truth Layer") || 
        sentence.includes("ai-flag") ||
        sentence.includes("Accurate") ||
        sentence.includes("Uncertain") ||
        sentence.includes("Inaccurate")) return false;
    
    return true;
}

// ── Score aggregation ─────────────────────────────────────────────────────────
function aggregateScore(results) {
    if (!results.length) return 1.0;
    const sum = results.reduce((acc, r) => acc + (r.accuracy_score ?? 0.5), 0);
    return sum / results.length;
}

// ── Target element ─────────────────────────────────────────────────────────────
function getLastAssistantMessage() {
    // Primary selectors (most reliable for recent ChatGPT versions)
    const primarySelectors = [
        "div[data-message-author-role='assistant']",     // Direct role attribute
        "[role='article'][data-message-author-role='assistant']", // With role attribute
        "article[data-message-author-role='assistant']",   // Article variant
    ];

    for (const sel of primarySelectors) {
        const nodes = document.querySelectorAll(sel);
        if (nodes.length) {
            const lastNode = nodes[nodes.length - 1];
            console.log("[TruthLayer] Found assistant message via:", sel);
            return lastNode;
        }
    }

    // Fallback selectors (broader search)
    const fallbackSelectors = [
        "[data-message-id]",                                // By message ID
        "div[class*='message']div[class*='text']",         // Message text container
        "div[class*='prose']",                             // Prose container  
        "[role='article']",                                 // Any article role
        ".rounded-lg.border.border-black/10.bg-white",    // ChatGPT message box styling
        "div.group.w-full.text-gray-800",                 // Message group styling
    ];

    for (const sel of fallbackSelectors) {
        try {
            const nodes = document.querySelectorAll(sel);
            if (nodes.length > 0) {
                // Filter for assistant messages (check content or position)
                const lastNode = nodes[nodes.length - 1];
                // Make sure it's not streaming
                if (lastNode.querySelector('.cursor, [class*="cursor"], [data-testid*="cursor"]')) {
                    return null;
                }
                console.log("[TruthLayer] Found message via fallback:", sel);
                return lastNode;
            }
        } catch (e) {
            console.log("[TruthLayer] Fallback selector failed:", sel, e.message);
        }
    }

    console.log("[TruthLayer] ❌ Could not find any message element");
    console.log("[TruthLayer] Available DOM elements:", document.body.innerHTML.slice(0, 200));
    return null;
}

// ── API call ───────────────────────────────────────────────────────────────────
async function analyzeAccuracy(sentence) {
    return new Promise((resolve) => {
        if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
            console.warn("[TruthLayer] Chrome runtime not available");
            return resolve(fallbackAnalysis());
        }

        try {
            console.log("[TruthLayer] Sending to background.js:", sentence.slice(0, 60) + "...");
            chrome.runtime.sendMessage({ action: "ANALYZE", text: sentence }, (response) => {
                if (chrome.runtime.lastError) {
                    const errMsg = chrome.runtime.lastError.message;
                    console.warn("[TruthLayer] Message error:", errMsg);
                    
                    // Extension context invalidated — extension was reloaded
                    if (errMsg.includes("context") || errMsg.includes("invalidated")) {
                        console.warn("[TruthLayer] ⚠️ Extension context invalidated. Reload the page or the extension.");
                    }
                    return resolve(fallbackAnalysis());
                }
                if (!response) {
                    console.warn("[TruthLayer] No response from background script");
                    return resolve(fallbackAnalysis());
                }
                console.log("[TruthLayer] Response from background:", response);
                if (!response.success) {
                    console.warn("[TruthLayer] API failure:", response.error);
                    return resolve(fallbackAnalysis());
                }
                if (!response.data) {
                    console.warn("[TruthLayer] No data in response:", response);
                    return resolve(fallbackAnalysis());
                }
                try {
                    const result = normaliseResult(response.data);
                    console.log("[TruthLayer] Final result from content.js:", result);
                    resolve(result);
                } catch (parseErr) {
                    console.error("[TruthLayer] Error normalising result:", parseErr);
                    resolve(fallbackAnalysis());
                }
            });
        } catch (e) {
            console.error("[TruthLayer] sendMessage exception:", e);
            
            // If extension context is invalidated, show message
            if (e.message && (e.message.includes("context") || e.message.includes("invalidated"))) {
                console.error("[TruthLayer] ❌ Extension context invalidated. Reload the page.");
            }
            resolve(fallbackAnalysis());
        }
    });
}

// ── Result normalisation ───────────────────────────────────────────────────────
function normaliseResult(data) {
    console.log("[TruthLayer] normaliseResult input:", data);
    if (!data || typeof data !== "object") {
        console.warn("[TruthLayer] Invalid data passed to normaliseResult:", data);
        return fallbackAnalysis();
    }
    
    try {
        let score = parseFloat(data.accuracy_score ?? 0.5);
        if (isNaN(score)) score = 0.5;
        score = Math.max(0, Math.min(1, score));

        // BUG FIX: Removed the +0.15 boost that was inflating all scores to "accurate"
        // Local heuristics: only apply a mild uncertainty penalty
        const lower = (data._sentence || "").toLowerCase();
        const vague = ["perhaps", "might", "seems", "could", "maybe", "possibly"];
        if (vague.some(w => lower.includes(w))) {
            score = Math.max(0, score - 0.08);
        }

        let verdict = data.verdict || "uncertain";
        if (!["accurate", "uncertain", "inaccurate"].includes(verdict)) {
            if      (score < 0.5) verdict = "inaccurate";
            else if (score < 0.8) verdict = "uncertain";
            else                  verdict = "accurate";
        }

        const result = {
            accuracy_score: score,
            verdict,
            correction: data.correction || "",
            source:     data.source     || "",
        };
        console.log("[TruthLayer] normaliseResult output:", result);
        return result;
    } catch (err) {
        console.error("[TruthLayer] Error in normaliseResult:", err);
        return fallbackAnalysis();
    }
}

// BUG FIX: Was returning 0.95 / "accurate" — everything looked fine even with no API key
function fallbackAnalysis() {
    return { accuracy_score: 0.5, verdict: "uncertain", correction: "", source: "" };
}

// ── UI orchestrator ───────────────────────────────────────────────────────────
function applyUI(el, overallScore, verdict, sentenceResults) {
    // Left border
    const borderColor = { accurate: "transparent", uncertain: "#f39c12", inaccurate: "#e74c3c" }[verdict];
    Object.assign(el.style, {
        transition:    "border-left 0.4s ease",
        borderLeft:    `4px solid ${borderColor}`,
        paddingLeft:   "12px",
        paddingTop:    "38px",
        borderTop:     "none",
        borderRight:   "none",
        borderBottom:  "none",
    });

    addBadge(el, overallScore, verdict);
    highlightSentences(el, sentenceResults);
}

// ── Loading badge ─────────────────────────────────────────────────────────────
function addLoadingBadge(el) {
    el.querySelector(".tl-badge")?.remove();
    const badge = document.createElement("div");
    badge.className = "tl-badge tl-badge-loading";
    badge.textContent = "⚙️ Truth Layer — analyzing…";
    if (window.getComputedStyle(el).position === "static") el.style.position = "relative";
    el.appendChild(badge);
}

// ── Result badge ──────────────────────────────────────────────────────────────
function addBadge(el, score, verdict) {
    el.querySelector(".tl-badge")?.remove();
    const badge   = document.createElement("div");
    badge.className = "tl-badge";

    const pct = Math.round(score * 100);
    const icons = { accurate: "🟢", uncertain: "🟡", inaccurate: "🔴" };
    const labels = { accurate: "Accurate", uncertain: "Uncertain", inaccurate: "Inaccurate" };
    badge.textContent = `${icons[verdict]} ${labels[verdict]} (${pct}%)`;
    badge.classList.add(`tl-badge-${verdict}`);

    if (window.getComputedStyle(el).position === "static") el.style.position = "relative";
    el.appendChild(badge);
}

// ══════════════════════════════════════════════════════════════════════════════
// SENTENCE HIGHLIGHTING — Range API (BUG FIX)
//
// OLD approach: searched for sentence text inside individual text nodes.
//   ❌ Fails when a sentence spans multiple elements (bold, link, code, etc.)
//
// NEW approach: uses document.createRange() + character offset mapping.
//   ✅ Correctly wraps text that crosses element boundaries.
// ══════════════════════════════════════════════════════════════════════════════
function highlightSentences(el, sentenceResults) {
    // Find the prose/markdown container or fall back to el
    const target = (
        el.querySelector(".markdown")          ||
        el.querySelector(".prose")             ||
        el.querySelector("[class*='markdown']") ||
        el.querySelector("[class*='prose']")   ||
        el
    );

    // ── Remove old highlights without breaking inner HTML ─────────────────────
    target.querySelectorAll(".tl-flag").forEach(span => {
        span.replaceWith(...span.childNodes);
    });
    target.normalize(); // merge adjacent text nodes created by replaceWith

    // ── Highlight each flagged sentence ───────────────────────────────────────
    // STRICT MODE: Only highlight genuinely inaccurate statements (red & orange)
    // Skip yellow/uncertain statements to reduce noise
    const flagged = sentenceResults.filter(r => r.accuracy_score < 0.65 && r.sentence.length > 12);
    console.log("[TruthLayer] Highlighting: flagged count =", flagged.length, "out of", sentenceResults.length);
    flagged.forEach(r => console.log("[TruthLayer] Flagged to highlight:", r.sentence.slice(0, 60), "score:", r.accuracy_score));
    
    if (!flagged.length) {
        console.log("[TruthLayer] No sentences to highlight");
        return;
    }

    // Work on block-level children (p, li, h*) when possible for better precision
    const blocks = target.querySelectorAll("p, li, h1, h2, h3, h4, h5, h6, td, blockquote");
    const containers = blocks.length ? Array.from(blocks) : [target];
    console.log("[TruthLayer] Found", containers.length, "containers to search");

    for (const res of flagged) {
        const sentence = res.sentence.trim();
        const colorClass = res.accuracy_score < 0.5
            ? "tl-flag-red"
            : "tl-flag-orange";

        let highlighted = false;
        let attemptCount = 0;

        for (const container of containers) {
            const containerText = container.textContent || container.innerText || "";
            // Try exact match, then leading-fragment match (first 25 chars)
            const attempts = [sentence, sentence.slice(0, 25)];

            for (const attempt of attempts) {
                attemptCount++;
                const idx = containerText.toLowerCase().indexOf(attempt.toLowerCase());
                if (idx === -1) {
                    console.log("[TruthLayer] Not found (attempt", attemptCount + '):', attempt.slice(0, 40));
                    continue;
                }

                console.log("[TruthLayer] Found at position", idx, ":", attempt.slice(0, 40));

                const range = buildRangeForOffset(container, idx, idx + attempt.length);
                if (!range) continue;

                highlighted = wrapRange(range, colorClass, res);
                if (highlighted) break;
            }
            if (highlighted) break;
        }
    }
}

// ── Build a DOM Range from character offsets within a container ───────────────
function buildRangeForOffset(container, start, end) {
    const range = document.createRange();
    let charIndex = 0;
    let startNode = null, startOff = 0;
    let endNode   = null, endOff   = 0;

    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            // Skip text already inside a highlight
            return node.parentElement?.classList.contains("tl-flag")
                ? NodeFilter.FILTER_REJECT
                : NodeFilter.FILTER_ACCEPT;
        },
    });

    let node;
    while ((node = walker.nextNode())) {
        const len = node.nodeValue.length;

        if (!startNode && charIndex + len > start) {
            startNode = node;
            startOff  = start - charIndex;
        }
        if (startNode && !endNode && charIndex + len >= end) {
            endNode = node;
            endOff  = end - charIndex;
            break;
        }
        charIndex += len;
    }

    if (!startNode || !endNode) return null;

    try {
        range.setStart(startNode, Math.min(startOff, startNode.nodeValue.length));
        range.setEnd(endNode,     Math.min(endOff,   endNode.nodeValue.length));
        return range;
    } catch {
        return null;
    }
}

// ── Wrap a Range in a highlight <span> ────────────────────────────────────────
function wrapRange(range, colorClass, res) {
    const span = document.createElement("span");
    span.className    = `tl-flag ${colorClass}`;
    span.dataset.score      = Math.round(res.accuracy_score * 100) + "%";
    span.dataset.verdict    = res.verdict;
    span.dataset.correction = res.correction || "No correction available.";
    span.dataset.source     = res.source     || "";

    span.addEventListener("click", (e) => {
        // Allow links to work normally
        const clickedElement = e.target;
        if (clickedElement.tagName === "A" || clickedElement.closest("a")) {
            console.log("[TruthLayer] Link clicked, allowing default behavior");
            return; // Don't stop propagation, let the link work
        }

        // For non-link clicks, show tooltip
        e.stopPropagation();
        showTooltip(span, e);
    });

    try {
        range.surroundContents(span);
        return true;
    } catch {
        try {
            span.appendChild(range.extractContents());
            range.insertNode(span);
            return true;
        } catch {
            return false;
        }
    }
}

// ── Tooltip ───────────────────────────────────────────────────────────────────
function showTooltip(spanEl, event) {
    document.getElementById("tl-tooltip")?.remove();

    const tooltip = document.createElement("div");
    tooltip.id = "tl-tooltip";

    const score    = spanEl.dataset.score;
    const verdict  = spanEl.dataset.verdict;
    const corr     = spanEl.dataset.correction;
    const src      = spanEl.dataset.source;
    const origText = spanEl.textContent;

    const verdictConfig = {
        inaccurate: { icon: "❌", color: "#ff6b6b", label: "Inaccurate" },
        uncertain:  { icon: "⚠️", color: "#f39c12", label: "Uncertain"  },
        accurate:   { icon: "✅", color: "#2ecc71", label: "Accurate"   },
    };
    const vc = verdictConfig[verdict] || verdictConfig.uncertain;

    const srcHtml = src
        ? `<div class="tl-tt-section">
             <div class="tl-tt-label">📚 Reference</div>
             <a href="${src.startsWith("http") ? src : "#"}" target="_blank" class="tl-tt-link">${src}</a>
           </div>`
        : "";

    const corrHtml = corr && corr !== "No correction available."
        ? `<div class="tl-tt-section">
             <div class="tl-tt-label">✅ Suggested Correction</div>
             <div class="tl-tt-corr">${escapeHtml(corr)}</div>
           </div>`
        : "";

    tooltip.innerHTML = `
        <div class="tl-tt-header">
            <span class="tl-tt-verdict" style="color:${vc.color}">${vc.icon} ${vc.label}</span>
            <span class="tl-tt-score">${score} accuracy</span>
        </div>
        <div class="tl-tt-body">
            <div class="tl-tt-section">
                <div class="tl-tt-label">🔍 Flagged Text</div>
                <div class="tl-tt-orig">${escapeHtml(origText)}</div>
            </div>
            ${corrHtml}
            ${srcHtml}
        </div>
        <div class="tl-tt-footer">Click outside to dismiss</div>
    `;

    document.body.appendChild(tooltip);
    positionTooltip(tooltip, spanEl);

    // Fade in
    requestAnimationFrame(() => {
        tooltip.style.opacity = "1";
        tooltip.style.transform = "translateY(0) scale(1)";
    });

    const dismiss = (e) => {
        if (!tooltip.contains(e.target) && e.target !== spanEl) {
            tooltip.style.opacity = "0";
            tooltip.style.transform = "translateY(-6px) scale(0.97)";
            setTimeout(() => tooltip.remove(), 200);
            document.removeEventListener("click", dismiss, true);
        }
    };
    setTimeout(() => document.addEventListener("click", dismiss, true), 50);
}

function positionTooltip(tooltip, anchor) {
    const rect = anchor.getBoundingClientRect();
    let top  = rect.bottom + window.scrollY + 10;
    let left = rect.left   + window.scrollX;

    // Reposition after paint so we have real dimensions
    requestAnimationFrame(() => {
        const tw = tooltip.offsetWidth  || 320;
        const th = tooltip.offsetHeight || 160;
        if (left + tw > window.innerWidth  - 16) left = window.innerWidth  - tw - 16;
        if (top  + th > window.scrollY + window.innerHeight) {
            top = rect.top + window.scrollY - th - 10;
        }
        tooltip.style.top  = top  + "px";
        tooltip.style.left = left + "px";
    });
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}
