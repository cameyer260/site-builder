/**
 * MCP server configuration for the engine. The only MCP server in v1 is the
 * Playwright MCP, exposed to `claude -p` strictly as a fallback so the model can
 * drive a browser on a single focused page when the deterministic Playwright
 * script can't (CONTEXT.md > Playwright MCP). Distinct from the Playwright
 * script the tool's own code runs.
 */

export interface McpServerSpec {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpConfig {
  mcpServers: Record<string, McpServerSpec>;
}

/** Config registering the Playwright MCP server under the name `playwright`. */
export function playwrightMcpConfig(): McpConfig {
  return {
    mcpServers: {
      playwright: {
        command: "npx",
        args: ["-y", "@playwright/mcp@latest"],
      },
    },
  };
}
