export type Client = "claude" | "chatgpt" | "claude-code" | "codex" | "gemini";

/** Chip order on the Connect an agent card. */
export const CLIENTS: { value: Client; label: string }[] = [
  { value: "claude", label: "Claude" },
  { value: "chatgpt", label: "ChatGPT" },
  { value: "claude-code", label: "Claude Code" },
  { value: "codex", label: "Codex" },
  { value: "gemini", label: "Gemini" },
];

/**
 * One line per client on how to add the MCP address. Checked 2026-11 against each vendor's docs: ChatGPT adds custom MCP
 * servers from Plugins (only where the plan and workspace role allow it); Codex adds the server, then signs in with OAuth;
 * Gemini CLI signs in when it first uses the server. Gemini Enterprise and Antigravity are in docs/agents.md.
 */
export const HOWTO: Record<Client, (url: string) => string> = {
  claude: () => "claude.ai or Claude Desktop: Settings, Connectors, Add custom connector, paste the address",
  chatgpt: () => "Plugins, +, Add custom MCP server, paste the address, choose OAuth (if your plan and workspace allow it)",
  "claude-code": (url) => `claude mcp add --transport http linkwarren ${url}`,
  codex: (url) => `codex mcp add linkwarren --url ${url}, then codex mcp login linkwarren`,
  gemini: (url) => `gemini mcp add --transport http linkwarren ${url}, then sign in when prompted`,
};
