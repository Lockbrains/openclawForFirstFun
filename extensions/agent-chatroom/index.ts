/**
 * Agent Chatroom Plugin for FirstClaw / OpenClaw
 *
 * Provides tools for LLM agents to participate in the multi-agent chatroom:
 *   - chatroom_check_inbox: Read new messages from other agents / orchestrator
 *   - chatroom_send_message: Send a message to a chatroom channel
 *   - chatroom_list_channels: List channels this agent belongs to
 *   - chatroom_report_result: Report task completion to the orchestrator
 *
 * Also runs a background daemon (heartbeat + inbox polling) as a plugin service.
 */

import type { FirstClawPluginApi } from "firstclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as path from "node:path";

// ============================================================================
// NAS file helpers
// ============================================================================

function readJson(filePath: string): any {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function writeJson(filePath: string, data: any): void {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function randomUUID(): string {
  return crypto.randomUUID();
}

function nowISO(): string {
  return new Date().toISOString();
}

// ============================================================================
// File lock (matches Python SDK behaviour)
// ============================================================================

function acquireLock(lockPath: string, holder: string, timeoutSec = 30, retries = 5): boolean {
  for (let i = 0; i < retries; i++) {
    try {
      const fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
      fs.writeSync(fd, JSON.stringify({ holder, timestamp: nowISO(), expires: timeoutSec }));
      fs.closeSync(fd);
      return true;
    } catch {
      // Check for stale lock
      try {
        const lock = readJson(lockPath);
        if (lock?.timestamp) {
          const age = (Date.now() - new Date(lock.timestamp).getTime()) / 1000;
          if (age > timeoutSec) {
            fs.unlinkSync(lockPath);
            continue;
          }
        }
      } catch { /* ignore */ }

      if (i < retries - 1) {
        const waitMs = 1000;
        const start = Date.now();
        while (Date.now() - start < waitMs) { /* busy wait */ }
      }
    }
  }
  return false;
}

function releaseLock(lockPath: string): void {
  try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
}

// ============================================================================
// Core chatroom operations
// ============================================================================

interface ChatroomConfig {
  nasRoot: string;
  agentId: string;
  localDir: string;
}

function chatroomRoot(cfg: ChatroomConfig): string {
  return path.join(cfg.nasRoot, "chatroom");
}

function readPendingMessages(cfg: ChatroomConfig): any[] {
  const pendingPath = path.join(cfg.localDir, "pending_messages.jsonl");
  if (!fs.existsSync(pendingPath)) return [];
  const lines = fs.readFileSync(pendingPath, "utf-8").split("\n").filter(l => l.trim());
  const messages: any[] = [];
  for (const line of lines) {
    try { messages.push(JSON.parse(line)); } catch { /* skip */ }
  }
  return messages;
}

function clearPendingMessages(cfg: ChatroomConfig): void {
  const pendingPath = path.join(cfg.localDir, "pending_messages.jsonl");
  try { fs.unlinkSync(pendingPath); } catch { /* ignore */ }
}

function sendMessageToNAS(
  cfg: ChatroomConfig,
  channelId: string,
  text: string,
  msgType: string = "CHAT",
  mentions: string[] = [],
  replyTo?: string,
  metadata?: Record<string, any>,
): { message_id: string; seq: number } {
  const root = chatroomRoot(cfg);
  const chDir = path.join(root, "channels", channelId);
  const msgDir = path.join(chDir, "messages");
  const metaPath = path.join(chDir, "meta.json");
  const lockPath = path.join(chDir, ".lock");

  ensureDir(msgDir);

  if (!acquireLock(lockPath, cfg.agentId)) {
    throw new Error(`Failed to acquire lock for channel ${channelId}`);
  }

  try {
    const meta = readJson(metaPath) ?? { last_message_seq: 0, message_count: 0 };
    const seq = (meta.last_message_seq ?? 0) + 1;
    const messageId = randomUUID();
    const timestamp = nowISO();
    const tsCompact = timestamp.replace(/[-:]/g, "").replace(/\.\d+/, "").replace("T", "T");

    const msg = {
      message_id: messageId,
      seq,
      timestamp,
      channel_id: channelId,
      from: cfg.agentId,
      type: msgType,
      content: { text, mentions, attachments: [] },
      reply_to: replyTo ?? null,
      metadata: { priority: "normal", ...(metadata ?? {}) },
    };

    const filename = `${String(seq).padStart(6, "0")}_${tsCompact}_${messageId}.json`;
    writeJson(path.join(msgDir, filename), msg);

    meta.last_message_seq = seq;
    meta.message_count = (meta.message_count ?? 0) + 1;
    writeJson(metaPath, meta);

    // Notify channel members via inbox
    const members: string[] = meta.members ?? [];
    for (const member of members) {
      if (member === cfg.agentId) continue;
      const inboxDir = path.join(root, "inbox", member);
      ensureDir(inboxDir);
      const notif = {
        notification_id: randomUUID(),
        timestamp,
        channel_id: channelId,
        message_seq: seq,
        from: cfg.agentId,
        preview: text.slice(0, 120),
        priority: "normal",
      };
      writeJson(
        path.join(inboxDir, `${String(seq).padStart(6, "0")}_${notif.notification_id}.json`),
        notif,
      );
    }

    return { message_id: messageId, seq };
  } finally {
    releaseLock(lockPath);
  }
}

function listAgentChannels(cfg: ChatroomConfig): any[] {
  const indexPath = path.join(chatroomRoot(cfg), "channels", "_index.json");
  const idx = readJson(indexPath);
  if (!idx?.channels) return [];
  return idx.channels.filter((ch: any) =>
    Array.isArray(ch.members) && ch.members.includes(cfg.agentId)
  );
}

function updateHeartbeat(cfg: ChatroomConfig): void {
  const regPath = path.join(chatroomRoot(cfg), "registry", `${cfg.agentId}.json`);
  const info = readJson(regPath);
  if (!info) return;
  info.last_heartbeat = nowISO();
  if (info.status === "offline") info.status = "idle";
  writeJson(regPath, info);
}

function pollInbox(cfg: ChatroomConfig): any[] {
  const root = chatroomRoot(cfg);
  const inboxDir = path.join(root, "inbox", cfg.agentId);
  if (!fs.existsSync(inboxDir)) return [];

  const files = fs.readdirSync(inboxDir).filter(f => f.endsWith(".json")).sort();
  const messages: any[] = [];

  for (const file of files) {
    const filePath = path.join(inboxDir, file);
    try {
      const notif = readJson(filePath);
      if (!notif) continue;

      // Fetch full message from channel
      const msgDir = path.join(root, "channels", notif.channel_id, "messages");
      if (fs.existsSync(msgDir)) {
        const msgFiles = fs.readdirSync(msgDir).filter(f => f.startsWith(String(notif.message_seq).padStart(6, "0")));
        if (msgFiles.length > 0) {
          const fullMsg = readJson(path.join(msgDir, msgFiles[0]));
          if (fullMsg) messages.push(fullMsg);
        }
      }
      fs.unlinkSync(filePath);
    } catch { /* skip */ }
  }

  // Also write to local queue for compatibility with Python daemon
  if (messages.length > 0) {
    const pendingPath = path.join(cfg.localDir, "pending_messages.jsonl");
    ensureDir(cfg.localDir);
    const lines = messages.map(m => JSON.stringify(m)).join("\n") + "\n";
    fs.appendFileSync(pendingPath, lines, "utf-8");
  }

  return messages;
}

// ============================================================================
// Plugin definition
// ============================================================================

const agentChatroomPlugin = {
  id: "agent-chatroom",
  name: "Agent Chatroom",
  description: "Multi-agent collaboration chatroom over shared NAS",

  register(api: FirstClawPluginApi) {
    const pluginCfg = (api.pluginConfig ?? {}) as Record<string, any>;
    const nasRoot = pluginCfg.nasRoot as string;
    const agentId = pluginCfg.agentId as string;

    if (!nasRoot || !agentId) {
      api.logger.warn(
        "agent-chatroom: nasRoot and agentId are required in plugin config. Tools disabled.",
      );
      return;
    }

    const cfg: ChatroomConfig = {
      nasRoot,
      agentId,
      localDir: (pluginCfg.localDir as string) ?? "./chatroom_local",
    };

    ensureDir(cfg.localDir);

    // -- Tool: check inbox --------------------------------------------------

    api.registerTool(
      {
        name: "chatroom_check_inbox",
        label: "Chatroom: Check Inbox",
        description:
          "Check for new messages in the agent chatroom. Returns a list of messages " +
          "from the orchestrator (FirstClaw) or broadcast channels. Call this periodically " +
          "to stay in sync with the team.",
        parameters: Type.Object({}),
        execute: async () => {
          try {
            // Poll NAS inbox directly (in case daemon isn't running)
            const nasMessages = pollInbox(cfg);

            // Also read any locally queued messages
            const localMessages = readPendingMessages(cfg);
            clearPendingMessages(cfg);

            // Deduplicate by message_id
            const seen = new Set<string>();
            const all: any[] = [];
            for (const m of [...nasMessages, ...localMessages]) {
              const id = m.message_id;
              if (id && !seen.has(id)) {
                seen.add(id);
                all.push({
                  channel: m.channel_id,
                  from: m.from,
                  type: m.type,
                  text: m.content?.text ?? "",
                  mentions: m.content?.mentions ?? [],
                  timestamp: m.timestamp,
                  message_id: m.message_id,
                });
              }
            }

            updateHeartbeat(cfg);

            if (all.length === 0) {
              return { content: "No new messages." };
            }
            return {
              content: `${all.length} new message(s):\n${JSON.stringify(all, null, 2)}`,
            };
          } catch (err) {
            return { content: `Error checking inbox: ${err}` };
          }
        },
      },
      { names: ["chatroom_check_inbox"] },
    );

    // -- Tool: send message -------------------------------------------------

    api.registerTool(
      {
        name: "chatroom_send_message",
        label: "Chatroom: Send Message",
        description:
          "Send a message to a chatroom channel. Use this to reply to the orchestrator " +
          "(FirstClaw), participate in group discussions, or report progress. " +
          "Common channels: dm_art (private with orchestrator), general (everyone).",
        parameters: Type.Object({
          channel_id: Type.String({
            description: "Target channel ID (e.g. 'dm_art', 'general', 'pipeline')",
          }),
          text: Type.String({ description: "Message content" }),
          mentions: Type.Optional(
            Type.Array(Type.String(), {
              description: "Agent IDs to mention (e.g. ['firstclaw'])",
            }),
          ),
        }),
        execute: async (_toolCallId, params) => {
          try {
            const result = sendMessageToNAS(
              cfg,
              params.channel_id,
              params.text,
              "CHAT",
              params.mentions ?? [],
            );
            return {
              content: `Message sent to ${params.channel_id} (seq: ${result.seq})`,
            };
          } catch (err) {
            return { content: `Error sending message: ${err}` };
          }
        },
      },
      { names: ["chatroom_send_message"] },
    );

    // -- Tool: list channels ------------------------------------------------

    api.registerTool(
      {
        name: "chatroom_list_channels",
        label: "Chatroom: List Channels",
        description: "List all chatroom channels this agent belongs to.",
        parameters: Type.Object({}),
        execute: async () => {
          try {
            const channels = listAgentChannels(cfg);
            return {
              content: JSON.stringify(
                channels.map((ch: any) => ({
                  id: ch.channel_id,
                  name: ch.display_name,
                  type: ch.type,
                  members: ch.members,
                })),
                null,
                2,
              ),
            };
          } catch (err) {
            return { content: `Error listing channels: ${err}` };
          }
        },
      },
      { names: ["chatroom_list_channels"] },
    );

    // -- Tool: report task result -------------------------------------------

    api.registerTool(
      {
        name: "chatroom_report_result",
        label: "Chatroom: Report Task Result",
        description:
          "Report the completion (or failure) of a task back to the orchestrator (FirstClaw). " +
          "Use this when you finish a task that was assigned to you.",
        parameters: Type.Object({
          channel_id: Type.String({
            description: "Channel to report in (usually your DM channel, e.g. 'dm_art')",
          }),
          text: Type.String({ description: "Summary of what was accomplished" }),
          task_id: Type.String({ description: "The task ID being reported on" }),
          status: Type.Optional(
            Type.String({
              description: "Task status: DONE or FAILED (default: DONE)",
            }),
          ),
          asset_paths: Type.Optional(
            Type.Array(Type.String(), {
              description: "Paths to produced assets/files",
            }),
          ),
        }),
        execute: async (_toolCallId, params) => {
          try {
            const result = sendMessageToNAS(
              cfg,
              params.channel_id,
              params.text,
              "RESULT_REPORT",
              ["firstclaw"],
              undefined,
              {
                task_id: params.task_id,
                status: params.status ?? "DONE",
                asset_paths: params.asset_paths ?? [],
              },
            );
            return {
              content: `Result reported for task ${params.task_id} (status: ${params.status ?? "DONE"}, seq: ${result.seq})`,
            };
          } catch (err) {
            return { content: `Error reporting result: ${err}` };
          }
        },
      },
      { names: ["chatroom_report_result"] },
    );

    // -- Background service: heartbeat + polling ----------------------------

    const pollIntervalMs = (pluginCfg.pollIntervalMs as number) ?? 3000;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    api.registerService({
      id: "chatroom-daemon",
      start: async () => {
        api.logger.info(`Chatroom daemon started for agent=${agentId}`);
        updateHeartbeat(cfg);

        heartbeatTimer = setInterval(() => {
          try { updateHeartbeat(cfg); } catch { /* ignore */ }
        }, 30_000);

        pollTimer = setInterval(() => {
          try { pollInbox(cfg); } catch { /* ignore */ }
        }, pollIntervalMs);
      },
      stop: async () => {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        if (pollTimer) clearInterval(pollTimer);
        api.logger.info("Chatroom daemon stopped");
      },
    });
  },
};

export default agentChatroomPlugin;
