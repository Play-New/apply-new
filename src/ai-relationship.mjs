// AI relationship: the style with which the candidate works with the model.
//
// Two poles:
//   - "executor": you treat the model like a careful junior. Prompts are
//     long, structured, with file paths, numbered steps, acceptance criteria.
//   - "symbient": you think out loud with the model. Prompts are short,
//     conversational, full of open questions ("what if", "cosa pensi"),
//     letting the model push back and shape the problem.
//
// Few people are pure; most are a mix and choose mode by context. We score
// each user prompt against both poles and report a percentage split, a few
// telltale phrase samples, and let the LLM narrative explain WHEN they switch.
//
// Anti-leak: the same system-injected prompts (compaction, task-notifications)
// excluded elsewhere are excluded here too.

const SYSTEM_PROMPT_RE = /^(<task-notification>|Your task is to create a detailed summary of the conversation|This session is being continued from a previous conversation)/i;

const EXECUTOR_PATTERNS = [
  /(^|\n)\s*\d+\.\s/, // numbered list item
  /(^|\n)\s*-\s+\[.\]/, // checkbox
  /\b(step|fase)\s*\d/i,
  /\/Users|file_path|\.tsx?|\.mjs|\.sql\b|\.md\b/i, // file references
  /\b(acceptance|criteria|requirements|spec|verify|verifica|must|should|deve|devi)\b/i,
  /\b(do not|don't|never|exclude|only|exactly|esattamente)\b/i, // hard constraints
];

const SYMBIENT_PATTERNS = [
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
  let exec = 0;
  let sym = 0;
  for (const r of EXECUTOR_PATTERNS) if (r.test(t)) exec++;
  for (const r of SYMBIENT_PATTERNS) if (r.test(t)) sym++;
  // Length signal — long prompts skew executor, very short skew symbient.
  if (words >= 80) exec += 2;
  else if (words >= 30) exec += 1;
  if (words <= 8) sym += 2;
  else if (words <= 16) sym += 1;
  return { exec, sym, words, text: t };
}

export function computeAiRelationship(parsed) {
  let execTotal = 0;
  let symTotal = 0;
  let sampledPrompts = 0;
  const executorExamples = [];
  const symbientExamples = [];

  for (const s of parsed.sessions ?? []) {
    for (const m of s.messages ?? []) {
      if (m.role !== "user") continue;
      const r = scorePrompt(m.textRedacted);
      if (!r) continue;
      sampledPrompts++;
      execTotal += r.exec;
      symTotal += r.sym;
      // Cherry-pick a few clear examples for each pole (locally only —
      // sent to the LLM, not embedded in the candidate.json).
      if (r.exec >= 3 && r.exec > r.sym && executorExamples.length < 4) {
        executorExamples.push(r.text.slice(0, 240));
      }
      if (r.sym >= 2 && r.sym > r.exec && r.words <= 30 && symbientExamples.length < 4) {
        symbientExamples.push(r.text.slice(0, 160));
      }
    }
  }

  if (sampledPrompts === 0) return null;

  const tot = execTotal + symTotal;
  const executor = tot ? Math.round((execTotal / tot) * 100) : 50;
  const symbient = 100 - executor;
  let mode = "mixed";
  if (executor >= 65) mode = "executor-leaning";
  else if (symbient >= 65) mode = "symbient-leaning";

  return {
    mode,
    executor,
    symbient,
    sampledPrompts,
    examples: { executor: executorExamples, symbient: symbientExamples },
  };
}
