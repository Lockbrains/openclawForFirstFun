import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveGatewayStateDir } from "./paths.js";

describe("resolveGatewayStateDir", () => {
  it("uses the default state dir when no overrides are set", () => {
    const env = { HOME: "/Users/test" };
    expect(resolveGatewayStateDir(env)).toBe(path.join("/Users/test", ".firstclaw"));
  });

  it("appends the profile suffix when set", () => {
    const env = { HOME: "/Users/test", FIRSTCLAW_PROFILE: "rescue" };
    expect(resolveGatewayStateDir(env)).toBe(path.join("/Users/test", ".firstclaw-rescue"));
  });

  it("treats default profiles as the base state dir", () => {
    const env = { HOME: "/Users/test", FIRSTCLAW_PROFILE: "Default" };
    expect(resolveGatewayStateDir(env)).toBe(path.join("/Users/test", ".firstclaw"));
  });

  it("uses FIRSTCLAW_STATE_DIR when provided", () => {
    const env = { HOME: "/Users/test", FIRSTCLAW_STATE_DIR: "/var/lib/firstclaw" };
    expect(resolveGatewayStateDir(env)).toBe(path.resolve("/var/lib/firstclaw"));
  });

  it("expands ~ in FIRSTCLAW_STATE_DIR", () => {
    const env = { HOME: "/Users/test", FIRSTCLAW_STATE_DIR: "~/firstclaw-state" };
    expect(resolveGatewayStateDir(env)).toBe(path.resolve("/Users/test/firstclaw-state"));
  });

  it("preserves Windows absolute paths without HOME", () => {
    const env = { FIRSTCLAW_STATE_DIR: "C:\\State\\firstclaw" };
    expect(resolveGatewayStateDir(env)).toBe("C:\\State\\firstclaw");
  });
});
