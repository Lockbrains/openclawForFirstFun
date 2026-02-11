import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.js";
import type { FirstClawConfig } from "../../config/config.js";
import { feishuPlugin } from "../../../extensions/feishu/src/channel.js";
import { imessagePlugin } from "../../../extensions/imessage/src/channel.js";
import { jsonResult } from "../../agents/tools/common.js";
import { loadWebMedia } from "../../media/load-web-media.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createIMessageTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { runMessageAction } from "./message-action-runner.js";

vi.mock("../../media/load-web-media.js", async () => {
  const actual = await vi.importActual<typeof import("../../media/load-web-media.js")>(
    "../../media/load-web-media.js",
  );
  return {
    ...actual,
    loadWebMedia: vi.fn(actual.loadWebMedia),
  };
});

const imessageConfig = {
  channels: {
    imessage: { enabled: true },
  },
} as FirstClawConfig;

describe("runMessageAction context isolation", () => {
  beforeEach(async () => {
    const { createPluginRuntime } = await import("../../plugins/runtime/index.js");
    const { setIMessageRuntime } = await import("../../../extensions/imessage/src/runtime.js");
    const runtime = createPluginRuntime();
    setIMessageRuntime(runtime);
    setActivePluginRegistry(
      createTestRegistry([
        { pluginId: "imessage", source: "test", plugin: imessagePlugin },
        { pluginId: "feishu", source: "test", plugin: feishuPlugin },
      ]),
    );
  });

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
  });

  it("allows send when target matches current channel", async () => {
    const result = await runMessageAction({
      cfg: imessageConfig,
      action: "send",
      params: {
        channel: "imessage",
        target: "imessage:+15551234567",
        message: "hi",
      },
      toolContext: { currentChannelId: "imessage:+15551234567" },
      dryRun: true,
    });

    expect(result.kind).toBe("send");
  });

  it("accepts legacy to parameter for send", async () => {
    const result = await runMessageAction({
      cfg: imessageConfig,
      action: "send",
      params: {
        channel: "imessage",
        to: "imessage:+15551234567",
        message: "hi",
      },
      dryRun: true,
    });

    expect(result.kind).toBe("send");
  });

  it("defaults to current channel when target is omitted", async () => {
    const result = await runMessageAction({
      cfg: imessageConfig,
      action: "send",
      params: {
        channel: "imessage",
        message: "hi",
      },
      toolContext: { currentChannelId: "imessage:+15551234567" },
      dryRun: true,
    });

    expect(result.kind).toBe("send");
  });

  it("allows media-only send when target matches current channel", async () => {
    const result = await runMessageAction({
      cfg: imessageConfig,
      action: "send",
      params: {
        channel: "imessage",
        target: "imessage:+15551234567",
        media: "https://example.com/note.ogg",
      },
      toolContext: { currentChannelId: "imessage:+15551234567" },
      dryRun: true,
    });

    expect(result.kind).toBe("send");
  });

  it("requires message when no media hint is provided", async () => {
    await expect(
      runMessageAction({
        cfg: imessageConfig,
        action: "send",
        params: {
          channel: "imessage",
          target: "imessage:+15551234567",
        },
        toolContext: { currentChannelId: "imessage:+15551234567" },
        dryRun: true,
      }),
    ).rejects.toThrow(/message required/i);
  });

  it("blocks send when target differs from current channel", async () => {
    const result = await runMessageAction({
      cfg: imessageConfig,
      action: "send",
      params: {
        channel: "imessage",
        target: "imessage:+15559999999",
        message: "hi",
      },
      toolContext: {
        currentChannelId: "imessage:+15551234567",
        currentChannelProvider: "imessage",
      },
      dryRun: true,
    });

    expect(result.kind).toBe("send");
  });

  it("allows iMessage send when target matches current handle", async () => {
    const result = await runMessageAction({
      cfg: imessageConfig,
      action: "send",
      params: {
        channel: "imessage",
        target: "imessage:+15551234567",
        message: "hi",
      },
      toolContext: { currentChannelId: "imessage:+15551234567" },
      dryRun: true,
    });

    expect(result.kind).toBe("send");
  });

  it("blocks iMessage send when target differs from current handle", async () => {
    const result = await runMessageAction({
      cfg: imessageConfig,
      action: "send",
      params: {
        channel: "imessage",
        target: "imessage:+15551230000",
        message: "hi",
      },
      toolContext: {
        currentChannelId: "imessage:+15551234567",
        currentChannelProvider: "imessage",
      },
      dryRun: true,
    });

    expect(result.kind).toBe("send");
  });

  it("infers channel + target from tool context when missing", async () => {
    const result = await runMessageAction({
      cfg: imessageConfig,
      action: "send",
      params: {
        message: "hi",
      },
      toolContext: {
        currentChannelId: "imessage:+15551234567",
        currentChannelProvider: "imessage",
      },
      dryRun: true,
    });

    expect(result.kind).toBe("send");
    expect(result.channel).toBe("imessage");
  });

  it("blocks cross-provider sends by default", async () => {
    await expect(
      runMessageAction({
        cfg: imessageConfig,
        action: "send",
        params: {
          channel: "feishu",
          target: "ou_abc123",
          message: "hi",
        },
        toolContext: {
          currentChannelId: "imessage:+15551234567",
          currentChannelProvider: "imessage",
        },
        dryRun: true,
      }),
    ).rejects.toThrow(/Cross-context messaging denied/);
  });

  it("aborts send when abortSignal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      runMessageAction({
        cfg: imessageConfig,
        action: "send",
        params: {
          channel: "imessage",
          target: "imessage:+15551234567",
          message: "hi",
        },
        dryRun: true,
        abortSignal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("runMessageAction sendAttachment hydration", () => {
  const attachmentPlugin: ChannelPlugin = {
    id: "bluebubbles",
    meta: {
      id: "bluebubbles",
      label: "BlueBubbles",
      selectionLabel: "BlueBubbles",
      docsPath: "/channels/bluebubbles",
      blurb: "BlueBubbles test plugin.",
    },
    capabilities: { chatTypes: ["direct"], media: true },
    config: {
      listAccountIds: () => ["default"],
      resolveAccount: () => ({ enabled: true }),
      isConfigured: () => true,
    },
    actions: {
      listActions: () => ["sendAttachment"],
      supportsAction: ({ action }) => action === "sendAttachment",
      handleAction: async ({ params }) =>
        jsonResult({
          ok: true,
          buffer: params.buffer,
          filename: params.filename,
          caption: params.caption,
          contentType: params.contentType,
        }),
    },
  };

  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "bluebubbles",
          source: "test",
          plugin: attachmentPlugin,
        },
      ]),
    );
    vi.mocked(loadWebMedia).mockResolvedValue({
      buffer: Buffer.from("hello"),
      contentType: "image/png",
      kind: "image",
      fileName: "pic.png",
    });
  });

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
    vi.clearAllMocks();
  });

  it("hydrates buffer and filename from media for sendAttachment", async () => {
    const cfg = {
      channels: {
        bluebubbles: {
          enabled: true,
          serverUrl: "http://localhost:1234",
          password: "test-password",
        },
      },
    } as FirstClawConfig;

    const result = await runMessageAction({
      cfg,
      action: "sendAttachment",
      params: {
        channel: "bluebubbles",
        target: "+15551234567",
        media: "https://example.com/pic.png",
        message: "caption",
      },
    });

    expect(result.kind).toBe("action");
    expect(result.payload).toMatchObject({
      ok: true,
      filename: "pic.png",
      caption: "caption",
      contentType: "image/png",
    });
    expect((result.payload as { buffer?: string }).buffer).toBe(
      Buffer.from("hello").toString("base64"),
    );
  });

  it("rewrites sandboxed media paths for sendAttachment", async () => {
    const cfg = {
      channels: {
        bluebubbles: {
          enabled: true,
          serverUrl: "http://localhost:1234",
          password: "test-password",
        },
      },
    } as FirstClawConfig;
    const sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), "msg-sandbox-"));
    try {
      await runMessageAction({
        cfg,
        action: "sendAttachment",
        params: {
          channel: "bluebubbles",
          target: "+15551234567",
          media: "./data/pic.png",
          message: "caption",
        },
        sandboxRoot: sandboxDir,
      });

      const call = vi.mocked(loadWebMedia).mock.calls[0];
      expect(call?.[0]).toBe(path.join(sandboxDir, "data", "pic.png"));
    } finally {
      await fs.rm(sandboxDir, { recursive: true, force: true });
    }
  });
});

describe("runMessageAction sandboxed media validation", () => {
  beforeEach(async () => {
    const { createPluginRuntime } = await import("../../plugins/runtime/index.js");
    const { setIMessageRuntime } = await import("../../../extensions/imessage/src/runtime.js");
    const runtime = createPluginRuntime();
    setIMessageRuntime(runtime);
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "imessage", source: "test", plugin: imessagePlugin }]),
    );
  });

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
  });

  it("rejects media outside the sandbox root", async () => {
    const sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), "msg-sandbox-"));
    try {
      await expect(
        runMessageAction({
          cfg: imessageConfig,
          action: "send",
          params: {
            channel: "imessage",
            target: "imessage:+15551234567",
            media: "/etc/passwd",
            message: "",
          },
          sandboxRoot: sandboxDir,
          dryRun: true,
        }),
      ).rejects.toThrow(/sandbox/i);
    } finally {
      await fs.rm(sandboxDir, { recursive: true, force: true });
    }
  });

  it("rejects file:// media outside the sandbox root", async () => {
    const sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), "msg-sandbox-"));
    try {
      await expect(
        runMessageAction({
          cfg: imessageConfig,
          action: "send",
          params: {
            channel: "imessage",
            target: "imessage:+15551234567",
            media: "file:///etc/passwd",
            message: "",
          },
          sandboxRoot: sandboxDir,
          dryRun: true,
        }),
      ).rejects.toThrow(/sandbox/i);
    } finally {
      await fs.rm(sandboxDir, { recursive: true, force: true });
    }
  });

  it("rewrites sandbox-relative media paths", async () => {
    const sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), "msg-sandbox-"));
    try {
      const result = await runMessageAction({
        cfg: imessageConfig,
        action: "send",
        params: {
          channel: "imessage",
          target: "imessage:+15551234567",
          media: "./data/file.txt",
          message: "",
        },
        sandboxRoot: sandboxDir,
        dryRun: true,
      });

      expect(result.kind).toBe("send");
      expect(result.sendResult?.mediaUrl).toBe(path.join(sandboxDir, "data", "file.txt"));
    } finally {
      await fs.rm(sandboxDir, { recursive: true, force: true });
    }
  });

  it("rewrites MEDIA directives under sandbox", async () => {
    const sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), "msg-sandbox-"));
    try {
      const result = await runMessageAction({
        cfg: imessageConfig,
        action: "send",
        params: {
          channel: "imessage",
          target: "imessage:+15551234567",
          message: "Hello\nMEDIA: ./data/note.ogg",
        },
        sandboxRoot: sandboxDir,
        dryRun: true,
      });

      expect(result.kind).toBe("send");
      expect(result.sendResult?.mediaUrl).toBe(path.join(sandboxDir, "data", "note.ogg"));
    } finally {
      await fs.rm(sandboxDir, { recursive: true, force: true });
    }
  });

  it("rejects data URLs in media params", async () => {
    await expect(
      runMessageAction({
        cfg: imessageConfig,
        action: "send",
        params: {
          channel: "imessage",
          target: "imessage:+15551234567",
          media: "data:image/png;base64,abcd",
          message: "",
        },
        dryRun: true,
      }),
    ).rejects.toThrow(/data:/i);
  });
});

describe("runMessageAction accountId defaults", () => {
  const handleAction = vi.fn(async () => jsonResult({ ok: true }));
  const accountPlugin: ChannelPlugin = {
    id: "discord",
    meta: {
      id: "discord",
      label: "Discord",
      selectionLabel: "Discord",
      docsPath: "/channels/discord",
      blurb: "Discord test plugin.",
    },
    capabilities: { chatTypes: ["direct"] },
    config: {
      listAccountIds: () => ["default"],
      resolveAccount: () => ({}),
    },
    actions: {
      listActions: () => ["send"],
      handleAction,
    },
  };

  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "discord",
          source: "test",
          plugin: accountPlugin,
        },
      ]),
    );
    handleAction.mockClear();
  });

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
    vi.clearAllMocks();
  });

  it("propagates defaultAccountId into params", async () => {
    await runMessageAction({
      cfg: {} as FirstClawConfig,
      action: "send",
      params: {
        channel: "discord",
        target: "channel:123",
        message: "hi",
      },
      defaultAccountId: "ops",
    });

    expect(handleAction).toHaveBeenCalled();
    const ctx = handleAction.mock.calls[0]?.[0] as {
      accountId?: string | null;
      params: Record<string, unknown>;
    };
    expect(ctx.accountId).toBe("ops");
    expect(ctx.params.accountId).toBe("ops");
  });
});
