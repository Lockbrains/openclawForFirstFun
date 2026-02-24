/**
 * Agent Chatroom Plugin for FirstClaw / OpenClaw
 *
 * Provides:
 *   1. Tools for LLM agents to interact with the multi-agent chatroom.
 *   2. A background daemon that polls the NAS inbox and **automatically
 *      dispatches** incoming messages through the LLM.
 *   3. A reliable **Task Dispatch Protocol** with system-level ACK handshake:
 *
 *        Orchestrator                Target Agent
 *             │                           │
 *             │── TASK_DISPATCH ─────────>│  ① assign task
 *             │                           │
 *             │<── TASK_ACK (system) ─────│  ② instant ACK (no LLM)
 *             │                           │
 *             │    [LLM processes task]   │
 *             │                           │
 *             │<── RESULT_REPORT ─────────│  ③ deliver result
 *             │                           │
 */

import type { FirstClawPluginApi } from "firstclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import { createReplyPrefixContext, type ReplyPayload } from "firstclaw/plugin-sdk";
import * as fs from "node:fs";
import * as path from "node:path";

// ============================================================================
// Types
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

type TaskStatus =
  | "DISPATCHED"
  | "ACKED"
  | "PROCESSING"
  | "DONE"
  | "FAILED"
  | "TIMEOUT"
  | "ABANDONED";

interface TaskRecord {
  task_id: string;
  from: string;
  to: string;
  channel_id: string;
  status: TaskStatus;
  instruction: string;
  dispatched_at: string;
  acked_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  result_summary: string | null;
  asset_paths: string[];
  retries: number;
  max_retries: number;
  ack_timeout_ms: number;
  task_timeout_ms: number;
}

interface Logger {
  info: (...a: any[]) => void;
  warn: (...a: any[]) => void;
  error: (...a: any[]) => void;
}

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
// File lock
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
        const start = Date.now();
        while (Date.now() - start < 1000) {
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

function chatroomRoot(cfg: ChatroomConfig): string {
  return path.join(cfg.nasRoot, "chatroom");
}

function tasksDir(cfg: ChatroomConfig): string {
  return path.join(chatroomRoot(cfg), "tasks");
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
        const prefix = String(notif.message_seq).padStart(6, "0");
        const msgFiles = fs.readdirSync(msgDir).filter((f) => f.startsWith(prefix));
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
// Task Registry — persistent task state on NAS
// ============================================================================

function createTaskRecord(
  cfg: ChatroomConfig,
  to: string,
  channelId: string,
  instruction: string,
  opts?: { ackTimeoutMs?: number; taskTimeoutMs?: number; maxRetries?: number },
): TaskRecord {
  const dir = tasksDir(cfg);
  ensureDir(dir);

  const task: TaskRecord = {
    task_id: randomUUID(),
    from: cfg.agentId,
    to,
    channel_id: channelId,
    status: "DISPATCHED",
    instruction,
    dispatched_at: nowISO(),
    acked_at: null,
    started_at: null,
    completed_at: null,
    result_summary: null,
    asset_paths: [],
    retries: 0,
    max_retries: opts?.maxRetries ?? 3,
    ack_timeout_ms: opts?.ackTimeoutMs ?? 30_000,
    task_timeout_ms: opts?.taskTimeoutMs ?? 600_000,
  };

  writeJson(path.join(dir, `${task.task_id}.json`), task);
  return task;
}

function readTaskRecord(cfg: ChatroomConfig, taskId: string): TaskRecord | null {
  return readJson(path.join(tasksDir(cfg), `${taskId}.json`));
}

function updateTaskRecord(cfg: ChatroomConfig, taskId: string, patch: Partial<TaskRecord>): void {
  const filePath = path.join(tasksDir(cfg), `${taskId}.json`);
  const existing = readJson(filePath);
  if (!existing) return;
  writeJson(filePath, { ...existing, ...patch });
}

function listTasksByStatus(cfg: ChatroomConfig, ...statuses: TaskStatus[]): TaskRecord[] {
  const dir = tasksDir(cfg);
  if (!fs.existsSync(dir)) return [];

  const statusSet = new Set(statuses);
  const tasks: TaskRecord[] = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    const task = readJson(path.join(dir, file)) as TaskRecord | null;
    if (task && statusSet.has(task.status)) tasks.push(task);
  }
  return tasks;
}

// ============================================================================
// Task Protocol: dispatch, ACK, result
// ============================================================================

function dispatchTask(
  cfg: ChatroomConfig,
  to: string,
  instruction: string,
  logger: Logger,
  opts?: { ackTimeoutMs?: number; taskTimeoutMs?: number; maxRetries?: number },
): TaskRecord {
  const channelId = `dm_${to}`;
  const task = createTaskRecord(cfg, to, channelId, instruction, opts);

  sendMessageToNAS(cfg, channelId, instruction, "TASK_DISPATCH", [to], undefined, {
    task_id: task.task_id,
    priority: "urgent",
  });

  logger.info(`Task ${task.task_id} dispatched to ${to} via #${channelId}`);
  return task;
}

function sendSystemAck(cfg: ChatroomConfig, task: TaskRecord, logger: Logger): void {
  const ackText = `[SYSTEM] Task ${task.task_id} acknowledged by ${cfg.agentId}`;
  sendMessageToNAS(cfg, task.channel_id, ackText, "TASK_ACK", [task.from], undefined, {
    task_id: task.task_id,
  });
  updateTaskRecord(cfg, task.task_id, { status: "ACKED", acked_at: nowISO() });
  logger.info(`ACK sent for task ${task.task_id} → ${task.from}`);
}

function sendTaskResult(
  cfg: ChatroomConfig,
  taskId: string,
  resultText: string,
  status: "DONE" | "FAILED",
  logger: Logger,
  assetPaths: string[] = [],
): void {
  const task = readTaskRecord(cfg, taskId);
  if (!task) {
    logger.warn(`Cannot send result — task ${taskId} not found`);
    return;
  }
  sendMessageToNAS(cfg, task.channel_id, resultText, "RESULT_REPORT", [task.from], undefined, {
    task_id: taskId,
    status,
    asset_paths: assetPaths,
  });
  updateTaskRecord(cfg, taskId, {
    status,
    completed_at: nowISO(),
    result_summary: resultText.slice(0, 500),
    asset_paths: assetPaths,
  });
  logger.info(`Result sent for task ${taskId} (${status}) → ${task.from}`);
}

// ============================================================================
// Daemon message handlers — route by message type
// ============================================================================

function handleIncomingTask(
  cfg: ChatroomConfig,
  msg: InboxMessage,
  runtime: any,
  config: any,
  logger: Logger,
): void {
  const taskId = msg.metadata?.task_id;
  if (!taskId) {
    logger.warn(`TASK_DISPATCH without task_id from ${msg.from}, ignoring`);
    return;
  }

  const task = readTaskRecord(cfg, taskId);
  if (!task) {
    logger.warn(`Task ${taskId} not found on NAS, creating local record`);
    const dir = tasksDir(cfg);
    ensureDir(dir);
    const synthetic: TaskRecord = {
      task_id: taskId,
      from: msg.from,
      to: cfg.agentId,
      channel_id: msg.channel_id,
      status: "DISPATCHED",
      instruction: msg.content.text,
      dispatched_at: msg.timestamp,
      acked_at: null,
      started_at: null,
      completed_at: null,
      result_summary: null,
      asset_paths: [],
      retries: 0,
      max_retries: 3,
      ack_timeout_ms: 30_000,
      task_timeout_ms: 600_000,
    };
    writeJson(path.join(dir, `${taskId}.json`), synthetic);
  }

  const currentTask = readTaskRecord(cfg, taskId)!;
  sendSystemAck(cfg, currentTask, logger);

  updateTaskRecord(cfg, taskId, { status: "PROCESSING", started_at: nowISO() });
  logger.info(`Processing task ${taskId} from ${msg.from}: "${msg.content.text.slice(0, 80)}..."`);

  autoDispatchForTask(cfg, msg, taskId, runtime, config, logger);
}

function handleTaskAck(cfg: ChatroomConfig, msg: InboxMessage, logger: Logger): void {
  const taskId = msg.metadata?.task_id;
  if (!taskId) return;

  const task = readTaskRecord(cfg, taskId);
  if (!task) return;

  if (task.status === "DISPATCHED" || task.status === "TIMEOUT") {
    updateTaskRecord(cfg, taskId, { status: "ACKED", acked_at: nowISO() });
    logger.info(`Task ${taskId} ACK received from ${msg.from}`);
  }
}

function handleTaskResult(cfg: ChatroomConfig, msg: InboxMessage, logger: Logger): void {
  const taskId = msg.metadata?.task_id;
  if (!taskId) return;

  const task = readTaskRecord(cfg, taskId);
  if (!task) return;

  const resultStatus = (msg.metadata?.status as TaskStatus) || "DONE";
  updateTaskRecord(cfg, taskId, {
    status: resultStatus,
    completed_at: nowISO(),
    result_summary: msg.content.text.slice(0, 500),
    asset_paths: msg.metadata?.asset_paths ?? [],
  });
  logger.info(`Task ${taskId} result received from ${msg.from} (${resultStatus})`);
}

// ============================================================================
// ACK timeout monitoring
// ============================================================================

function monitorPendingTasks(cfg: ChatroomConfig, logger: Logger): void {
  const pending = listTasksByStatus(cfg, "DISPATCHED", "TIMEOUT");
  const now = Date.now();

  for (const task of pending) {
    if (task.from !== cfg.agentId) continue;

    const dispatchedAt = new Date(task.dispatched_at).getTime();
    const elapsed = now - dispatchedAt;

    if (elapsed > task.ack_timeout_ms) {
      if (task.retries >= task.max_retries) {
        updateTaskRecord(cfg, task.task_id, { status: "ABANDONED" });
        sendMessageToNAS(
          cfg,
          task.channel_id,
          `[SYSTEM] Task ${task.task_id} abandoned — ${task.to} did not respond after ${task.max_retries} retries`,
          "SYSTEM",
          [],
        );
        logger.warn(`Task ${task.task_id} ABANDONED (${task.to} unreachable)`);
      } else {
        updateTaskRecord(cfg, task.task_id, {
          status: "TIMEOUT",
          retries: task.retries + 1,
          dispatched_at: nowISO(),
        });
        const root = chatroomRoot(cfg);
        const inboxDir = path.join(root, "inbox", task.to);
        ensureDir(inboxDir);
        const notif = {
          notification_id: randomUUID(),
          timestamp: nowISO(),
          channel_id: task.channel_id,
          message_seq: 0,
          from: cfg.agentId,
          preview: `[RETRY ${task.retries + 1}/${task.max_retries}] ${task.instruction.slice(0, 80)}`,
          priority: "urgent",
          retry_for_task: task.task_id,
        };
        writeJson(
          path.join(inboxDir, `retry_${task.task_id}_${notif.notification_id}.json`),
          notif,
        );
        logger.warn(
          `Task ${task.task_id} ACK timeout — retry ${task.retries + 1}/${task.max_retries} sent to ${task.to}`,
        );
      }
    }
  }

  const processing = listTasksByStatus(cfg, "ACKED", "PROCESSING");
  for (const task of processing) {
    if (task.from !== cfg.agentId) continue;
    const startedAt = new Date(task.started_at ?? task.acked_at ?? task.dispatched_at).getTime();
    if (now - startedAt > task.task_timeout_ms) {
      updateTaskRecord(cfg, task.task_id, { status: "FAILED", completed_at: nowISO() });
      sendMessageToNAS(
        cfg,
        task.channel_id,
        `[SYSTEM] Task ${task.task_id} timed out — ${task.to} did not deliver results within ${Math.round(task.task_timeout_ms / 60000)}min`,
        "SYSTEM",
        [],
      );
      logger.warn(`Task ${task.task_id} TIMED OUT (${task.to})`);
    }
  }
}

// ============================================================================
// Orchestration context
// ============================================================================

function buildChatroomContext(cfg: ChatroomConfig): string {
  const agents = readAgentRegistry(cfg);
  const channels = listAgentChannels(cfg);

  const otherAgents = agents.filter((a) => a.agent_id !== cfg.agentId);
  if (otherAgents.length === 0 && channels.length === 0) return "";

  const lines: string[] = [
    `[Chatroom Orchestration Context]`,
    `You are "${cfg.agentId}". Your role depends on context:`,
    ``,
  ];

  if (otherAgents.length > 0) {
    lines.push(`Available agents:`);
    for (const a of otherAgents) {
      const dmChannel = `dm_${a.agent_id}`;
      const hasDM = channels.some((ch) => ch.channel_id === dmChannel);
      lines.push(
        `  - ${a.agent_id} (${a.display_name}) [${a.status}]${hasDM ? ` — DM: ${dmChannel}` : ""}`,
      );
    }
    lines.push(``);
  }

  lines.push(`Task dispatch protocol:`);
  lines.push(`  When you need another agent to perform work, use the chatroom_dispatch_task tool.`);
  lines.push(`  This sends a formal TASK_DISPATCH with guaranteed delivery + ACK handshake.`);
  lines.push(`  The target agent will auto-ACK and begin processing immediately.`);
  lines.push(``);
  lines.push(`  chatroom_dispatch_task(target="art", instruction="draw a steel dinosaur")`);
  lines.push(``);
  lines.push(`  For general chat, use chatroom_send_message instead.`);
  lines.push(``);

  const activeTasks = listTasksByStatus(cfg, "DISPATCHED", "ACKED", "PROCESSING");
  if (activeTasks.length > 0) {
    lines.push(`Active tasks:`);
    for (const t of activeTasks) {
      lines.push(
        `  - [${t.status}] ${t.task_id.slice(0, 8)}... → ${t.to}: "${t.instruction.slice(0, 60)}"`,
      );
    }
    lines.push(``);
  }

  return lines.join("\n");
}

// ============================================================================
// Auto-dispatch: push messages through the LLM pipeline
// ============================================================================

async function autoDispatchMessage(
  chatroomCfg: ChatroomConfig,
  msg: InboxMessage,
  runtime: any,
  config: any,
  logger: Logger,
): Promise<void> {
  const channelId = msg.channel_id;
  const isDM = channelId.startsWith("dm_");

  const route = runtime.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: "chatroom",
    peer: { kind: isDM ? "direct" : "group", id: channelId },
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
        logger.info(`Auto-reply → #${channelId} (seq: ${result.seq})`);
      } catch (err) {
        logger.error(`Failed to send auto-reply to ${channelId}: ${err}`);
      }
    },
    onError: (err: any, info: any) => {
      logger.error(`Dispatch error (${info?.kind}): ${err}`);
    },
  };

  logger.info(`Dispatching chat from ${msg.from} in #${channelId} to LLM`);

  await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: config,
    dispatcherOptions,
    replyOptions: { onModelSelected: prefixContext.onModelSelected },
  });
}

/**
 * Dispatch a TASK to the LLM. The deliver callback writes a RESULT_REPORT
 * (not a plain CHAT) so the orchestrator's task tracker picks it up.
 */
async function autoDispatchForTask(
  chatroomCfg: ChatroomConfig,
  msg: InboxMessage,
  taskId: string,
  runtime: any,
  config: any,
  logger: Logger,
): Promise<void> {
  const channelId = msg.channel_id;
  const isDM = channelId.startsWith("dm_");

  const route = runtime.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: "chatroom",
    peer: { kind: isDM ? "direct" : "group", id: channelId },
  });

  const taskContext = [
    `[Task Assignment]`,
    `You have been assigned task ${taskId} by ${msg.from}.`,
    `Instruction: ${msg.content.text}`,
    ``,
    `Complete the task and provide your result. Your response will be sent back as the task result.`,
  ].join("\n");

  const ctxPayload = runtime.channel.reply.finalizeInboundContext({
    Body: taskContext,
    BodyForAgent: taskContext,
    RawBody: msg.content.text,
    CommandBody: msg.content.text,
    From: `chatroom:${msg.from}`,
    To: `chatroom:${chatroomCfg.agentId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isDM ? "direct" : "group",
    SenderName: msg.from,
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
        sendTaskResult(chatroomCfg, taskId, text, "DONE", logger);
      } catch (err) {
        logger.error(`Failed to send task result for ${taskId}: ${err}`);
      }
    },
    onError: (err: any, info: any) => {
      logger.error(`Task dispatch error for ${taskId} (${info?.kind}): ${err}`);
      try {
        sendTaskResult(chatroomCfg, taskId, `Task processing failed: ${err}`, "FAILED", logger);
      } catch {
        /* ignore */
      }
    },
  };

  logger.info(`Dispatching task ${taskId} to LLM`);

  await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: config,
    dispatcherOptions,
    replyOptions: { onModelSelected: prefixContext.onModelSelected },
  });
}

// ============================================================================
// Plugin definition
// ============================================================================

const agentChatroomPlugin = {
  id: "agent-chatroom",
  name: "Agent Chatroom",
  description: "Multi-agent collaboration chatroom over shared NAS with reliable task dispatch",

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
    ensureDir(tasksDir(cfg));

    const runtime = api.runtime;
    const config = api.config;
    const logger: Logger = {
      info: (...args: any[]) => api.logger.info(`[chatroom] ${args.join(" ")}`),
      warn: (...args: any[]) => api.logger.warn(`[chatroom] ${args.join(" ")}`),
      error: (...args: any[]) => api.logger.error(`[chatroom] ${args.join(" ")}`),
    };

    // ── Tool: dispatch task (handshake protocol) ────────────────────────────

    api.registerTool(
      {
        name: "chatroom_dispatch_task",
        label: "Chatroom: Dispatch Task",
        description:
          "Dispatch a task to another agent with guaranteed delivery via the handshake protocol.\n" +
          "The target agent will:\n" +
          "  1. Instantly ACK (system-level, no delay)\n" +
          "  2. Process the instruction via its LLM\n" +
          "  3. Return a RESULT_REPORT\n" +
          "If no ACK is received within timeout, the system retries automatically.\n\n" +
          "Use this instead of chatroom_send_message when you need an agent to do work.",
        parameters: Type.Object({
          target: Type.String({
            description: "Target agent ID (e.g. 'art', 'audio', 'gamedev', 'uiux')",
          }),
          instruction: Type.String({
            description: "What you want the agent to do — be specific and actionable",
          }),
        }),
        async execute(_toolCallId, params) {
          try {
            const p = params as { target: string; instruction: string };
            const task = dispatchTask(cfg, p.target, p.instruction, logger);
            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    `Task dispatched to ${p.target}.\n` +
                    `  task_id: ${task.task_id}\n` +
                    `  channel: #${task.channel_id}\n` +
                    `  status: DISPATCHED (awaiting ACK)\n` +
                    `The system will auto-retry if ${p.target} doesn't respond.`,
                },
              ],
              details: task,
            };
          } catch (err) {
            return {
              content: [{ type: "text" as const, text: `Error dispatching task: ${err}` }],
              details: undefined,
            };
          }
        },
      },
      { names: ["chatroom_dispatch_task"] },
    );

    // ── Tool: check task status ─────────────────────────────────────────────

    api.registerTool(
      {
        name: "chatroom_task_status",
        label: "Chatroom: Task Status",
        description:
          "Check the status of dispatched tasks. Shows active, completed, and failed tasks.",
        parameters: Type.Object({
          task_id: Type.Optional(
            Type.String({ description: "Specific task ID to check, or omit for all active tasks" }),
          ),
        }),
        async execute(_toolCallId, params) {
          try {
            const p = params as { task_id?: string };
            if (p.task_id) {
              const task = readTaskRecord(cfg, p.task_id);
              if (!task)
                return {
                  content: [{ type: "text" as const, text: `Task ${p.task_id} not found` }],
                  details: undefined,
                };
              return {
                content: [{ type: "text" as const, text: JSON.stringify(task, null, 2) }],
                details: task,
              };
            }
            const active = listTasksByStatus(cfg, "DISPATCHED", "ACKED", "PROCESSING", "TIMEOUT");
            if (active.length === 0)
              return {
                content: [{ type: "text" as const, text: "No active tasks." }],
                details: undefined,
              };
            const summary = active.map((t) => ({
              task_id: t.task_id,
              to: t.to,
              status: t.status,
              instruction: t.instruction.slice(0, 80),
              dispatched_at: t.dispatched_at,
              retries: t.retries,
            }));
            return {
              content: [
                {
                  type: "text" as const,
                  text: `${active.length} active task(s):\n${JSON.stringify(summary, null, 2)}`,
                },
              ],
              details: summary,
            };
          } catch (err) {
            return {
              content: [{ type: "text" as const, text: `Error: ${err}` }],
              details: undefined,
            };
          }
        },
      },
      { names: ["chatroom_task_status"] },
    );

    // ── Tool: send message (general chat, non-task) ─────────────────────────

    api.registerTool(
      {
        name: "chatroom_send_message",
        label: "Chatroom: Send Message",
        description:
          "Send a general chat message to a channel. For task assignments, use chatroom_dispatch_task instead.\n" +
          "Use this for: status updates, questions, broadcasting information, chatting.",
        parameters: Type.Object({
          channel_id: Type.String({
            description: "Target channel ID (e.g. 'general', 'pipeline', 'dm_art')",
          }),
          text: Type.String({ description: "Message content" }),
          mentions: Type.Optional(
            Type.Array(Type.String(), { description: "Agent IDs to @mention" }),
          ),
        }),
        async execute(_toolCallId, params) {
          try {
            const p = params as { channel_id: string; text: string; mentions?: string[] };
            const result = sendMessageToNAS(cfg, p.channel_id, p.text, "CHAT", p.mentions ?? []);
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Message sent to #${p.channel_id} (seq: ${result.seq})`,
                },
              ],
              details: result,
            };
          } catch (err) {
            return {
              content: [{ type: "text" as const, text: `Error: ${err}` }],
              details: undefined,
            };
          }
        },
      },
      { names: ["chatroom_send_message"] },
    );

    // ── Tool: list channels ─────────────────────────────────────────────────

    api.registerTool(
      {
        name: "chatroom_list_channels",
        label: "Chatroom: List Channels",
        description: "List all chatroom channels this agent belongs to.",
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
              content: [{ type: "text" as const, text: `Error: ${err}` }],
              details: undefined,
            };
          }
        },
      },
      { names: ["chatroom_list_channels"] },
    );

    // ── Tool: check inbox (manual, usually not needed) ──────────────────────

    api.registerTool(
      {
        name: "chatroom_check_inbox",
        label: "Chatroom: Check Inbox",
        description:
          "Manually check inbox. Usually not needed — the daemon auto-dispatches messages.",
        parameters: Type.Object({}),
        async execute(_toolCallId, _params) {
          try {
            const msgs = pollInbox(cfg);
            updateHeartbeat(cfg);
            if (msgs.length === 0)
              return {
                content: [{ type: "text" as const, text: "No new messages." }],
                details: undefined,
              };
            const all = msgs.map((m) => ({
              channel: m.channel_id,
              from: m.from,
              type: m.type,
              text: m.content?.text ?? "",
              message_id: m.message_id,
            }));
            return {
              content: [
                {
                  type: "text" as const,
                  text: `${all.length} message(s):\n${JSON.stringify(all, null, 2)}`,
                },
              ],
              details: all,
            };
          } catch (err) {
            return {
              content: [{ type: "text" as const, text: `Error: ${err}` }],
              details: undefined,
            };
          }
        },
      },
      { names: ["chatroom_check_inbox"] },
    );

    // ── Background service ──────────────────────────────────────────────────

    const pollIntervalMs = (pluginCfg.pollIntervalMs as number) ?? 3000;
    const taskMonitorIntervalMs = (pluginCfg.taskMonitorIntervalMs as number) ?? 10_000;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let taskMonitorTimer: ReturnType<typeof setInterval> | null = null;

    api.registerService({
      id: "chatroom-daemon",
      start: async () => {
        logger.info(`Chatroom daemon started for agent=${agentId} (task protocol enabled)`);
        updateHeartbeat(cfg);

        heartbeatTimer = setInterval(() => {
          try {
            updateHeartbeat(cfg);
          } catch {
            /* ignore */
          }
        }, 30_000);

        // Main inbox poll — routes messages by type
        pollTimer = setInterval(async () => {
          try {
            const messages = pollInbox(cfg);
            for (const msg of messages) {
              try {
                switch (msg.type) {
                  case "TASK_DISPATCH":
                    handleIncomingTask(cfg, msg, runtime, config, logger);
                    break;
                  case "TASK_ACK":
                    handleTaskAck(cfg, msg, logger);
                    break;
                  case "RESULT_REPORT":
                    handleTaskResult(cfg, msg, logger);
                    // Also dispatch to LLM so orchestrator can relay to human
                    await autoDispatchMessage(cfg, msg, runtime, config, logger);
                    break;
                  default:
                    await autoDispatchMessage(cfg, msg, runtime, config, logger);
                    break;
                }
              } catch (err) {
                logger.error(`Message handling failed for ${msg.message_id}: ${err}`);
              }
            }
          } catch {
            /* ignore */
          }
        }, pollIntervalMs);

        // Task timeout / retry monitor
        taskMonitorTimer = setInterval(() => {
          try {
            monitorPendingTasks(cfg, logger);
          } catch {
            /* ignore */
          }
        }, taskMonitorIntervalMs);
      },
      stop: async () => {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        if (pollTimer) clearInterval(pollTimer);
        if (taskMonitorTimer) clearInterval(taskMonitorTimer);
        logger.info("Chatroom daemon stopped");
      },
    });
  },
};

export default agentChatroomPlugin;
