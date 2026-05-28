// AI relationship: the style with which the candidate works with the model.
//
// One continuous axis with two poles:
//   - "directing": you treat the model like a careful junior. Prompts are
//     long, structured, with file paths, numbered steps, acceptance criteria.
//   - "co-thinking": you think out loud with the model. Prompts are short,
//     conversational, full of open questions ("what if", "cosa pensi"),
//     letting the model push back and shape the problem.
//
// Few people sit at one pole. Most are a balanced mix and switch mode by
// context (e.g. directing on security and data, co-thinking on UI and ideas).
// Co-construction — using the model to define the problem rather than just
// execute it — lives naturally in the middle of the axis, no third bucket.
//
// Anti-leak: the same system-injected prompts (compaction, task-notifications)
// excluded elsewhere are excluded here too.

const SYSTEM_PROMPT_RE = /^(<task-notification>|Your task is to create a detailed summary of the conversation|This session is being continued from a previous conversation)/i;

const DIRECTING_PATTERNS = [
  /(^|\n)\s*\d+\.\s/, // numbered list item
  /(^|\n)\s*-\s+\[.\]/, // checkbox
  /\b(step|fase)\s*\d/i,
  /\/Users|file_path|\.tsx?|\.mjs|\.sql\b|\.md\b/i, // file references
  /\b(acceptance|criteria|requirements|spec|verify|verifica|must|should|deve|devi)\b/i,
  /\b(do not|don't|never|exclude|only|exactly|esattamente)\b/i, // hard constraints
];

const CO_THINKING_PATTERNS = [
  /\?/,
  /\b(why|how come|what if|secondo te|cosa pensi|cosa ne pensi|thoughts|you think|insieme|pensiamo|capiamo|capire|esplorare|secondo me|ti sembra|ti torna|che ne dici|mi serve capire|chiaro\?)\b/i,
  /\b(vai|fai|dimmi|continua|prosegui|ok\b)\b/i, // short delegations of trust
  /^[a-zàèéìòù]/, // starts lowercase (informal)
];

function scorePrompt(text) {
  if (!text) return null;
  const t = text.trim();
  if (!t || SYSTEM_PROMPT_RE.test(t)) return null;
  const words = t.split(/\s+/).length;
  let direct = 0;
  let coThink = 0;
  for (const r of DIRECTING_PATTERNS) if (r.test(t)) direct++;
  for (const r of CO_THINKING_PATTERNS) if (r.test(t)) coThink++;
  // Length signal — long prompts skew directing, very short skew co-thinking.
  if (words >= 80) direct += 2;
  else if (words >= 30) direct += 1;
  if (words <= 8) coThink += 2;
  else if (words <= 16) coThink += 1;
  return { direct, coThink, words, text: t };
}

export function computeAiRelationship(parsed) {
  let directTotal = 0;
  let coThinkTotal = 0;
  let sampledPrompts = 0;
  const directingExamples = [];
  const coThinkingExamples = [];

  for (const s of parsed.sessions ?? []) {
    for (const m of s.messages ?? []) {
      if (m.role !== "user") continue;
      const r = scorePrompt(m.textRedacted);
      if (!r) continue;
      sampledPrompts++;
      directTotal += r.direct;
      coThinkTotal += r.coThink;
      // Cherry-pick a few clear examples for each pole (locally only —
      // sent to the LLM as evidence, not embedded in the candidate.json).
      if (r.direct >= 3 && r.direct > r.coThink && directingExamples.length < 4) {
        directingExamples.push(r.text.slice(0, 240));
      }
      if (r.coThink >= 2 && r.coThink > r.direct && r.words <= 30 && coThinkingExamples.length < 4) {
        coThinkingExamples.push(r.text.slice(0, 160));
      }
    }
  }

  if (sampledPrompts === 0) return null;

  const tot = directTotal + coThinkTotal;
  const directing = tot ? Math.round((directTotal / tot) * 100) : 50;
  const coThinking = 100 - directing;
  let mode = "balanced";
  if (directing >= 65) mode = "directing-leaning";
  else if (coThinking >= 65) mode = "co-thinking-leaning";

  return {
    mode,
    directing,
    coThinking,
    sampledPrompts,
    examples: { directing: directingExamples, coThinking: coThinkingExamples },
  };
}
