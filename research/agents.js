// Aura AI — research/agents.js  (V2)
// The multi-agent layer: a deterministic Intent Analyzer, a registry of
// specialist agents, and the Agent Orchestrator's selection rules that
// decide which agents actually run for a given request (never all of them).
//
// Everything here is deterministic — no model calls — so agent selection,
// complexity classification and provider routing are testable, explainable
// ("why did Academic run? because the query was classified scientific"),
// and cheap. The model-backed agents themselves live in engine.js and are
// invoked according to this plan.

// ============================================================
// INTENT ANALYZER
// Classifies a research request along three axes:
//   complexity: simple | moderate | complex | investigative
//   topicType:  tech|science|business|markets|policy|regulation|education|
//               history|news|general
//   recency:    current|historical|scientific|evergreen
// Plus the recommended search providers, in priority order.
// ============================================================
const COMPLEXITY_RULES = [
  { complexity: 'investigative', test: (q, signals) =>
    signals.entities >= 4 || (signals.entities >= 3 && signals.wantsCompare) ||
    /\binvestigat\w*|\bcomprehensive\b|\bexhaustive\b|\bdeep(ly)?\b|\bthorough\b/i.test(q) },
  { complexity: 'complex', test: (q, signals) =>
    signals.entities >= 2 || signals.wantsCompare ||
    q.split(/[.?;\n]/).filter(s => s.trim().split(/\s+/).length > 5).length >= 3 ||
    /\bfuture of\b|\btrajectory\b|\btrends?\b|\bstate of\b|\bacross\b|\bglobal\b/i.test(q) },
  { complexity: 'moderate', test: (q) => q.trim().split(/\s+/).length >= 8 || /\bwhy\b|\bhow\b|\bexplain\b|\bimpact\b/i.test(q) },
];

const TOPIC_RULES = [
  { topicType: 'science',    recency: 'scientific', re: /\bscience|\bscientific|\bresearch paper|\bstudy|\bstudies|\btheory|\bhypothes|\bexperiment|\bphysics|\bbiology|\bchemistr|\bmedicine|\bclinical|\bgenome|\bquantum\b/i,
    providers: ['academic', 'general', 'government'] },
  { topicType: 'regulation', recency: 'current', re: /\bregulat\w*|\blaw\b|\blegisl\w*|\bact\b|\bcompliance\b|\bpolicy\b|\bgovernance\b|\brule\b|\bdirective\b|\bban\b/i,
    providers: ['government', 'news', 'general', 'academic'] },
  { topicType: 'policy',     recency: 'current', re: /\bpolicy\b|\bgovernment\b|\belection|\bgeopolit|\bsanction|\btreaty|\bdiplomat/i,
    providers: ['government', 'news', 'academic'] },
  { topicType: 'markets',    recency: 'current', re: /\bmarket\b|\bstock|\bprice[s]?\b|\bvaluation|\brevenue|\beconomy|\binflation|\bgdp\b|\bforecast|\binvest/i,
    providers: ['news', 'general', 'government'] },
  { topicType: 'business',   recency: 'current', re: /\bcompany|\bcompanies|\bindustry|\benterprise|\bstartup|\bproduct|\bcompetitor|\bbusiness|\bcustomers?\b/i,
    providers: ['company', 'news', 'general'] },
  { topicType: 'tech',       recency: 'current', re: /\btechnology|\bsoftware|\bhardware|\bcpu|\bgpu\b|\bchip|\bmodel\b|\bai\b|\bllm\b|\bapi\b|\bframework|\bprogramming|\bdeveloper/i,
    providers: ['general', 'company', 'academic', 'news'] },
  { topicType: 'history',    recency: 'historical', re: /\bhistory|\bhistorical|\bcentury|\bwar\b|\bancient|\bmedieval|\borigin[s]?\b of|\bpast\b/i,
    providers: ['academic', 'general', 'government'] },
  { topicType: 'education',  recency: 'evergreen', re: /\beducation|\bstudents?\b|\bcurriculum|\bteaching|\bschool|\buniversity|\blearning outcomes/i,
    providers: ['academic', 'general', 'government'] },
  { topicType: 'news',       recency: 'current', re: /\blatest\b|\bthis (week|month|year)\b|\bbreaking|\bjust announced|\brecent(ly)?\b|\bcurrent(ly)?\b/i,
    providers: ['news', 'general'] },
];

const DEFAULT_TOPIC = { topicType: 'general', recency: 'current', providers: ['general', 'news', 'academic'] };

// The named entities we count for complexity: multi-word proper nouns +
// region/jurisdiction names. Rough by design — it only feeds a 4-bucket
// classification, not a precision tool.
const KNOWN_REGIONS = /\b(eu|europe|european union|usa|us|u\.s\.|united states|america|india|uk|united kingdom|britain|china|japan|germany|france|brazil|canada|australia|africa|asia|russia|singapore|korea)\b/gi;

function analyzeIntent(query) {
  const q = String(query || '');
  const lower = q.toLowerCase();

  const regions = q.match(KNOWN_REGIONS) || [];
  const properNouns = q.match(/\b[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)+\b/g) || [];
  const acronyms = q.match(/\b[A-Z]{2,6}\b/g) || [];
  const entities = new Set([
    ...regions.map(r => r.toLowerCase()),
    ...properNouns.map(r => r.toLowerCase()),
    ...acronyms.map(r => r.toLowerCase()),
  ]).size;

  const signals = {
    entities,
    wantsCompare: /\bcompar\w*|\bversus\b|\bvs\.?\b|\bdiffer\w*|\bcontrast/i.test(lower),
    wantsTimeline: /\btimeline|\bdates?\b|\bwhen\b|\bhistory|\bschedule|\brollout|\bdeadline/i.test(lower),
    wantsData: /\bdata|\bstatistic|\bnumbers?\b|\bpercent|\bfigures|\bchart|\btable|\bgrowth|\brate\b/i.test(lower),
  };

  let complexity = 'simple';
  for (const rule of COMPLEXITY_RULES) {
    if (rule.test(q, signals)) { complexity = rule.complexity; break; }
  }

  const topic = TOPIC_RULES.find(t => t.re.test(q)) || DEFAULT_TOPIC;

  return {
    complexity,                        // simple|moderate|complex|investigative
    topicType: topic.topicType,        // tech|science|business|markets|policy|regulation|education|history|news|general
    recency: topic.recency,            // current|historical|scientific|evergreen
    providers: topic.providers.slice(0, 3),
    signals,
  };
}

// Complexity → concrete auto-configuration of the run.
const COMPLEXITY_CONFIG = {
  simple:       { mode: 'quick',    questionCap: 3, concurrency: 1, verification: 'key',  adaptive: false, challengeHint: false },
  moderate:     { mode: 'standard', questionCap: 5, concurrency: 2, verification: 'key',  adaptive: false, challengeHint: false },
  complex:      { mode: 'deep',     questionCap: 8, concurrency: 3, verification: 'key',  adaptive: true,  challengeHint: true },
  investigative:{ mode: 'maximum',  questionCap: 12, concurrency: 3, verification: 'all', adaptive: true,  challengeHint: true },
};

// ============================================================
// AGENT REGISTRY
// Every specialist the orchestrator can dispatch. `phases` maps to engine
// execution stages; selection rules say when each runs.
// ============================================================
const AGENTS = {
  intent:        { label: 'Intent Analyzer',        model: false, always: true,
                   role: 'Classify complexity, topic type, recency context, and providers.' },
  planner:       { label: 'Research Planner',       model: true,  always: true,
                   role: 'Decompose the request into an editable question plan with scope.' },
  discovery:     { label: 'Discovery Agent',        model: false, always: true,
                   role: 'Find candidate sources via the selected search providers.' },
  primarySource: { label: 'Primary Source Agent',   model: false, when: (plan) => plan.providers.includes('government') || plan.topicType === 'regulation' || plan.topicType === 'policy',
                   role: 'Steer toward official documents, datasets, and first-party material.' },
  academic:      { label: 'Academic Agent',         model: false, when: (plan) => plan.providers.includes('academic'),
                   role: 'Search scholarly and scientific evidence.' },
  industry:      { label: 'Industry Agent',         model: false, when: (plan) => ['business', 'markets', 'tech'].includes(plan.topicType),
                   role: 'Investigate companies, markets, product and industry reporting.' },
  reader:        { label: 'Source Reader',          model: false, always: true,
                   role: 'Open pages and extract readable text (SSRF-guarded fetch).' },
  evidence:      { label: 'Evidence Agent',         model: true,  always: true,
                   role: 'Extract claims, numbers, dates, quotes, and definitions with exact passages.' },
  verification:  { label: 'Verification Agent',     model: true,  when: (plan) => plan.verification !== 'none',
                   role: 'Cross-check claims against their evidence and independent sources.' },
  contradiction: { label: 'Contradiction Agent',   model: false, always: true,
                   role: 'Detect conflicting figures deterministically; investigate causes.' },
  dataAnalyst:   { label: 'Data Analyst Agent',     model: false, when: (plan) => plan.hasDatasets || plan.signals.wantsData,
                   role: 'Deterministic dataset statistics, trends, outliers, and chart specs.' },
  synthesis:     { label: 'Synthesis Agent',        model: true,  always: true,
                   role: 'Combine evidence into findings labeled fact/analysis/inference with confidence.' },
  report:        { label: 'Report Agent',           model: true,  always: true,
                   role: 'Write the sectioned, cited report.' },
  quality:       { label: 'Quality Agent',          model: false, always: true,
                   role: 'Transparent quality scoring + revision triggers.' },
  challenge:     { label: 'Challenge Agent',        model: true,  when: (plan) => Boolean(plan.challenge), // user-invoked
                   role: 'Adversarially test conclusions with opposing evidence.' },
};

// The orchestrator's selection: returns the agent list a session will run,
// in execution order, with the reasons (surfaced in the UI's agent view).
function selectAgents(intentPlan) {
  const selected = [];
  for (const [key, agent] of Object.entries(AGENTS)) {
    const runs = agent.always || (agent.when && agent.when(intentPlan));
    if (runs) selected.push({ key, label: agent.label, role: agent.role, modelBacked: Boolean(agent.model) });
  }
  return selected;
}

module.exports = {
  analyzeIntent,
  COMPLEXITY_CONFIG,
  AGENTS,
  selectAgents,
};
