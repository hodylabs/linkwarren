export type Client = "claude" | "chatgpt" | "claude-code" | "codex";

/** Chip order on the Connect an agent card. */
export const CLIENTS: { value: Client; label: string }[] = [
  { value: "claude", label: "Claude" },
  { value: "chatgpt", label: "ChatGPT" },
  { value: "claude-code", label: "Claude Code" },
  { value: "codex", label: "Codex" },
];

/** One line per client on how to add the MCP address. CLI syntax checked 2026-11: both CLIs add a remote HTTP server this way. */
export const HOWTO: Record<Client, (url: string) => string> = {
  claude: () => "Settings, Connectors, Add custom connector, paste the address",
  chatgpt: () => "Settings, Connectors, add a custom connector, paste the address",
  "claude-code": (url) => `claude mcp add --transport http linkwarren ${url}`,
  codex: (url) => `codex mcp add linkwarren --url ${url}`,
};
