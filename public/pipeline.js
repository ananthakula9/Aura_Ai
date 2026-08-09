/* ============================================================
   AURA FARMER AI — DECISION PIPELINE
   Real internal components, not a prompt trick.

   FLOW:
   user message -> Memory context -> Mood Detector -> Aura Engine
   -> (LLM generates raw response using control values)
   -> Cringe Check / Quality Check -> possible rewrite
   -> Final response -> Aura Score + Event -> Memory Update
   ============================================================ */

// ---------- MEMORY ----------
// Tracks recent behavior so the engine can penalize repetition.
class AuraMemory {
    constructor() {
        this.recentPhrases = [];      // last N distinctive phrases the AI used
        this.recentSlang = [];        // slang terms used, with timestamps (turn index)
        this.recentEmojis = [];
        this.recentAuraEvents = [];   // {type, delta, turn}
        this.userSlangFrequency = 0;  // 0-1, rolling estimate of how much user slangs
        this.userMoodHistory = [];    // last few detected moods
        this.turn = 0;
        this.auraScore = 500;         // starting baseline, RPG-style
        this.recentStyles = [];       // recent aura styles used, avoid back-to-back repeats
    }

    advanceTurn() { this.turn++; }

    addPhrase(phrase) {
        this.recentPhrases.push({ phrase: phrase.toLowerCase(), turn: this.turn });
        this.recentPhrases = this.recentPhrases.slice(-12);
    }

    phraseRepeatCount(phrase) {
        const p = phrase.toLowerCase();
        return this.recentPhrases.filter(x => x.phrase === p && this.turn - x.turn <= 6).length;
    }

    addSlang(terms) {
        terms.forEach(t => this.recentSlang.push({ term: t.toLowerCase(), turn: this.turn }));
        this.recentSlang = this.recentSlang.slice(-20);
    }

    slangDensityRecent(windowTurns = 4) {
        return this.recentSlang.filter(s => this.turn - s.turn <= windowTurns).length;
    }

    addEmojis(emojis) {
        emojis.forEach(e => this.recentEmojis.push({ emoji: e, turn: this.turn }));
        this.recentEmojis = this.recentEmojis.slice(-20);
    }

    emojiDensityRecent(windowTurns = 3) {
        return this.recentEmojis.filter(e => this.turn - e.turn <= windowTurns).length;
    }

    addStyle(style) {
        this.recentStyles.push(style);
        this.recentStyles = this.recentStyles.slice(-5);
    }

    styleRepeatStreak(style) {
        let streak = 0;
        for (let i = this.recentStyles.length - 1; i >= 0; i--) {
            if (this.recentStyles[i] === style) streak++;
            else break;
        }
        return streak;
    }

    recordEvent(type, delta) {
        this.recentAuraEvents.push({ type, delta, turn: this.turn });
        this.recentAuraEvents = this.recentAuraEvents.slice(-10);
        this.auraScore = Math.max(0, this.auraScore + delta);
    }

    recentEventCount(windowTurns = 5) {
        return this.recentAuraEvents.filter(e => this.turn - e.turn <= windowTurns).length;
    }

    updateUserSlang(detected) {
        // exponential moving average toward 1 if slang detected, else toward 0
        const target = detected ? 1 : 0;
        this.userSlangFrequency = this.userSlangFrequency * 0.7 + target * 0.3;
    }

    pushMood(mood) {
        this.userMoodHistory.push(mood);
        this.userMoodHistory = this.userMoodHistory.slice(-6);
    }
}

// ---------- MOOD DETECTOR ----------
const MOOD_LEXICON = {
    upset: /\b(angry|pissed|frustrated|annoyed|hate this|so mad|furious|upset|hurts|crying|depressed|sad|awful|terrible day|worst day)\b/i,
    excited: /\b(omg|yesss|let'?s go|so hyped|so excited|can'?t wait|amazing news|just got|i did it|i won|i passed|i beat)\b/i,
    joking: /\b(lol|lmao|haha|jk|kidding|joking|bruh moment|fr\?|deadass\?)\b/i,
    serious: /\b(need help with|deadline|urgent|important|exam tomorrow|interview|due tomorrow|emergency|please help|struggling)\b/i,
    casual: /\b(yo|hey|sup|what'?s up|just chilling|bored)\b/i,
};

const SLANG_TERMS = [
    "bro","bruh","fr","frfr","ngl","lowkey","highkey","bet","nah","nahhh","aight",
    "say less","cooked","cooking","let him cook","you cooked","locked in","clutch",
    "\\bw\\b","\\bl\\b","valid","mid","wild","tuff","clean","yapping","yap",
    "we'?re so back","it'?s over","i fear","it'?s giving","blud","canon event",
    "skill issue","absolute cinema","based","deadass","no cap","cap\\b"
];
const SLANG_REGEX = new RegExp(`\\b(${SLANG_TERMS.join("|")})\\b`, "gi");
const EMOJI_REGEX = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu;

// ---------- QUERY CLASSIFIER ----------
// Runs BEFORE the aura engine. Detects substantive requests (knowledge,
// math, code, writing help, analysis) that need the General AI Core to
// lead. This caps how much room the Aura Layer is allowed to take up,
// structurally — not just via prompt suggestion.
const SUBSTANTIVE_PATTERNS = [
    /\b(what is|what are|define|explain|how does|how do|why does|why do|why is)\b/i,
    /\b(solve|calculate|compute|derive|prove|simplify|factor|integrate|differentiate)\b/i,
    /\d+\s*[\+\-\*\/\^]\s*\d+/, // arithmetic expressions
    /\b(equation|formula|theorem|algorithm|function|variable)\b/i,
    /\b(code|bug|error|debug|exception|stack trace|doesn'?t work|not working|fix this)\b/i,
    /\b(summarize|summarise|rewrite|edit this|improve this|proofread|analyze|analyse)\b/i,
    /\b(history of|geography|science|physics|chemistry|biology|math(s)?|economics)\b/i,
    /\b(homework|assignment|essay|thesis|research|study guide|exam prep)\b/i,
    /```|def |function |const |import |class \w+/,  // code blocks / snippets
];

function classifyQuery(message) {
    const hits = SUBSTANTIVE_PATTERNS.filter(re => re.test(message)).length;
    const isSubstantive = hits > 0;
    // Long, detailed messages are more likely to be real requests than banter
    const isLong = message.trim().length > 140;
    return {
        isSubstantive: isSubstantive || isLong,
        confidence: Math.min(1, hits / 2 + (isLong ? 0.3 : 0)),
    };
}

function detectMood(message, memory) {
    const scores = {};
    for (const [mood, regex] of Object.entries(MOOD_LEXICON)) {
        scores[mood] = regex.test(message) ? 1 : 0;
    }

    const slangMatches = message.match(SLANG_REGEX) || [];
    memory.updateUserSlang(slangMatches.length > 0);

    // priority order: upset/serious override excited/casual
    let mood = "neutral";
    if (scores.upset) mood = "upset";
    else if (scores.serious) mood = "serious";
    else if (scores.excited) mood = "excited";
    else if (scores.joking) mood = "joking";
    else if (scores.casual) mood = "casual";

    memory.pushMood(mood);

    return {
        mood,
        userSlangDetected: slangMatches.length > 0,
        userSlangTerms: slangMatches,
        messageLength: message.trim().length,
        isQuestion: /\?\s*$/.test(message.trim()) || /^(how|what|why|can|could|should|is|are|does|do)\b/i.test(message.trim()),
    };
}

// ---------- AURA ENGINE ----------
// Decides: aura opportunity %, intensity 0-4, style, slang level 0-4, cringe risk baseline
function runAuraEngine(message, moodResult, memory, controlMode) {
    let opportunity = 30; // baseline
    let intensity = 0;
    let style = "normal";
    let slangIntensity = Math.round(memory.userSlangFrequency * 4);
    let cringeRiskBase = 5;

    const { mood, isQuestion, userSlangDetected } = moodResult;

    // --- Query classification runs first: substantive requests structurally
    // cap the Aura Layer so the General AI Core leads. This is a hard cap,
    // applied again at the end, so no downstream branch can override it. ---
    const queryClass = classifyQuery(message);

    // --- Mood-based adjustment ---
    if (mood === "upset") {
        opportunity = 5;
        intensity = 0;
        style = "supportive";
        slangIntensity = 0;
    } else if (mood === "serious") {
        opportunity = 15;
        intensity = 0;
        style = "concise";
        slangIntensity = Math.min(slangIntensity, 1);
    } else if (mood === "excited") {
        opportunity = 70;
        intensity = 2;
        style = "playful";
    } else if (mood === "joking") {
        opportunity = 65;
        intensity = 2;
        style = "witty";
    } else if (mood === "casual") {
        opportunity = 50;
        intensity = 1;
        style = "confident";
    } else {
        // neutral
        opportunity = isQuestion ? 20 : 35;
        intensity = isQuestion ? 0 : 1;
        style = isQuestion ? "concise" : "normal";
    }

    // --- Achievement / brag detection boosts aura opportunity ---
    if (/\b(i (beat|won|passed|finished|got|nailed|aced)|finally|i did it)\b/i.test(message)) {
        opportunity = Math.max(opportunity, 75);
        intensity = Math.max(intensity, 2);
        style = "confident";
    }

    // --- Direct user commands override everything ---
    const cmd = message.toLowerCase();
    if (/\b(farm aura|more aura|lock in|cook)\b/.test(cmd)) {
        opportunity = 90; intensity = 3; style = "cinematic";
    }
    if (/\bless aura|stop farming|go normal|no aura\b/.test(cmd)) {
        opportunity = 5; intensity = 0; style = "normal"; slangIntensity = 0;
    }
    if (/\buse more gen ?z\b/.test(cmd)) slangIntensity = Math.min(4, slangIntensity + 2);
    if (/\bstop using slang\b/.test(cmd)) slangIntensity = 0;

    // --- Manual mode override ---
    if (controlMode === "NO_AURA") { opportunity = 0; intensity = 0; slangIntensity = 0; style = "normal"; }
    if (controlMode === "NORMAL") { opportunity = Math.min(opportunity, 20); intensity = Math.min(intensity, 1); }
    if (controlMode === "AURA") { intensity = Math.max(intensity, 1); }
    if (controlMode === "FARM") { opportunity = Math.max(opportunity, 60); intensity = Math.max(intensity, 2); }
    if (controlMode === "MAX_AURA") { opportunity = 95; intensity = 4; style = "cinematic"; }

    // --- Repetition risk (style repeated back-to-back) ---
    const styleStreak = memory.styleRepeatStreak(style);
    if (styleStreak >= 2) {
        cringeRiskBase += styleStreak * 15;
        intensity = Math.max(0, intensity - 1);
    }

    // --- Recent event density (too many "moments" recently = fatigue) ---
    if (memory.recentEventCount(5) >= 2) {
        opportunity -= 20;
        intensity = Math.max(0, intensity - 1);
    }

    // --- Slang density check (pre-emptive) ---
    const slangDensity = memory.slangDensityRecent(4);
    if (slangDensity >= 4) {
        slangIntensity = Math.max(0, slangIntensity - 2);
        cringeRiskBase += 20;
    }

    // --- Emoji density check ---
    const emojiDensity = memory.emojiDensityRecent(3);
    if (emojiDensity >= 3) {
        cringeRiskBase += 15;
    }

    opportunity = Math.max(0, Math.min(100, opportunity));
    intensity = Math.max(0, Math.min(4, intensity));
    slangIntensity = Math.max(0, Math.min(4, slangIntensity));
    cringeRiskBase = Math.max(0, Math.min(100, cringeRiskBase));

    // Final gate: even with opportunity, roll intensity down if cringe risk already high
    if (cringeRiskBase > 50) intensity = Math.max(0, intensity - 1);

    // --- HARD CAP: substantive/knowledge queries. This runs last and
    // cannot be overridden by mode, mood, or command detection above —
    // intelligence and accuracy take priority over personality. The one
    // exception is an explicit MAX_AURA mode override for pure banter,
    // but even then substantive queries stay capped because the user
    // still needs a real answer. ---
    let requiresSubstance = false;
    if (queryClass.isSubstantive) {
        requiresSubstance = true;
        intensity = Math.min(intensity, 1); // at most a light touch
        style = (style === "supportive") ? "supportive" : "concise";
        opportunity = Math.min(opportunity, 25);
        // slang stays whatever it was but response generator is told
        // explicitly below that correctness comes first regardless
    }

    return {
        opportunity,
        intensity,
        style,
        slangIntensity,
        cringeRiskBase,
        mood,
        requiresSubstance,
    };
}

// ---------- CRINGE DETECTOR (post-generation) ----------
// Analyzes the LLM's raw output text for forced-ness, returns adjusted risk + flags.
function runCringeCheck(responseText, engineDecision, memory) {
    let risk = engineDecision.cringeRiskBase;
    const flags = [];

    const slangMatches = responseText.match(SLANG_REGEX) || [];
    const emojiMatches = responseText.match(EMOJI_REGEX) || [];

    if (slangMatches.length >= 3) { risk += 25; flags.push("excessive_slang"); }
    if (emojiMatches.length >= 3) { risk += 25; flags.push("emoji_spam"); }

    // Substance check: if this was a knowledge/homework/code/math query,
    // a short, joke-only response is a failure mode worse than any slang
    // issue — the General AI Core didn't actually lead. Flag it hard.
    if (engineDecision.requiresSubstance) {
        const wordCount = responseText.trim().split(/\s+/).length;
        const looksLikeJokeOnly = wordCount < 12 && !/[.:]\s*\S+\s+\S+\s+\S+/.test(responseText);
        if (looksLikeJokeOnly) {
            risk += 40;
            flags.push("style_over_substance");
        }
    }
    if (/\baura\b/i.test(responseText) && !/\baura\b/i.test(memory._lastUserMessage || "")) {
        risk += 20; flags.push("announcing_aura");
    }
    if (/\+\d+\s*(aura)?/i.test(responseText)) { risk += 20; flags.push("fake_points_display"); }
    if (/sigma|gigachad|alpha male/i.test(responseText)) { risk += 30; flags.push("generic_sigma"); }

    // repeated phrase check against memory
    const sentences = responseText.split(/(?<=[.!?])\s+/).filter(s => s.length > 3);
    for (const s of sentences) {
        if (memory.phraseRepeatCount(s) >= 2) { risk += 20; flags.push("repeated_phrase"); break; }
    }

    risk = Math.max(0, Math.min(100, risk));
    return { risk, flags, needsRewrite: risk >= 55 };
}

// ---------- AURA SCORING + EVENTS ----------
function scoreAndEvent(engineDecision, cringeResult, memory) {
    let delta = 0;
    let event = null;

    if (cringeResult.needsRewrite) {
        delta = -Math.round(10 + cringeResult.risk / 5);
        event = { type: "AURA LOSS", detail: "Forced it a bit.", delta };
    } else if (engineDecision.intensity >= 3 && cringeResult.risk < 20) {
        delta = 15 + Math.round(Math.random() * 6);
        event = { type: "AURA MOMENT", detail: "Perfect timing.", delta };
    } else if (engineDecision.intensity === 0 && engineDecision.opportunity > 50) {
        // chose restraint despite opportunity
        delta = 8;
        event = { type: "CRINGE AVOIDED", detail: "Good restraint.", delta };
    } else if (engineDecision.intensity >= 1 && cringeResult.risk < 15) {
        delta = 5 + Math.round(Math.random() * 4);
        event = Math.random() < 0.25 ? { type: "CLEAN", detail: "Smooth.", delta } : null;
    } else if (cringeResult.risk >= 35) {
        delta = -6;
        event = null; // silent minor loss, not every dip needs a banner
    } else {
        delta = 2;
        event = null;
    }

    // Rarity control: don't show events too often
    if (event && memory.recentEventCount(3) >= 1 && event.type !== "AURA LOSS") {
        event = null; // suppress to avoid event spam
    }

    memory.recordEvent(event ? event.type : "silent", delta);

    return { delta, event, newScore: memory.auraScore };
}

// ---------- STYLE GUIDANCE FOR PROMPT ----------
const STYLE_GUIDANCE = {
    normal: "Respond plainly and helpfully. No personality flourish needed.",
    witty: "One sharp, clever observation. Dry humor. No explanation of the joke.",
    confident: "Short, composed, self-assured. State things plainly, no hedging.",
    playful: "Light, warm energy matching their excitement, but not over the top.",
    deadpan: "Flat, understated delivery. The humor is in the lack of reaction.",
    concise: "Answer directly and efficiently. Minimal words, maximum clarity.",
    cinematic: "One rare, perfectly-timed, memorable line. Use sparingly — this is a big moment.",
    supportive: "Warm, steady, genuinely present. No jokes. No performance.",
    chaotic: "Slightly unpredictable, high energy, but still coherent and useful.",
    "skill-based": "Demonstrate competence directly — the skill itself is the aura.",
    restraint: "Say as little as possible while still being complete. Silence is the flex.",
};

function slangGuidance(level) {
    const map = {
        0: "Do not use any slang or internet speak. Plain natural English.",
        1: "At most one light, natural slang word if it truly fits. Otherwise none.",
        2: "Natural Gen Z language is fine if it fits the moment — used sparingly, never stacked.",
        3: "More casual internet tone allowed, but still never more than one or two slang terms per message.",
        4: "Heavy internet/Gen Z voice allowed, but must stay coherent — never a wall of slang or emoji spam.",
    };
    return map[level] ?? map[1];
}

export {
    AuraMemory,
    detectMood,
    runAuraEngine,
    runCringeCheck,
    scoreAndEvent,
    classifyQuery,
    STYLE_GUIDANCE,
    slangGuidance,
    SLANG_REGEX,
    EMOJI_REGEX,
};
