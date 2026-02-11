import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveStorePath } from "./paths.js";

describe("resolveStorePath", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses FIRSTCLAW_HOME for tilde expansion", () => {
    vi.stubEnv("FIRSTCLAW_HOME", "/srv/firstclaw-home");
    vi.stubEnv("HOME", "/home/other");

    const resolved = resolveStorePath("~/.firstclaw/agents/{agentId}/sessions/sessions.json", {
      agentId: "research",
    });

    expect(resolved).toBe(
      path.resolve("/srv/firstclaw-home/.firstclaw/agents/research/sessions/sessions.json"),
    );
  });
});
