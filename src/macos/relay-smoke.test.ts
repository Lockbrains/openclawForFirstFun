import { describe, expect, it } from "vitest";
import { parseRelaySmokeTest, runRelaySmokeTest } from "./relay-smoke.js";

describe("parseRelaySmokeTest", () => {
  it("parses --smoke qr", () => {
    expect(parseRelaySmokeTest(["--smoke", "qr"], {})).toBe("qr");
  });

  it("parses --smoke-qr", () => {
    expect(parseRelaySmokeTest(["--smoke-qr"], {})).toBe("qr");
  });

  it("parses env var smoke mode only when no args", () => {
    expect(parseRelaySmokeTest([], { FIRSTCLAW_SMOKE_QR: "1" })).toBe("qr");
    expect(parseRelaySmokeTest(["send"], { FIRSTCLAW_SMOKE_QR: "1" })).toBe(null);
  });

  it("rejects unknown smoke values", () => {
    expect(() => parseRelaySmokeTest(["--smoke", "nope"], {})).toThrow("Unknown smoke test");
  });
});

describe("runRelaySmokeTest", () => {
  it("runs qr smoke test (no-op; web/qr-image removed)", async () => {
    await expect(runRelaySmokeTest("qr")).resolves.toBeUndefined();
  });
});
