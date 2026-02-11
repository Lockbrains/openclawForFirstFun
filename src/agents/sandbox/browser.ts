/* Browser module removed - stub for sandbox context compatibility */

import type { SandboxBrowserContext, SandboxConfig } from "./types.js";

export async function ensureSandboxBrowser(_params: {
  scopeKey: string;
  workspaceDir: string;
  agentWorkspaceDir: string;
  cfg: SandboxConfig;
  evaluateEnabled: boolean;
}): Promise<SandboxBrowserContext | null> {
  return null;
}
