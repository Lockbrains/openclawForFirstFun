import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadFirstClawPlugins } from "./loader.js";

type TempPlugin = { dir: string; file: string; id: string };

const tempDirs: string[] = [];
const prevBundledDir = process.env.FIRSTCLAW_BUNDLED_PLUGINS_DIR;
const EMPTY_PLUGIN_SCHEMA = { type: "object", additionalProperties: false, properties: {} };

function makeTempDir() {
  const dir = path.join(os.tmpdir(), `firstclaw-plugin-${randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

function writePlugin(params: {
  id: string;
  body: string;
  dir?: string;
  filename?: string;
}): TempPlugin {
  const dir = params.dir ?? makeTempDir();
  const filename = params.filename ?? `${params.id}.js`;
  const file = path.join(dir, filename);
  fs.writeFileSync(file, params.body, "utf-8");
  fs.writeFileSync(
    path.join(dir, "firstclaw.plugin.json"),
    JSON.stringify(
      {
        id: params.id,
        configSchema: EMPTY_PLUGIN_SCHEMA,
      },
      null,
      2,
    ),
    "utf-8",
  );
  return { dir, file, id: params.id };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  }
  if (prevBundledDir === undefined) {
    delete process.env.FIRSTCLAW_BUNDLED_PLUGINS_DIR;
  } else {
    process.env.FIRSTCLAW_BUNDLED_PLUGINS_DIR = prevBundledDir;
  }
});

describe("loadFirstClawPlugins", () => {
  it("disables bundled plugins by default", () => {
    const bundledDir = makeTempDir();
    writePlugin({
      id: "feishu",
      body: `export default { id: "feishu", register() {} };`,
      dir: bundledDir,
      filename: "feishu.ts",
    });
    process.env.FIRSTCLAW_BUNDLED_PLUGINS_DIR = bundledDir;

    const registry = loadFirstClawPlugins({
      cache: false,
      config: {
        plugins: {
          allow: ["feishu"],
        },
      },
    });

    const bundled = registry.plugins.find((entry) => entry.id === "feishu");
    expect(bundled?.status).toBe("disabled");

    const enabledRegistry = loadFirstClawPlugins({
      cache: false,
      config: {
        plugins: {
          allow: ["feishu"],
          entries: {
            feishu: { enabled: true },
          },
        },
      },
    });

    const enabled = enabledRegistry.plugins.find((entry) => entry.id === "feishu");
    expect(enabled?.status).toBe("loaded");
  });

  it("loads bundled imessage plugin when enabled", () => {
    const bundledDir = makeTempDir();
    writePlugin({
      id: "imessage",
      body: `export default { id: "imessage", register(api) {
  api.registerChannel({
    plugin: {
      id: "imessage",
      meta: {
        id: "imessage",
        label: "iMessage",
        selectionLabel: "iMessage",
        docsPath: "/channels/imessage",
        blurb: "imessage channel"
      },
      capabilities: { chatTypes: ["direct"] },
      config: {
        listAccountIds: () => [],
        resolveAccount: () => ({ accountId: "default" })
      },
      outbound: { deliveryMode: "direct" }
    }
  });
} };`,
      dir: bundledDir,
      filename: "imessage.ts",
    });
    process.env.FIRSTCLAW_BUNDLED_PLUGINS_DIR = bundledDir;

    const registry = loadFirstClawPlugins({
      cache: false,
      config: {
        plugins: {
          allow: ["imessage"],
          entries: {
            imessage: { enabled: true },
          },
        },
      },
    });

    const imessage = registry.plugins.find((entry) => entry.id === "imessage");
    expect(imessage?.status).toBe("loaded");
    expect(registry.channels.some((entry) => entry.plugin.id === "imessage")).toBe(true);
  });

  it("enables bundled memory plugin when selected by slot", () => {
    const bundledDir = makeTempDir();
    writePlugin({
      id: "memory-core",
      body: `export default { id: "memory-core", kind: "memory", register() {} };`,
      dir: bundledDir,
      filename: "memory-core.ts",
    });
    process.env.FIRSTCLAW_BUNDLED_PLUGINS_DIR = bundledDir;

    const registry = loadFirstClawPlugins({
      cache: false,
      config: {
        plugins: {
          slots: {
            memory: "memory-core",
          },
        },
      },
    });

    const memory = registry.plugins.find((entry) => entry.id === "memory-core");
    expect(memory?.status).toBe("loaded");
  });

  it("preserves package.json metadata for bundled memory plugins", () => {
    const bundledDir = makeTempDir();
    const pluginDir = path.join(bundledDir, "memory-core");
    fs.mkdirSync(pluginDir, { recursive: true });

    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify({
        name: "@firstclaw/memory-core",
        version: "1.2.3",
        description: "Memory plugin package",
        firstclaw: { extensions: ["./index.ts"] },
      }),
      "utf-8",
    );
    writePlugin({
      id: "memory-core",
      body: `export default { id: "memory-core", kind: "memory", name: "Memory (Core)", register() {} };`,
      dir: pluginDir,
      filename: "index.ts",
    });

    process.env.FIRSTCLAW_BUNDLED_PLUGINS_DIR = bundledDir;

    const registry = loadFirstClawPlugins({
      cache: false,
      config: {
        plugins: {
          slots: {
            memory: "memory-core",
          },
        },
      },
    });

    const memory = registry.plugins.find((entry) => entry.id === "memory-core");
    expect(memory?.status).toBe("loaded");
    expect(memory?.origin).toBe("bundled");
    expect(memory?.name).toBe("Memory (Core)");
    expect(memory?.version).toBe("1.2.3");
  });
  it("loads plugins from config paths", () => {
    process.env.FIRSTCLAW_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";
    const plugin = writePlugin({
      id: "feishu",
      body: `export default { id: "feishu", register(api) { api.registerGatewayMethod("feishu.ping", ({ respond }) => respond(true, { ok: true })); } };`,
    });

    const registry = loadFirstClawPlugins({
      cache: false,
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["feishu"],
        },
      },
    });

    const loaded = registry.plugins.find((entry) => entry.id === "feishu");
    expect(loaded?.status).toBe("loaded");
    expect(Object.keys(registry.gatewayHandlers)).toContain("feishu.ping");
  });

  it("denylist disables plugins even if allowed", () => {
    process.env.FIRSTCLAW_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";
    const plugin = writePlugin({
      id: "imessage",
      body: `export default { id: "imessage", register() {} };`,
    });

    const registry = loadFirstClawPlugins({
      cache: false,
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["imessage"],
          deny: ["imessage"],
        },
      },
    });

    const blocked = registry.plugins.find((entry) => entry.id === "imessage");
    expect(blocked?.status).toBe("disabled");
  });

  it("fails fast on invalid plugin config", () => {
    process.env.FIRSTCLAW_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";
    const plugin = writePlugin({
      id: "llm-task",
      body: `export default { id: "llm-task", register() {} };`,
    });

    const registry = loadFirstClawPlugins({
      cache: false,
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          entries: {
            "llm-task": {
              config: "nope" as unknown as Record<string, unknown>,
            },
          },
        },
      },
    });

    const configurable = registry.plugins.find((entry) => entry.id === "llm-task");
    expect(configurable?.status).toBe("error");
    expect(registry.diagnostics.some((d) => d.level === "error")).toBe(true);
  });

  it("registers channel plugins", () => {
    process.env.FIRSTCLAW_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";
    const plugin = writePlugin({
      id: "feishu",
      body: `export default { id: "feishu", register(api) {
  api.registerChannel({
    plugin: {
      id: "feishu",
      meta: {
        id: "feishu",
        label: "Feishu",
        selectionLabel: "Feishu",
        docsPath: "/channels/feishu",
        blurb: "feishu channel"
      },
      capabilities: { chatTypes: ["direct"] },
      config: {
        listAccountIds: () => [],
        resolveAccount: () => ({ accountId: "default" })
      },
      outbound: { deliveryMode: "direct" }
    }
  });
} };`,
    });

    const registry = loadFirstClawPlugins({
      cache: false,
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["feishu"],
        },
      },
    });

    const channel = registry.channels.find((entry) => entry.plugin.id === "feishu");
    expect(channel).toBeDefined();
  });

  it("registers http handlers", () => {
    process.env.FIRSTCLAW_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";
    const plugin = writePlugin({
      id: "diagnostics-otel",
      body: `export default { id: "diagnostics-otel", register(api) {
  api.registerHttpHandler(async () => false);
} };`,
    });

    const registry = loadFirstClawPlugins({
      cache: false,
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["diagnostics-otel"],
        },
      },
    });

    const handler = registry.httpHandlers.find((entry) => entry.pluginId === "diagnostics-otel");
    expect(handler).toBeDefined();
    const httpPlugin = registry.plugins.find((entry) => entry.id === "diagnostics-otel");
    expect(httpPlugin?.httpHandlers).toBe(1);
  });

  it("registers http routes", () => {
    process.env.FIRSTCLAW_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";
    const plugin = writePlugin({
      id: "lobster",
      body: `export default { id: "lobster", register(api) {
  api.registerHttpRoute({ path: "/demo", handler: async (_req, res) => { res.statusCode = 200; res.end("ok"); } });
} };`,
    });

    const registry = loadFirstClawPlugins({
      cache: false,
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["lobster"],
        },
      },
    });

    const route = registry.httpRoutes.find((entry) => entry.pluginId === "lobster");
    expect(route).toBeDefined();
    expect(route?.path).toBe("/demo");
    const httpPlugin = registry.plugins.find((entry) => entry.id === "lobster");
    expect(httpPlugin?.httpHandlers).toBe(1);
  });

  it("respects explicit disable in config", () => {
    process.env.FIRSTCLAW_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";
    const plugin = writePlugin({
      id: "minimax-portal-auth",
      body: `export default { id: "minimax-portal-auth", register() {} };`,
    });

    const registry = loadFirstClawPlugins({
      cache: false,
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["minimax-portal-auth"],
          entries: {
            "minimax-portal-auth": { enabled: false },
          },
        },
      },
    });

    const disabled = registry.plugins.find((entry) => entry.id === "minimax-portal-auth");
    expect(disabled?.status).toBe("disabled");
  });

  it("enforces memory slot selection", () => {
    process.env.FIRSTCLAW_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";
    const memoryA = writePlugin({
      id: "memory-core",
      body: `export default { id: "memory-core", kind: "memory", register() {} };`,
    });
    const memoryB = writePlugin({
      id: "memory-lancedb",
      body: `export default { id: "memory-lancedb", kind: "memory", register() {} };`,
    });

    const registry = loadFirstClawPlugins({
      cache: false,
      config: {
        plugins: {
          load: { paths: [memoryA.file, memoryB.file] },
          slots: { memory: "memory-lancedb" },
        },
      },
    });

    const a = registry.plugins.find((entry) => entry.id === "memory-core");
    const b = registry.plugins.find((entry) => entry.id === "memory-lancedb");
    expect(b?.status).toBe("loaded");
    expect(a?.status).toBe("disabled");
  });

  it("disables memory plugins when slot is none", () => {
    process.env.FIRSTCLAW_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";
    const memory = writePlugin({
      id: "memory-core",
      body: `export default { id: "memory-core", kind: "memory", register() {} };`,
    });

    const registry = loadFirstClawPlugins({
      cache: false,
      config: {
        plugins: {
          load: { paths: [memory.file] },
          slots: { memory: "none" },
        },
      },
    });

    const entry = registry.plugins.find((item) => item.id === "memory-core");
    expect(entry?.status).toBe("disabled");
  });

  it("prefers higher-precedence plugins with the same id", () => {
    const bundledDir = makeTempDir();
    writePlugin({
      id: "feishu",
      body: `export default { id: "feishu", register() {} };`,
      dir: bundledDir,
      filename: "feishu.js",
    });
    process.env.FIRSTCLAW_BUNDLED_PLUGINS_DIR = bundledDir;

    const override = writePlugin({
      id: "feishu",
      body: `export default { id: "feishu", register() {} };`,
    });

    const registry = loadFirstClawPlugins({
      cache: false,
      config: {
        plugins: {
          load: { paths: [override.file] },
          entries: {
            feishu: { enabled: true },
          },
        },
      },
    });

    const entries = registry.plugins.filter((entry) => entry.id === "feishu");
    const loaded = entries.find((entry) => entry.status === "loaded");
    const overridden = entries.find((entry) => entry.status === "disabled");
    expect(loaded?.origin).toBe("config");
    expect(overridden?.origin).toBe("bundled");
  });
});
