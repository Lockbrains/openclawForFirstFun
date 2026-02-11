import { beforeEach, describe, expect, it } from "vitest";
import { imessagePlugin } from "../../extensions/imessage/src/channel.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { extractMessagingToolSend } from "./pi-embedded-subscribe.tools.js";

describe("extractMessagingToolSend", () => {
  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "imessage", plugin: imessagePlugin, source: "test" }]),
    );
  });

  it("uses channel as provider for message tool", () => {
    const result = extractMessagingToolSend("message", {
      action: "send",
      channel: "imessage",
      to: "+15551234567",
    });

    expect(result?.tool).toBe("message");
    expect(result?.provider).toBe("imessage");
    expect(result?.to).toContain("15551234567");
  });

  it("prefers provider when both provider and channel are set", () => {
    const result = extractMessagingToolSend("message", {
      action: "send",
      provider: "feishu",
      channel: "imessage",
      to: "ou_abc123",
    });

    expect(result?.tool).toBe("message");
    expect(result?.provider).toBe("feishu");
    expect(result?.to).toBe("ou_abc123");
  });
});
