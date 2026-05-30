// Agentic literacy: USES / BUILDS / DESIGNS — how comfortable the candidate is
// in the agentic stack, derived deterministically from their Claude Code logs.
//
// Privacy rule: NEVER expose names of custom skills, commands, or MCP servers.
// They can carry client / company / project information. We only export
// counts, with a binary classification built-in vs custom (whitelist-driven).
//
// Three axes:
//   - USES: tool surface — sub-agent delegations, MCP calls, slash commands,
//     skill/command invocations. Distinguishes "uses AI" from "barely uses AI".
//   - BUILDS: files in .claude/ that the candidate has edited (skills,
//     commands, hooks, project memory). Distinguishes "uses AI" from
//     "builds with AI".
//   - DESIGNS: structural patterns in how work is decomposed (ExitPlanMode,
//     TodoWrite, AskUserQuestion). Captures planning style.

// ── Whitelists (built-in / public) ────────────────────────────────────────

// Tools shipped with Claude Code or otherwise standard. Anything outside
// this list, if it doesn't start with `mcp__`, is treated as a candidate
// custom tool — but in practice non-MCP tools are all built-in, so this is
// here for completeness.
const BUILTIN_TOOLS = new Set([
  // file ops
  "Read", "Write", "Edit", "MultiEdit", "NotebookEdit",
  // shell
  "Bash", "BashOutput", "KillBash",
  // search
  "Grep", "Glob",
  // web
  "WebSearch", "WebFetch",
  // sub-agent
  "Task", "Agent",
  // planning / clarification
  "ExitPlanMode", "TodoWrite", "AskUserQuestion",
  // task system
  "TaskCreate", "TaskUpdate", "TaskStop", "TaskGet", "TaskList", "TaskOutput",
  // scheduling
  "ScheduleWakeup", "CronCreate", "CronDelete", "CronList",
  // worktrees / misc
  "ToolSearch", "Monitor", "EnterPlanMode", "EnterWorktree", "ExitWorktree",
  "ListMcpResourcesTool", "ReadMcpResourceTool", "RemoteTrigger", "SendMessage",
  "PushNotification", "TeamCreate", "TeamDelete",
]);

// Slash commands present in any vanilla Claude Code install.
const BUILTIN_SLASH = new Set([
  "/login", "/exit", "/quit", "/clear", "/help", "/status", "/config", "/init",
  "/mcp", "/memory", "/model", "/tokens", "/resume", "/compact", "/context",
  "/cost", "/tools", "/add-dir", "/add-mcp", "/add-slash-command",
  "/code-review", "/security-review", "/review", "/run", "/verify", "/loop",
  "/schedule", "/simplify",
]);

// MCP servers that ship publicly or are widely known integrations. The
// match is on the second segment of the tool name: `mcp__<server>__<tool>`.
const PUBLIC_MCP_SERVERS = new Set([
  // Anthropic-hosted Claude.ai MCPs
  "claude_ai_Linear", "claude_ai_Linear_2", "claude_ai_Notion", "claude_ai_Slack",
  "claude_ai_GitHub", "claude_ai_Figma", "claude_ai_Gmail",
  "claude_ai_Google_Calendar", "claude_ai_Google_Drive", "claude_ai_Canva",
  "claude_ai_Miro", "claude_ai_Zapier", "claude_ai_PostHog", "claude_ai_LumaMCP",
  "claude_ai_Windsor_ai",
  // Plugin-shipped public MCPs
  "plugin_supabase_supabase",
  "nanobanana",
  "ide",
]);

// ── Helpers ───────────────────────────────────────────────────────────────

function mcpServer(toolName) {
  // mcp__<server>__<tool> — pick segment 2.
  if (!toolName?.startsWith("mcp__")) return null;
  const parts = toolName.split("__");
  return parts[1] || null;
}

// Plugin slash commands look like /plugin:command (e.g. /playbook:build).
// They aren't strictly built-in but they aren't proprietary either; the
// safest call is to count them as custom (they may reveal an internal plugin
// the candidate uses, but the prefix can also be a private one).
function classifySlash(name) {
  if (!name?.startsWith("/")) return "other";
  if (BUILTIN_SLASH.has(name)) return "builtin";
  return "custom";
}

const PROJECT_FILE_RE = /(?:^|\/)CLAUDE\.md$/;
const SKILL_RE = /\/\.claude\/skills?\/[^/]+\/(SKILL|skill)\.md$/;
const COMMAND_RE = /\/\.claude\/commands?\/[^/]+\.md$/;
const AGENT_RE = /\/\.claude\/agents?\/[^/]+\.md$/;
const HOOK_RE = /\/\.claude\/(hooks?|settings)\.?(json|md)?$/;

// ── Main ──────────────────────────────────────────────────────────────────

export function computeAgenticLiteracy(parsed) {
  // USES
  let subagentCalls = 0;
  let taskTrackingEvents = 0;
  let askUserQuestion = 0;
  let exitPlanMode = 0;
  let todoWrite = 0;
  let builtinSlashCount = 0;
  const customSlashSet = new Set();
  let customSlashInvocations = 0;
  const publicMcpServers = new Set();
  const customMcpServers = new Set();
  const customMcpTools = new Set();
  let customMcpCalls = 0;
  let publicMcpCalls = 0;

  // BUILDS
  const skillsAuthored = new Set();
  const commandsAuthored = new Set();
  const agentsAuthored = new Set();
  const hooksEdited = new Set();
  const projectMemoryFiles = new Set();

  // Slash commands appear in user messages wrapped in <command-name>foo</command-name>.
  const SLASH_RE = /<command-name>(\/[\w:-]+)<\/command-name>/g;

  for (const s of parsed.sessions ?? []) {
    for (const m of s.messages ?? []) {
      // Slash commands invoked
      if (m.role === "user" && m.textRedacted) {
        for (const match of m.textRedacted.matchAll(SLASH_RE)) {
          const cmd = match[1];
          if (classifySlash(cmd) === "builtin") builtinSlashCount++;
          else {
            customSlashSet.add(cmd);
            customSlashInvocations++;
          }
        }
      }

      for (const u of m.toolUses ?? []) {
        const name = u.name;
        if (!name) continue;

        // Built-in tool counts
        if (name === "Task" || name === "Agent") subagentCalls++;
        else if (name === "AskUserQuestion") askUserQuestion++;
        else if (name === "ExitPlanMode") exitPlanMode++;
        else if (name === "TodoWrite") todoWrite++;
        else if (name === "TaskCreate" || name === "TaskUpdate") taskTrackingEvents++;

        // MCP classification
        const server = mcpServer(name);
        if (server) {
          if (PUBLIC_MCP_SERVERS.has(server)) {
            publicMcpServers.add(server);
            publicMcpCalls++;
          } else {
            customMcpServers.add(server);
            customMcpTools.add(name);
            customMcpCalls++;
          }
        }

        // File paths touched (BUILDS)
        const fp = u.path || "";
        if (fp) {
          if (SKILL_RE.test(fp)) skillsAuthored.add(fp);
          else if (COMMAND_RE.test(fp)) commandsAuthored.add(fp);
          else if (AGENT_RE.test(fp)) agentsAuthored.add(fp);
          else if (HOOK_RE.test(fp)) hooksEdited.add(fp);
          else if (PROJECT_FILE_RE.test(fp)) projectMemoryFiles.add(fp);
        }
      }
    }
  }

  return {
    uses: {
      subagentDelegations: subagentCalls,
      taskTrackingEvents,
      builtinSlashInvocations: builtinSlashCount,
      customSkillsCommands: { distinct: customSlashSet.size, invocations: customSlashInvocations },
      publicMcp: { servers: publicMcpServers.size, calls: publicMcpCalls },
      customMcp: { servers: customMcpServers.size, tools: customMcpTools.size, calls: customMcpCalls },
    },
    builds: {
      skillsAuthored: skillsAuthored.size,
      commandsAuthored: commandsAuthored.size,
      agentsAuthored: agentsAuthored.size,
      hooksEdited: hooksEdited.size,
      projectMemoryFiles: projectMemoryFiles.size,
    },
    designs: {
      plansFirst: exitPlanMode,
      subtaskTracking: todoWrite,
      clarifies: askUserQuestion,
    },
  };
}
