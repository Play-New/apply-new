// Statistical fingerprint + provenance manifest.
//
// The fingerprint is the texture of how someone works: tool mix, research vs
// mutation, latency, thinking depth, prompt style. It feeds both the profile
// and the verifier (a sudden discontinuity in this texture across sessions is
// itself a signal). The manifest pins the raw bytes so the bundle can't be
// edited after generation without the hashes diverging.

import { createHash } from "node:crypto";

const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const ms = (iso) => (iso ? Date.parse(iso) : NaN);

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}
const median = (arr) => percentile([...arr].sort((a, b) => a - b), 50);

const MUTATION_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);
const RESEARCH_TOOLS = new Set(["Read", "Grep", "Glob", "WebSearch", "WebFetch"]);

export function computeFingerprint(parsed) {
  let messages = 0, user = 0, assistant = 0, toolUses = 0;
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  const toolHistogram = {};
  const models = new Set();
  const cliVersions = new Set();
  const projects = new Set();
  const latencies = [];
  const thinking = [];
  const promptWords = [];
  let shortPrompts = 0;
  let allTs = [];

  for (const s of parsed.sessions) {
    projects.add(s.projectLabel);
    for (const m of s.models) models.add(m);
    for (const v of s.cliVersions) cliVersions.add(v);

    let lastUserTs = null;
    for (const m of s.messages) {
      messages++;
      if (ms(m.ts)) allTs.push(ms(m.ts));
      if (m.role === "user") {
        user++;
        const words = m.textRedacted.trim().split(/\s+/).filter(Boolean).length;
        if (words > 0) promptWords.push(words);
        if (words > 0 && words <= 4) shortPrompts++;
        lastUserTs = ms(m.ts);
      } else if (m.role === "assistant") {
        assistant++;
        const reasoning = m.thinkingChars > 0 ? m.thinkingChars : m.signatureChars || 0;
        if (reasoning > 0) thinking.push(reasoning);
        if (lastUserTs && ms(m.ts)) {
          const dt = ms(m.ts) - lastUserTs;
          if (dt > 0 && dt < 1000 * 60 * 30) latencies.push(dt);
          lastUserTs = null;
        }
      }
      if (m.usage) {
        tokens.input += m.usage.input;
        tokens.output += m.usage.output;
        tokens.cacheRead += m.usage.cacheRead;
        tokens.cacheCreate += m.usage.cacheCreate;
      }
      for (const u of m.toolUses) {
        toolUses++;
        toolHistogram[u.name] = (toolHistogram[u.name] || 0) + 1;
      }
    }
  }

  const mutations = Object.entries(toolHistogram)
    .filter(([k]) => MUTATION_TOOLS.has(k))
    .reduce((n, [, v]) => n + v, 0);
  const research = Object.entries(toolHistogram)
    .filter(([k]) => RESEARCH_TOOLS.has(k))
    .reduce((n, [, v]) => n + v, 0);

  allTs = allTs.filter(Number.isFinite).sort((a, b) => a - b);
  const days = new Set(allTs.map((t) => new Date(t).toISOString().slice(0, 10)));
  const latSorted = [...latencies].sort((a, b) => a - b);

  // Provenance manifest: per-file hashes + a bundle hash over them.
  const fileHashes = parsed.files.map((f) => ({ file: f.relPath, sha256: f.sha256, bytes: f.bytes }));
  const bundleHash = sha256(fileHashes.map((f) => f.sha256).sort().join(""));

  return {
    source: parsed.source,
    totals: {
      sessions: parsed.sessions.length,
      projects: projects.size,
      messages,
      userMessages: user,
      assistantMessages: assistant,
      toolUses,
      activeDays: days.size,
      firstDay: allTs.length ? new Date(allTs[0]).toISOString().slice(0, 10) : null,
      lastDay: allTs.length ? new Date(allTs.at(-1)).toISOString().slice(0, 10) : null,
    },
    tokens,
    toolHistogram,
    ratios: {
      researchToMutation: mutations ? +(research / mutations).toFixed(2) : null,
      toolsPerUserMessage: user ? +(toolUses / user).toFixed(2) : null,
    },
    style: {
      medianPromptWords: median(promptWords),
      shortPromptRate: user ? +(shortPrompts / user).toFixed(2) : null,
      medianThinkingChars: median(thinking),
    },
    latencyMs: {
      p50: percentile(latSorted, 50),
      p90: percentile(latSorted, 90),
      samples: latSorted.length,
    },
    models: [...models],
    cliVersions: [...cliVersions],
    manifest: { files: fileHashes, bundleHash },
  };
}
