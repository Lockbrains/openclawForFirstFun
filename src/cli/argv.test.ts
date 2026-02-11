import { describe, expect, it } from "vitest";
import {
  buildParseArgv,
  getFlagValue,
  getCommandPath,
  getPrimaryCommand,
  getPositiveIntFlagValue,
  getVerboseFlag,
  hasHelpOrVersion,
  hasFlag,
  shouldMigrateState,
  shouldMigrateStateFromPath,
} from "./argv.js";

describe("argv helpers", () => {
  it("detects help/version flags", () => {
    expect(hasHelpOrVersion(["node", "firstclaw", "--help"])).toBe(true);
    expect(hasHelpOrVersion(["node", "firstclaw", "-V"])).toBe(true);
    expect(hasHelpOrVersion(["node", "firstclaw", "status"])).toBe(false);
  });

  it("extracts command path ignoring flags and terminator", () => {
    expect(getCommandPath(["node", "firstclaw", "status", "--json"], 2)).toEqual(["status"]);
    expect(getCommandPath(["node", "firstclaw", "agents", "list"], 2)).toEqual(["agents", "list"]);
    expect(getCommandPath(["node", "firstclaw", "status", "--", "ignored"], 2)).toEqual(["status"]);
  });

  it("returns primary command", () => {
    expect(getPrimaryCommand(["node", "firstclaw", "agents", "list"])).toBe("agents");
    expect(getPrimaryCommand(["node", "firstclaw"])).toBeNull();
  });

  it("parses boolean flags and ignores terminator", () => {
    expect(hasFlag(["node", "firstclaw", "status", "--json"], "--json")).toBe(true);
    expect(hasFlag(["node", "firstclaw", "--", "--json"], "--json")).toBe(false);
  });

  it("extracts flag values with equals and missing values", () => {
    expect(getFlagValue(["node", "firstclaw", "status", "--timeout", "5000"], "--timeout")).toBe(
      "5000",
    );
    expect(getFlagValue(["node", "firstclaw", "status", "--timeout=2500"], "--timeout")).toBe(
      "2500",
    );
    expect(getFlagValue(["node", "firstclaw", "status", "--timeout"], "--timeout")).toBeNull();
    expect(getFlagValue(["node", "firstclaw", "status", "--timeout", "--json"], "--timeout")).toBe(
      null,
    );
    expect(getFlagValue(["node", "firstclaw", "--", "--timeout=99"], "--timeout")).toBeUndefined();
  });

  it("parses verbose flags", () => {
    expect(getVerboseFlag(["node", "firstclaw", "status", "--verbose"])).toBe(true);
    expect(getVerboseFlag(["node", "firstclaw", "status", "--debug"])).toBe(false);
    expect(getVerboseFlag(["node", "firstclaw", "status", "--debug"], { includeDebug: true })).toBe(
      true,
    );
  });

  it("parses positive integer flag values", () => {
    expect(getPositiveIntFlagValue(["node", "firstclaw", "status"], "--timeout")).toBeUndefined();
    expect(
      getPositiveIntFlagValue(["node", "firstclaw", "status", "--timeout"], "--timeout"),
    ).toBeNull();
    expect(
      getPositiveIntFlagValue(["node", "firstclaw", "status", "--timeout", "5000"], "--timeout"),
    ).toBe(5000);
    expect(
      getPositiveIntFlagValue(["node", "firstclaw", "status", "--timeout", "nope"], "--timeout"),
    ).toBeUndefined();
  });

  it("builds parse argv from raw args", () => {
    const nodeArgv = buildParseArgv({
      programName: "firstclaw",
      rawArgs: ["node", "firstclaw", "status"],
    });
    expect(nodeArgv).toEqual(["node", "firstclaw", "status"]);

    const versionedNodeArgv = buildParseArgv({
      programName: "firstclaw",
      rawArgs: ["node-22", "firstclaw", "status"],
    });
    expect(versionedNodeArgv).toEqual(["node-22", "firstclaw", "status"]);

    const versionedNodeWindowsArgv = buildParseArgv({
      programName: "firstclaw",
      rawArgs: ["node-22.2.0.exe", "firstclaw", "status"],
    });
    expect(versionedNodeWindowsArgv).toEqual(["node-22.2.0.exe", "firstclaw", "status"]);

    const versionedNodePatchlessArgv = buildParseArgv({
      programName: "firstclaw",
      rawArgs: ["node-22.2", "firstclaw", "status"],
    });
    expect(versionedNodePatchlessArgv).toEqual(["node-22.2", "firstclaw", "status"]);

    const versionedNodeWindowsPatchlessArgv = buildParseArgv({
      programName: "firstclaw",
      rawArgs: ["node-22.2.exe", "firstclaw", "status"],
    });
    expect(versionedNodeWindowsPatchlessArgv).toEqual(["node-22.2.exe", "firstclaw", "status"]);

    const versionedNodeWithPathArgv = buildParseArgv({
      programName: "firstclaw",
      rawArgs: ["/usr/bin/node-22.2.0", "firstclaw", "status"],
    });
    expect(versionedNodeWithPathArgv).toEqual(["/usr/bin/node-22.2.0", "firstclaw", "status"]);

    const nodejsArgv = buildParseArgv({
      programName: "firstclaw",
      rawArgs: ["nodejs", "firstclaw", "status"],
    });
    expect(nodejsArgv).toEqual(["nodejs", "firstclaw", "status"]);

    const nonVersionedNodeArgv = buildParseArgv({
      programName: "firstclaw",
      rawArgs: ["node-dev", "firstclaw", "status"],
    });
    expect(nonVersionedNodeArgv).toEqual(["node", "firstclaw", "node-dev", "firstclaw", "status"]);

    const directArgv = buildParseArgv({
      programName: "firstclaw",
      rawArgs: ["firstclaw", "status"],
    });
    expect(directArgv).toEqual(["node", "firstclaw", "status"]);

    const bunArgv = buildParseArgv({
      programName: "firstclaw",
      rawArgs: ["bun", "src/entry.ts", "status"],
    });
    expect(bunArgv).toEqual(["bun", "src/entry.ts", "status"]);
  });

  it("builds parse argv from fallback args", () => {
    const fallbackArgv = buildParseArgv({
      programName: "firstclaw",
      fallbackArgv: ["status"],
    });
    expect(fallbackArgv).toEqual(["node", "firstclaw", "status"]);
  });

  it("decides when to migrate state", () => {
    expect(shouldMigrateState(["node", "firstclaw", "status"])).toBe(false);
    expect(shouldMigrateState(["node", "firstclaw", "health"])).toBe(false);
    expect(shouldMigrateState(["node", "firstclaw", "sessions"])).toBe(false);
    expect(shouldMigrateState(["node", "firstclaw", "memory", "status"])).toBe(false);
    expect(shouldMigrateState(["node", "firstclaw", "agent", "--message", "hi"])).toBe(false);
    expect(shouldMigrateState(["node", "firstclaw", "agents", "list"])).toBe(true);
    expect(shouldMigrateState(["node", "firstclaw", "message", "send"])).toBe(true);
  });

  it("reuses command path for migrate state decisions", () => {
    expect(shouldMigrateStateFromPath(["status"])).toBe(false);
    expect(shouldMigrateStateFromPath(["agents", "list"])).toBe(true);
  });
});
