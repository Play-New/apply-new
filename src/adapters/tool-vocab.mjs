// Shared tool-name fallback: every adapter maps its own tool vocabulary onto
// the canonical Claude Code names (see opencode.mjs's TOOL_MAP), but names it
// doesn't recognise still need to land on the SAME "mcp__server__tool" shape.
// digest.mjs's MUTATION/RESEARCH/DELEGATION sets and agentic-literacy.mjs's
// MCP detection match exact canonical strings — if each adapter reinvented
// this rewrite, the string contract could fork source by source. One shared
// fallback keeps every adapter (opencode today; codex, pi tomorrow) honest.
export function fallbackToolName(name) {
  if (!name) return name;
  // Anything with a "server_tool" shape is an MCP tool; rewrite to the
  // canonical mcp__server__tool so agentic-literacy's MCP detection lights up.
  const us = name.indexOf("_");
  if (us > 0) return `mcp__${name.slice(0, us)}__${name.slice(us + 1)}`;
  return name;
}
