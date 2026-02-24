/**
 * Agent Chatroom Plugin for FirstClaw / OpenClaw
 *
 * Provides:
 *   1. Tools for LLM agents to interact with the multi-agent chatroom.
 *   2. A background daemon that polls the NAS inbox and **automatically
 *      dispatches** incoming messages through the LLM — so the agent
 *      responds without anyone calling a tool first.
 *   3. Orchestration context injection so the LLM knows how to dispatch
 *      tasks to other agents via chatroom channels.
 */

import type { FirstClawPluginApi } from "firstclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import { createReplyPrefixContext, type ReplyPayload } from "firstclaw/plugin-sdk";
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
      const fd = fs.openSync(
        lockPath,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      );
      fs.writeSync(fd, JSON.stringify({ holder, timestamp: nowISO(), expires: timeoutSec }));
      fs.closeSync(fd);
      return true;
    } catch {
      try {
        const lock = readJson(lockPath);
        if (lock?.timestamp) {
          const age = (Date.now() - new Date(lock.timestamp).getTime()) / 1000;
          if (age > timeoutSec) {
            fs.unlinkSync(lockPath);
            continue;
          }
        }
      } catch {
        /* ignore */
      }

      if (i < retries - 1) {
        const waitMs = 1000;
        const start = Date.now();
        while (Date.now() - start < waitMs) {
          /* busy wait */
        }
      }
    }
  }
  return false;
}

function releaseLock(lockPath: string): void {
  try {
    fs.unlinkSync(lockPath);
  } catch {
    /* ignore */
  }
}

// ============================================================================
// Core chatroom operations
// ============================================================================

interface ChatroomConfig {
  nasRoot: string;
  agentId: string;
  localDir: string;
}

interface AgentRegistryEntry {
  agent_id: string;
  display_name: string;
  type: string;
  status: string;
  channels: string[];
}

function chatroomRoot(cfg: ChatroomConfig): string {
  return path.join(cfg.nasRoot, "chatroom");
}

function readAgentRegistry(cfg: ChatroomConfig): AgentRegistryEntry[] {
  const regDir = path.join(chatroomRoot(cfg), "registry");
  if (!fs.existsSync(regDir)) return [];
  const agents: AgentRegistryEntry[] = [];
  for (const file of fs.readdirSync(regDir)) {
    if (!file.endsWith(".json")) continue;
    const data = readJson(path.join(regDir, file));
    if (data?.agent_id) agents.push(data);
  }
  return agents;
}

function parseAtMentions(text: string): string[] {
  const matches = text.match(/@(\w+)/g);
  if (!matches) return [];
  return [...new Set(matches.map((m) => m.slice(1)))];
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

    // Notify channel members + explicitly mentioned agents
    const members: string[] = meta.members ?? [];
    const notifySet = new Set(members);
    for (const m of mentions) notifySet.add(m);
    notifySet.delete(cfg.agentId);

    for (const target of notifySet) {
      const isMentioned = mentions.includes(target);
      const inboxDir = path.join(root, "inbox", target);
      ensureDir(inboxDir);
      const notif = {
        notification_id: randomUUID(),
        timestamp,
        channel_id: channelId,
        message_seq: seq,
        from: cfg.agentId,
        preview: text.slice(0, 120),
        priority: isMentioned ? "high" : "normal",
        mentioned: isMentioned,
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
  return idx.channels.filter(
    (ch: any) => Array.isArray(ch.members) && ch.members.includes(cfg.agentId),
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

interface InboxMessage {
  message_id: string;
  channel_id: string;
  from: string;
  type: string;
  content: { text: string; mentions: string[] };
  timestamp: string;
  seq: number;
  metadata?: Record<string, any>;
}

function pollInbox(cfg: ChatroomConfig): InboxMessage[] {
  const root = chatroomRoot(cfg);
  const inboxDir = path.join(root, "inbox", cfg.agentId);
  if (!fs.existsSync(inboxDir)) return [];

  const files = fs
    .readdirSync(inboxDir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  const messages: InboxMessage[] = [];

  for (const file of files) {
    const filePath = path.join(inboxDir, file);
    try {
      const notif = readJson(filePath);
      if (!notif) continue;

      const msgDir = path.join(root, "channels", notif.channel_id, "messages");
      if (fs.existsSync(msgDir)) {
        const msgFiles = fs
          .readdirSync(msgDir)
          .filter((f) => f.startsWith(String(notif.message_seq).padStart(6, "0")));
        if (msgFiles.length > 0) {
          const fullMsg = readJson(path.join(msgDir, msgFiles[0]));
          if (fullMsg) messages.push(fullMsg);
        }
      }
      fs.unlinkSync(filePath);
    } catch {
      /* skip */
    }
  }

  return messages;
}

// ============================================================================
// Orchestration context: tell the LLM what agents / channels exist
// ============================================================================

function buildChatroomContext(cfg: ChatroomConfig): string {
  const agents = readAgentRegistry(cfg);
  const channels = listAgentChannels(cfg);

  const otherAgents = agents.filter((a) => a.agent_id !== cfg.agentId);
  if (otherAgents.length === 0 && channels.length === 0) return "";

  const lines: string[] = [
    `[Chatroom Orchestration Context]`,
    `You are ${cfg.agentId}, the orchestrator of a multi-agent team.`,
    `When a human gives you a task, you MUST break it down and dispatch sub-tasks to the appropriate agents using the chatroom_send_message tool.`,
    `Do NOT just reply in text — actually call the tool to send messages.`,
    ``,
    `Available agents:`,
  ];

  for (const a of otherAgents) {
    const dmChannel = `dm_${a.agent_id}`;
    const hasDM = channels.some((ch) => ch.channel_id === dmChannel);
    const statusIcon =
      a.status === "idle"
        ? "🟢"
        : a.status === "working"
          ? "🔵"
          : a.status === "offline"
            ? "🔴"
            : "🟡";
    lines.push(
      `  ${statusIcon} ${a.agent_id} (${a.display_name}) — ${hasDM ? `DM: ${dmChannel}` : "no DM channel"}`,
    );
  }

  lines.push(``);
  lines.push(`Channels you belong to:`);
  for (const ch of channels) {
    lines.push(`  #${ch.channel_id} (${ch.type}) — members: ${ch.members?.join(", ")}`);
  }

  lines.push(``);
  lines.push(`How to orchestrate:`);
  lines.push(
    `  1. To assign a task to an agent: call chatroom_send_message with channel_id set to their DM channel (e.g. "dm_art") and mentions set to ["art"]. Write your task instructions in the text field.`,
  );
  lines.push(
    `  2. To broadcast to all agents: call chatroom_send_message with channel_id="general" and mention the relevant agents.`,
  );
  lines.push(`  3. After dispatching, reply to the human confirming what you've done.`);
  lines.push(
    `  4. When agents report results (RESULT_REPORT messages), summarize and relay to the human.`,
  );
  lines.push(``);

  return lines.join("\n");
}

// ============================================================================
// Auto-dispatch: push inbox messages through the LLM pipeline
// ============================================================================

async function autoDispatchMessage(
  chatroomCfg: ChatroomConfig,
  msg: InboxMessage,
  runtime: any,
  config: any,
  logger: {
    info: (...a: any[]) => void;
    warn: (...a: any[]) => void;
    error: (...a: any[]) => void;
  },
): Promise<void> {
  const channelId = msg.channel_id;
  const isDM = channelId.startsWith("dm_");

  const route = runtime.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: "chatroom",
    peer: {
      kind: isDM ? "direct" : "group",
      id: channelId,
    },
  });

  const senderLabel = msg.from.startsWith("human:")
    ? `[Human] ${msg.from.slice("human:".length)}`
    : msg.from;

  const chatroomContext = buildChatroomContext(chatroomCfg);
  const messageBody = `[Chatroom #${channelId}] ${senderLabel}: ${msg.content.text}`;
  const bodyForAgent = chatroomContext ? `${chatroomContext}\n${messageBody}` : messageBody;

  const ctxPayload = runtime.channel.reply.finalizeInboundContext({
    Body: bodyForAgent,
    BodyForAgent: bodyForAgent,
    RawBody: msg.content.text,
    CommandBody: msg.content.text,
    From: `chatroom:${msg.from}`,
    To: `chatroom:${chatroomCfg.agentId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isDM ? "direct" : "group",
    SenderName: senderLabel,
    SenderId: msg.from,
    Provider: "chatroom",
    Surface: "chatroom",
    MessageSid: msg.message_id,
    Timestamp: Date.now(),
    CommandAuthorized: true,
  });

  const prefixContext = createReplyPrefixContext({
    cfg: config,
    agentId: route.agentId,
  });

  const dispatcherOptions = {
    responsePrefix: prefixContext.responsePrefix,
    responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
    deliver: async (payload: ReplyPayload) => {
      const text = payload.text ?? "";
      if (!text.trim()) return;
      try {
        const inlineMentions = parseAtMentions(text);
        const result = sendMessageToNAS(chatroomCfg, channelId, text, "CHAT", inlineMentions);
        logger.info(
          `Auto-reply sent to ${channelId} (seq: ${result.seq}, mentions: [${inlineMentions.join(",")}])`,
        );
      } catch (err) {
        logger.error(`Failed to send auto-reply to ${channelId}: ${err}`);
      }
    },
    onError: (err: any, info: any) => {
      logger.error(`Dispatch error (${info?.kind}): ${err}`);
    },
  };

  logger.info(
    `Dispatching message from ${msg.from} in ${channelId} to LLM (session=${route.sessionKey})`,
  );

  await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: config,
    dispatcherOptions,
    replyOptions: {
      onModelSelected: prefixContext.onModelSelected,
    },
  });
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

    const runtime = api.runtime;
    const config = api.config;
    const logger = {
      info: (...args: any[]) => api.logger.info(`[chatroom] ${args.join(" ")}`),
      warn: (...args: any[]) => api.logger.warn(`[chatroom] ${args.join(" ")}`),
      error: (...args: any[]) => api.logger.error(`[chatroom] ${args.join(" ")}`),
    };

    // -- Tool: check inbox --------------------------------------------------

    api.registerTool(
      {
        name: "chatroom_check_inbox",
        label: "Chatroom: Check Inbox",
        description:
          "Check for new messages in the agent chatroom. Returns a list of messages " +
          "from the orchestrator (FirstClaw) or broadcast channels. " +
          "NOTE: Incoming messages are also auto-dispatched, so you usually " +
          "do not need to call this manually.",
        parameters: Type.Object({}),
        async execute(_toolCallId, _params) {
          try {
            const nasMessages = pollInbox(cfg);
            updateHeartbeat(cfg);

            if (nasMessages.length === 0) {
              return {
                content: [{ type: "text" as const, text: "No new messages." }],
                details: undefined,
              };
            }

            const all = nasMessages.map((m) => ({
              channel: m.channel_id,
              from: m.from,
              type: m.type,
              text: m.content?.text ?? "",
              mentions: m.content?.mentions ?? [],
              timestamp: m.timestamp,
              message_id: m.message_id,
            }));

            return {
              content: [
                {
                  type: "text" as const,
                  text: `${all.length} new message(s):\n${JSON.stringify(all, null, 2)}`,
                },
              ],
              details: all,
            };
          } catch (err) {
            return {
              content: [{ type: "text" as const, text: `Error checking inbox: ${err}` }],
              details: undefined,
            };
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
          "Send a message to a chatroom channel. This is your PRIMARY tool for orchestration.\n\n" +
          "To dispatch a task to an agent, send to their DM channel with a mention:\n" +
          "  - channel_id: 'dm_art', mentions: ['art']   → assigns work to the art agent\n" +
          "  - channel_id: 'dm_audio', mentions: ['audio'] → assigns work to the audio agent\n" +
          "  - channel_id: 'dm_gamedev', mentions: ['gamedev'] → assigns work to the gamedev agent\n" +
          "  - channel_id: 'dm_uiux', mentions: ['uiux']  → assigns work to the UIUX agent\n" +
          "  - channel_id: 'general', mentions: ['art','audio'] → broadcast to specific agents\n\n" +
          "Mentioned agents receive high-priority inbox notifications and will respond automatically.",
        parameters: Type.Object({
          channel_id: Type.String({
            description:
              "Target channel ID. Use DM channels (dm_art, dm_audio, dm_gamedev, dm_uiux) for private task dispatch, or 'general'/'pipeline' for broadcasts.",
          }),
          text: Type.String({
            description: "Message content — task instructions, questions, or status updates",
          }),
          mentions: Type.Optional(
            Type.Array(Type.String(), {
              description:
                "Agent IDs to mention — they will receive high-priority notifications (e.g. ['art'], ['gamedev', 'uiux'])",
            }),
          ),
          type: Type.Optional(
            Type.String({
              description: "Message type: CHAT (default), TASK_DISPATCH, STATUS_UPDATE",
            }),
          ),
        }),
        async execute(_toolCallId, params) {
          try {
            const p = params as {
              channel_id: string;
              text: string;
              mentions?: string[];
              type?: string;
            };
            const result = sendMessageToNAS(
              cfg,
              p.channel_id,
              p.text,
              p.type ?? "CHAT",
              p.mentions ?? [],
            );
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Message sent to #${p.channel_id} (seq: ${result.seq}${p.mentions?.length ? `, mentioned: ${p.mentions.join(",")}` : ""})`,
                },
              ],
              details: result,
            };
          } catch (err) {
            return {
              content: [{ type: "text" as const, text: `Error sending message: ${err}` }],
              details: undefined,
            };
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
        description: "List all chatroom channels this agent belongs to, including members.",
        parameters: Type.Object({}),
        async execute(_toolCallId, _params) {
          try {
            const channels = listAgentChannels(cfg);
            const text = JSON.stringify(
              channels.map((ch: any) => ({
                id: ch.channel_id,
                name: ch.display_name,
                type: ch.type,
                members: ch.members,
              })),
              null,
              2,
            );
            return { content: [{ type: "text" as const, text }], details: undefined };
          } catch (err) {
            return {
              content: [{ type: "text" as const, text: `Error listing channels: ${err}` }],
              details: undefined,
            };
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
        async execute(_toolCallId, params) {
          try {
            const p = params as {
              channel_id: string;
              text: string;
              task_id: string;
              status?: string;
              asset_paths?: string[];
            };
            const result = sendMessageToNAS(
              cfg,
              p.channel_id,
              p.text,
              "RESULT_REPORT",
              ["firstclaw"],
              undefined,
              {
                task_id: p.task_id,
                status: p.status ?? "DONE",
                asset_paths: p.asset_paths ?? [],
              },
            );
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Result reported for task ${p.task_id} (status: ${p.status ?? "DONE"}, seq: ${result.seq})`,
                },
              ],
              details: result,
            };
          } catch (err) {
            return {
              content: [{ type: "text" as const, text: `Error reporting result: ${err}` }],
              details: undefined,
            };
          }
        },
      },
      { names: ["chatroom_report_result"] },
    );

    // -- Background service: heartbeat + auto-dispatch polling ---------------

    const pollIntervalMs = (pluginCfg.pollIntervalMs as number) ?? 3000;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    api.registerService({
      id: "chatroom-daemon",
      start: async () => {
        logger.info(`Chatroom daemon started for agent=${agentId} (auto-dispatch enabled)`);
        updateHeartbeat(cfg);

        heartbeatTimer = setInterval(() => {
          try {
            updateHeartbeat(cfg);
          } catch {
            /* ignore */
          }
        }, 30_000);

        pollTimer = setInterval(async () => {
          try {
            const messages = pollInbox(cfg);
            for (const msg of messages) {
              try {
                await autoDispatchMessage(cfg, msg, runtime, config, logger);
              } catch (err) {
                logger.error(`Auto-dispatch failed for ${msg.message_id}: ${err}`);
              }
            }
          } catch {
            /* ignore */
          }
        }, pollIntervalMs);
      },
      stop: async () => {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        if (pollTimer) clearInterval(pollTimer);
        logger.info("Chatroom daemon stopped");
      },
    });
  },
};

export default agentChatroomPlugin;
