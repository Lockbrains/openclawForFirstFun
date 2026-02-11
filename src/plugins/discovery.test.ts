import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const tempDirs: string[] = [];

function makeTempDir() {
  const dir = path.join(os.tmpdir(), `firstclaw-plugins-${randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

async function withStateDir<T>(stateDir: string, fn: () => Promise<T>) {
  const prev = process.env.FIRSTCLAW_STATE_DIR;
  const prevBundled = process.env.FIRSTCLAW_BUNDLED_PLUGINS_DIR;
  process.env.FIRSTCLAW_STATE_DIR = stateDir;
  process.env.FIRSTCLAW_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";
  vi.resetModules();
  try {
    return await fn();
  } finally {
    if (prev === undefined) {
      delete process.env.FIRSTCLAW_STATE_DIR;
    } else {
      process.env.FIRSTCLAW_STATE_DIR = prev;
    }
    if (prevBundled === undefined) {
      delete process.env.FIRSTCLAW_BUNDLED_PLUGINS_DIR;
    } else {
      process.env.FIRSTCLAW_BUNDLED_PLUGINS_DIR = prevBundled;
    }
    vi.resetModules();
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  }
});

describe("discoverFirstClawPlugins", () => {
  it("discovers global and workspace extensions", async () => {
    const stateDir = makeTempDir();
    const workspaceDir = path.join(stateDir, "workspace");

    const globalExt = path.join(stateDir, "extensions");
    fs.mkdirSync(globalExt, { recursive: true });
    fs.writeFileSync(path.join(globalExt, "feishu.ts"), "export default function () {}", "utf-8");

    const workspaceExt = path.join(workspaceDir, ".firstclaw", "extensions");
    fs.mkdirSync(workspaceExt, { recursive: true });
    fs.writeFileSync(
      path.join(workspaceExt, "imessage.ts"),
      "export default function () {}",
      "utf-8",
    );

    const { candidates } = await withStateDir(stateDir, async () => {
      const { discoverFirstClawPlugins } = await import("./discovery.js");
      return discoverFirstClawPlugins({ workspaceDir });
    });

    const ids = candidates.map((c) => c.idHint);
    expect(ids).toContain("feishu");
    expect(ids).toContain("imessage");
  });

  it("loads package extension packs", async () => {
    const stateDir = makeTempDir();
    const globalExt = path.join(stateDir, "extensions", "llm-task");
    fs.mkdirSync(path.join(globalExt, "src"), { recursive: true });

    fs.writeFileSync(
      path.join(globalExt, "package.json"),
      JSON.stringify({
        name: "@firstclaw/llm-task",
        firstclaw: { extensions: ["./src/index.ts"] },
      }),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(globalExt, "src", "index.ts"),
      "export default function () {}",
      "utf-8",
    );

    const { candidates } = await withStateDir(stateDir, async () => {
      const { discoverFirstClawPlugins } = await import("./discovery.js");
      return discoverFirstClawPlugins({});
    });

    const ids = candidates.map((c) => c.idHint);
    expect(ids).toContain("llm-task");
  });

  it("derives unscoped ids for scoped packages", async () => {
    const stateDir = makeTempDir();
    const globalExt = path.join(stateDir, "extensions", "device-pair-pack");
    fs.mkdirSync(path.join(globalExt, "src"), { recursive: true });

    fs.writeFileSync(
      path.join(globalExt, "package.json"),
      JSON.stringify({
        name: "@firstclaw/device-pair",
        firstclaw: { extensions: ["./src/index.ts"] },
      }),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(globalExt, "src", "index.ts"),
      "export default function () {}",
      "utf-8",
    );

    const { candidates } = await withStateDir(stateDir, async () => {
      const { discoverFirstClawPlugins } = await import("./discovery.js");
      return discoverFirstClawPlugins({});
    });

    const ids = candidates.map((c) => c.idHint);
    expect(ids).toContain("device-pair");
  });

  it("treats configured directory paths as plugin packages", async () => {
    const stateDir = makeTempDir();
    const packDir = path.join(stateDir, "packs", "lobster");
    fs.mkdirSync(packDir, { recursive: true });

    fs.writeFileSync(
      path.join(packDir, "package.json"),
      JSON.stringify({
        name: "@firstclaw/lobster",
        firstclaw: { extensions: ["./index.js"] },
      }),
      "utf-8",
    );
    fs.writeFileSync(path.join(packDir, "index.js"), "module.exports = {}", "utf-8");

    const { candidates } = await withStateDir(stateDir, async () => {
      const { discoverFirstClawPlugins } = await import("./discovery.js");
      return discoverFirstClawPlugins({ extraPaths: [packDir] });
    });

    const ids = candidates.map((c) => c.idHint);
    expect(ids).toContain("lobster");
  });
});
