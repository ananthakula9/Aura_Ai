// Aura AI — public/components.js
// Frontend renderers for the structured `components` array returned by
// /api/chat. Currently one component type: the interactive quiz card.
// Imported by app.js; every AI-provided string rendered here is escaped
// (treated as untrusted content like any other model output).

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Build a paginated interactive quiz card for a
// { type: 'quiz', title, questions } component:
//   - one question at a time, with Back / Next navigation
//   - progress label ("Question 2 of 5") + progress bar
//   - select an answer per question; Submit enabled once all are answered
//   - after submit: score, correct/wrong highlighting, per-question
//     feedback + explanation while reviewing, and Retry to start over.
function buildQuizCard(quiz) {
  const questions = Array.isArray(quiz.questions) ? quiz.questions : [];
  if (questions.length === 0) return null;

  const total = questions.length;
  const selections = questions.map(() => -1);
  let current = 0;
  let submitted = false;

  const card = document.createElement('div');
  card.className = 'quiz-card';

  card.innerHTML = `
    <div class="quiz-card-head">
      <span class="quiz-badge">Quiz</span>
      <span class="quiz-title">${escapeHtml(quiz.title || 'Quiz')}</span>
      <span class="quiz-score" data-role="score" hidden></span>
    </div>
    <div class="quiz-progress">
      <span class="quiz-progress-label" data-role="progress"></span>
      <div class="quiz-progress-bar"><div class="quiz-progress-fill" data-role="fill"></div></div>
    </div>
    <div class="quiz-body" data-role="body"></div>
    <div class="quiz-actions">
      <button type="button" class="quiz-nav-btn" data-role="back">Back</button>
      <button type="button" class="quiz-nav-btn" data-role="next">Next</button>
      <button type="button" class="quiz-submit-btn" data-role="submit">Submit</button>
      <button type="button" class="quiz-reset-btn" data-role="retry" hidden>Retry</button>
    </div>`;

  const body = card.querySelector('[data-role="body"]');
  const progressLabel = card.querySelector('[data-role="progress"]');
  const fill = card.querySelector('[data-role="fill"]');
  const scoreEl = card.querySelector('[data-role="score"]');
  const backBtn = card.querySelector('[data-role="back"]');
  const nextBtn = card.querySelector('[data-role="next"]');
  const submitBtn = card.querySelector('[data-role="submit"]');
  const retryBtn = card.querySelector('[data-role="retry"]');

  function answeredCount() {
    return selections.filter(s => s !== -1).length;
  }

  function render() {
    const q = questions[current];

    progressLabel.textContent = `Question ${current + 1} of ${total}`;
    fill.style.width = `${((current + 1) / total) * 100}%`;

    const optionsHtml = q.options.map((opt, oi) => {
      let cls = 'quiz-option';
      if (submitted) {
        if (oi === q.answer) cls += ' correct';
        else if (selections[current] === oi) cls += ' wrong';
      } else if (selections[current] === oi) {
        cls += ' selected';
      }
      return `
        <button type="button" class="${cls}" data-opt="${oi}" ${submitted ? 'disabled' : ''}>
          <span class="quiz-opt-letter">${String.fromCharCode(65 + oi)}</span>
          <span class="quiz-opt-text">${escapeHtml(opt)}</span>
        </button>`;
    }).join('');

    let feedbackHtml = '';
    if (submitted) {
      const correctOpt = q.options[q.answer] || '';
      const wasRight = selections[current] === q.answer;
      const expl = q.explanation ? `<br>${escapeHtml(q.explanation)}` : '';
      feedbackHtml = `
        <div class="quiz-feedback">
          <span class="quiz-fb-icon ${wasRight ? 'ok' : 'no'}">${wasRight ? '✓' : '✗'}</span>
          <span><b>${wasRight ? 'Correct' : 'Correct answer'}: ${String.fromCharCode(65 + q.answer)}. ${escapeHtml(correctOpt)}</b>${expl}</span>
        </div>`;
    }

    body.innerHTML = `
      <div class="quiz-q-head">
        <span class="quiz-q-num">${current + 1}</span>
        <span class="quiz-q-text">${escapeHtml(q.question)}</span>
      </div>
      <div class="quiz-opts">${optionsHtml}</div>
      ${feedbackHtml}`;

    const onLast = current === total - 1;
    backBtn.disabled = current === 0;
    // Pre-submit: Next until the last question, then Submit. Post-submit:
    // Submit is replaced by Retry, and Next/Back become review navigation.
    nextBtn.hidden = onLast;
    submitBtn.hidden = !onLast || submitted;
    retryBtn.hidden = !submitted;
    const allAnswered = answeredCount() === total;
    submitBtn.disabled = !allAnswered;
    submitBtn.title = allAnswered ? 'Submit quiz' : `Answer all ${total} questions to submit`;
  }

  body.addEventListener('click', (e) => {
    const btn = e.target.closest('.quiz-option');
    if (!btn || submitted) return;
    selections[current] = Number(btn.dataset.opt);
    render();
  });

  backBtn.addEventListener('click', () => {
    if (current > 0) { current--; render(); }
  });

  nextBtn.addEventListener('click', () => {
    if (current < total - 1) { current++; render(); }
  });

  submitBtn.addEventListener('click', () => {
    if (answeredCount() !== total) return; // also guarded by disabled attr
    submitted = true;
    const score = questions.reduce((acc, q, qi) => acc + (selections[qi] === q.answer ? 1 : 0), 0);
    scoreEl.hidden = false;
    scoreEl.textContent = `${score} / ${total}`;
    render();
  });

  retryBtn.addEventListener('click', () => {
    submitted = false;
    selections.fill(-1);
    current = 0;
    scoreEl.hidden = true;
    render();
  });

  render();
  return card;
}

export { buildQuizCard };
