// Aura AI — components.js
// Structured response components. Today this is exactly one component
// type — the interactive quiz — but the machinery is deliberately shaped
// as a generic "components" pipeline so future component types (polls,
// code runners, etc.) can slot in without restructuring the chat response.
//
// How it works:
//   1. server.js appends QUIZ_SYSTEM_PROMPT_APPENDIX to the system prompt
//      it sends to the provider. The appendix instructs the model: when
//      the user asks for a quiz, emit the ENTIRE quiz as a single JSON
//      object inside a fenced code block whose language tag is `quiz`:
//
//        ```quiz
//        {"type":"quiz","title":"...","questions":[...]}
//        ```
//
//      For every other kind of request the model responds normally, and
//      no ```quiz block appears — so plain chat is completely unchanged.
//   2. After the provider responds, server.js runs extractComponents()
//      over the raw text. It pulls out any ```quiz blocks, validates and
//      normalizes each one into a well-formed component, strips the
//      blocks out of the text shown to the user, and returns the rest as
//      the chat bubble content.
//   3. FALLBACK FOR PLAIN-TEXT QUIZZES: models frequently ignore the
//      fence instruction and write a perfectly good multiple-choice quiz
//      as plain text (numbered questions, a/b/c/d options, an Answers
//      key). When NO structured component was found AND the user's last
//      message clearly asked for an interactive quiz/test, parsePlainTextQuiz()
//      converts that obvious quiz into the exact same component schema.
//      This is deliberately double-gated (clear quiz intent + extractable
//      quiz structure) so normal numbered-list prose is never converted.
//   4. The /api/chat response then carries `components: [...]` (an empty
//      array when the model produced none), and the frontend renders any
//      quiz components as an interactive card below the message text.
//
// This module is provider-agnostic: the appendix is just text appended to
// the system prompt, and the parser only ever looks at the final response
// text — so it works identically whether Gemini or Mistral served the
// request, and it never touches either provider's API.

// The exact quiz JSON shape the model is asked to produce:
//   {
//     "type": "quiz",
//     "title": "Space Quiz",
//     "questions": [
//       {
//         "question": "What is the largest planet in our solar system?",
//         "options": ["Earth", "Jupiter", "Saturn", "Mars"],
//         "answer": 1,                          // 0-based index into options
//         "explanation": "Jupiter is the largest..."   // optional
//       }
//     ]
//   }

const QUIZ_SYSTEM_PROMPT_APPENDIX = `

=== QUIZ COMPONENT FORMAT ===
If the user asks you to create a quiz (multiple-choice questions), output the ENTIRE quiz as a single JSON object inside a fenced code block whose language tag is exactly "quiz" — and do not put anything else inside that block. Use this exact shape:

\`\`\`quiz
{"type":"quiz","title":"A short title for the quiz","questions":[{"question":"The question text","options":["option A","option B","option C","option D"],"answer":0,"explanation":"A one-line explanation of the correct answer"}]}
\`\`\`

Rules:
- A quiz means MULTIPLE-CHOICE questions: every question must have 4 options (A-D), and "answer" is the 0-based index of the correct option (0 = first option).
- NEVER respond to a quiz request with a plain-text numbered list of questions and answers. Quiz requests MUST use the component block above — the block is the entire quiz.
- "explanation" is optional but encouraged.
- If the user asks for a specific number of questions (e.g. "5-question quiz"), provide exactly that many.
- You may write a one-line intro before the block and/or a one-line outro after it, but keep them brief and never put quiz content outside the block.
- For ANY request that is not a quiz, respond normally with no \`\`\`quiz block at all.
`;

// Matches ```quiz ... ``` fences (case-insensitive language tag).
const QUIZ_FENCE_RE = /```quiz\s*([\s\S]*?)```/gi;

// ---- QUIZ INTENT DETECTION -------------------------------------------
// Phrases that clearly ask for an interactive quiz/test. Deliberately
// narrow: bare "test" alone (test my patience, test the server) is NOT a
// quiz request. Used only as the FIRST gate of the plain-text fallback —
// the second gate is whether the response actually contains extractable
// quiz structure, so prose can never be converted even when intent matches.
const QUIZ_INTENT_PATTERNS = [
  /\bquiz(zes|zing|zed|master)?\b/i,
  /\btrivia\b/i,
  /\bmcq\b/i,
  /multiple[-\s]?choice/i,
  /\bquestionnaire\b/i,
  /\btest\s+me\s+(on|about)\b/i,
  /\btest\s+my\s+knowledge\b/i,
  /\bflash[-\s]?cards?\b/i,
];

function isQuizRequest(userText) {
  if (typeof userText !== 'string') return false;
  return QUIZ_INTENT_PATTERNS.some(re => re.test(userText));
}

// ---- PLAIN-TEXT QUIZ NORMALIZATION (the fallback) --------------------
// Converts an obvious plain-text multiple-choice quiz into the quiz
// component schema. Supported shapes:
//
//   Format 1 (options as lines under each question):
//     Space Quiz
//     1. What gives Mars its reddish color?
//        a) Iron oxide
//        b) Water ice
//        ...
//     2. ...
//     Answers:
//     1. a
//     2. b
//
//   Format 2 (options inline on the question line):
//     1. What is 2+2? (a) 3 (b) 4 (c) 5 (d) 6
//     2. What is 10/2? a) 4 b) 5 c) 6 d) 8
//     Answers: 1. b 2. c
//
//   Answers may be letters (a-d) or the option text itself; a per-question
//   "Answer: X" line inside a question body is also accepted.
//
// Returns { component, text } where `text` is the response with the quiz
// portion stripped (intro prose only), or null when the response doesn't
// contain enough extractable quiz structure to convert safely.

const OPTION_LINE_RE = /^\(?([a-dA-D])\)?[.)]\s+(.+)$/;
const INLINE_PAREN_RE = /\(([a-dA-D])\)\s*([^()]{1,80}?)(?=\s*\([a-dA-D]\)|$)/g;
const INLINE_LETTER_RE = /(?:^|\s)\(?([a-dA-D])\)?[.)]\s+([^()]{1,80}?)(?=\s+\(?[a-dA-D]\)?[.)]\s|$)/g;
const QUESTION_LINE_RE = /^(\d{1,3})[.)]\s+(.+)$/;
// An answers-block header must be the header alone ("Answers:",
// "Answer Key:") or followed by entries starting with a digit ("Answers:
// 1. a 2. b") — a per-question "Answer: b" line is deliberately NOT a
// block header (without the end anchor this would swallow it).
const ANSWER_BLOCK_RE = /^(answers?|answer\s+key|solutions?)\s*:?\s*(\d|\s*$)/i;
const ANSWER_ENTRY_RE = /(\d{1,3})\s*[.)-]\s*\(?([a-dA-D])\)?|(\d{1,3})\s*[.)-]\s*([^,;]+?)(?=\s+\d{1,3}\s*[.)-]\s|$)/g;
const PER_QUESTION_ANSWER_RE = /^answer\s*:?\s*\(?([a-dA-D])\)?\s*$/i;

function parsePlainTextQuiz(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const rawLines = text.split(/\r?\n/);
  const lines = rawLines.map(l => l.trim());

  // Locate the answers/answer-key block, if any.
  let answerBlockIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (ANSWER_BLOCK_RE.test(lines[i])) { answerBlockIdx = i; break; }
  }
  const questionRegionEnd = answerBlockIdx === -1 ? lines.length : answerBlockIdx;

  // Find numbered question lines in the region before the answer block.
  const questionStarts = [];
  for (let i = 0; i < questionRegionEnd; i++) {
    if (QUESTION_LINE_RE.test(lines[i])) questionStarts.push(i);
  }
  if (questionStarts.length === 0) return null;

  // Build the answer lookup (displayed number -> answer token), from both
  // a trailing answers block and per-question "Answer:" lines.
  const answersByNumber = new Map();
  if (answerBlockIdx !== -1) {
    const answerRegion = lines.slice(answerBlockIdx).join(' ');
    let m;
    ANSWER_ENTRY_RE.lastIndex = 0;
    while ((m = ANSWER_ENTRY_RE.exec(answerRegion)) !== null) {
      if (m[1] !== undefined) answersByNumber.set(parseInt(m[1], 10), m[2]);
      else if (m[3] !== undefined) answersByNumber.set(parseInt(m[3], 10), m[4]);
    }
  }

  const questions = [];
  for (let qi = 0; qi < questionStarts.length; qi++) {
    const lineIdx = questionStarts[qi];
    const numMatch = QUESTION_LINE_RE.exec(lines[lineIdx]);
    const displayNum = parseInt(numMatch[1], 10);
    let questionText = numMatch[2].trim();

    const bodyEnd = qi + 1 < questionStarts.length ? questionStarts[qi + 1] : questionRegionEnd;
    const body = lines.slice(lineIdx + 1, bodyEnd);

    // Per-question "Answer: X" — either trailing the question line itself
    // ("... (d) 6 Answer: b") or on its own line inside the body. Stripped
    // from the question text so it can't confuse option extraction.
    let perQuestionAnswer = null;
    const trailingAnswer = /\banswer\s*:?\s*\(?([a-dA-D])\)?\s*$/i.exec(questionText);
    if (trailingAnswer) {
      perQuestionAnswer = trailingAnswer[1];
      questionText = questionText.slice(0, trailingAnswer.index).trim();
    }
    if (!perQuestionAnswer) {
      for (const bl of body) {
        const pm = PER_QUESTION_ANSWER_RE.exec(bl);
        if (pm) { perQuestionAnswer = pm[1]; break; }
      }
    }

    // Extract options — preference: inline parenthesized, body option
    // lines, then inline letter style on the question line.
    let options = [];
    let questionOnly = questionText;

    // (a) inline parenthesized: "(a) X (b) Y ..." — accepted only when
    // the matched options run to the END of the line (so prose like
    // "...because (b) is correct" can't be misread as an option list).
    const parenMatches = [];
    let pm2;
    INLINE_PAREN_RE.lastIndex = 0;
    while ((pm2 = INLINE_PAREN_RE.exec(questionText)) !== null) parenMatches.push(pm2);
    if (parenMatches.length >= 2) {
      const lastEnd = parenMatches[parenMatches.length - 1].index + parenMatches[parenMatches.length - 1][0].length;
      if (questionText.slice(lastEnd).trim() === '') {
        options = parenMatches.map(p => ({ letter: p[1].toUpperCase(), text: p[2].trim() }));
        questionOnly = questionText.slice(0, parenMatches[0].index).trim();
      }
    }

    // (b) body option lines: "a) X" / "b) Y" on their own lines.
    if (options.length < 2) {
      const bodyOptions = [];
      for (const bl of body) {
        const om = OPTION_LINE_RE.exec(bl);
        if (om) bodyOptions.push({ letter: om[1].toUpperCase(), text: om[2].trim() });
      }
      if (bodyOptions.length >= 2) options = bodyOptions;
    }

    // (c) inline letter style: "a) X b) Y c) Z d) W" on the question line.
    if (options.length < 2) {
      const letterMatches = [];
      let lm;
      INLINE_LETTER_RE.lastIndex = 0;
      while ((lm = INLINE_LETTER_RE.exec(questionText)) !== null) letterMatches.push(lm);
      if (letterMatches.length >= 2) {
        const lastEnd = letterMatches[letterMatches.length - 1].index + letterMatches[letterMatches.length - 1][0].length;
        if (questionText.slice(lastEnd).trim() === '') {
          options = letterMatches.map(l => ({ letter: l[1].toUpperCase(), text: l[2].trim() }));
          questionOnly = questionText.slice(0, letterMatches[0].index).trim();
        }
      }
    }

    // Options must be ordered by letter and have >= 2 entries.
    const letterOrder = { A: 0, B: 1, C: 2, D: 3, E: 4, F: 5 };
    options.sort((x, y) => (letterOrder[x.letter] ?? 99) - (letterOrder[y.letter] ?? 99));
    const optionTexts = options.filter(o => o.text).map(o => o.text);
    if (optionTexts.length < 2) continue;
    const cleanOptions = optionTexts.map(t => t.replace(/[.,;:]+$/, '').trim()).filter(Boolean);

    // Resolve the answer token to an option index.
    let answerToken = answersByNumber.get(displayNum) || perQuestionAnswer || null;
    if (answerToken === null) continue;
    answerToken = String(answerToken).trim();
    let answerIdx = -1;
    if (/^[a-dA-D]$/.test(answerToken)) {
      answerIdx = answerToken.toUpperCase().charCodeAt(0) - 65;
    } else {
      // Text answer — match against options (case-insensitive, tolerant).
      const lower = answerToken.toLowerCase();
      for (let oi = 0; oi < cleanOptions.length; oi++) {
        const optLower = cleanOptions[oi].toLowerCase();
        if (optLower === lower || optLower.startsWith(lower) || lower.startsWith(optLower)) { answerIdx = oi; break; }
      }
    }
    if (answerIdx < 0 || answerIdx >= cleanOptions.length) continue;

    questions.push({
      question: questionOnly,
      options: cleanOptions,
      answer: answerIdx,
      explanation: '',
    });
  }

  if (questions.length === 0) return null;

  // Title: first non-empty, non-question, non-answer line before the first
  // question, if it looks like a header (short, no sentence punctuation).
  let title = 'Quiz';
  const firstQuestionIdx = questionStarts[0];
  for (let i = 0; i < firstQuestionIdx; i++) {
    const l = lines[i];
    if (!l || ANSWER_BLOCK_RE.test(l)) continue;
    if (l.length <= 60 && !/[.!?]\s*$/.test(l)) { title = l; break; }
  }

  // Remaining text = intro prose before the first question, minus the
  // title line (the title lives in the component card now).
  const introLines = lines.slice(0, firstQuestionIdx).filter(l => l && l !== title && !ANSWER_BLOCK_RE.test(l));
  const introText = introLines.join(' ').trim();

  return {
    component: { type: 'quiz', title, questions },
    text: introText,
  };
}

// Pull the first JSON object out of a raw string by locating the first
// "{" and the last "}" — robust against stray prose or markdown the model
// may have wrapped the JSON in. Returns the parsed object or null.
function extractJson(raw) {
  if (typeof raw !== 'string') return null;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

// Validate + normalize a raw parsed object into a well-formed quiz
// component. Returns null (dropping the component) if it doesn't match
// the expected shape. Individual bad questions are dropped while keeping
// the rest, so a partially-malformed model output still yields a usable
// quiz rather than nothing at all.
function normalizeQuiz(obj) {
  if (!obj || typeof obj !== 'object' || obj.type !== 'quiz') return null;
  if (!Array.isArray(obj.questions) || obj.questions.length === 0) return null;

  const questions = [];
  for (const q of obj.questions) {
    if (!q || typeof q !== 'object') continue;
    const question = typeof q.question === 'string' ? q.question.trim() : '';
    if (!question) continue;

    const options = Array.isArray(q.options)
      ? q.options.filter(o => typeof o === 'string' && o.trim().length > 0).map(o => o.trim())
      : [];
    if (options.length < 2) continue;

    let answer = -1;
    if (Number.isInteger(q.answer)) answer = q.answer;
    else if (typeof q.answer === 'string' && q.answer.trim() !== '' && Number.isInteger(Number(q.answer))) {
      answer = Number(q.answer);
    }
    if (answer < 0 || answer >= options.length) continue;

    questions.push({
      question,
      options,
      answer,
      explanation: typeof q.explanation === 'string' ? q.explanation.trim() : '',
    });
  }

  if (questions.length === 0) return null;

  return {
    type: 'quiz',
    title: typeof obj.title === 'string' && obj.title.trim() ? obj.title.trim() : 'Quiz',
    questions,
  };
}

// Scan provider response text for quiz components. Returns
//   { text: the original text with all ```quiz blocks stripped, components: [...] }
// `components` is always an array (empty when the model produced no quiz).
// If the whole response is a bare JSON quiz object with no fence (models
// sometimes drop the fence despite instructions), that's accepted too —
// but only when it validates as a real quiz, so normal JSON-ish answers
// are never misclassified.
function parseQuizComponents(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return { text: text || '', components: [] };
  }

  const components = [];
  const fences = [...text.matchAll(QUIZ_FENCE_RE)];

  if (fences.length > 0) {
    for (const m of fences) {
      const quiz = normalizeQuiz(extractJson(m[1]));
      if (quiz) components.push(quiz);
    }
    const cleaned = text.replace(QUIZ_FENCE_RE, '').replace(/\n{3,}/g, '\n\n').trim();
    return { text: cleaned, components };
  }

  // Lenient fallback: no fence found — try the whole response as a bare
  // JSON quiz object.
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    const quiz = normalizeQuiz(extractJson(trimmed));
    if (quiz) {
      return { text: '', components: [quiz] };
    }
  }

  return { text, components };
}

// THE single entry point used by server.js's /api/chat route:
// 1. Try the structured path (```quiz fences / bare JSON).
// 2. If nothing was found AND the user's last message clearly asked for
//    an interactive quiz/test, try converting an obvious plain-text quiz
//    into the same schema.
// Returns { text, components } — text is what the chat bubble shows,
// components is what the frontend renders as interactive cards.
function extractComponents(providerText, lastUserMessage) {
  const parsed = parseQuizComponents(providerText);
  if (parsed.components.length > 0) return parsed;

  if (isQuizRequest(lastUserMessage)) {
    const converted = parsePlainTextQuiz(providerText);
    if (converted) {
      return { text: converted.text, components: [converted.component] };
    }
  }

  return parsed; // { text: providerText, components: [] } — plain chat
}

module.exports = {
  QUIZ_SYSTEM_PROMPT_APPENDIX,
  isQuizRequest,
  parsePlainTextQuiz,
  parseQuizComponents,
  extractComponents,
  normalizeQuiz,
};
