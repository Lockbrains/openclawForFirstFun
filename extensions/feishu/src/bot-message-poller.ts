/**
 * Bot message poller for Feishu multi-bot group collaboration.
 *
 * Feishu's event subscription (`im.message.receive_v1`) only delivers messages
 * from human users — bot-sent messages are invisible to other bots.
 *
 * This module periodically polls `im/v1/messages` for configured group chats,
 * finds messages sent by OTHER bots that mention THIS agent by name, and feeds
 * them into the standard `handleFeishuMessage` pipeline.
 */
import type { ClawdbotConfig, RuntimeEnv, HistoryEntry } from "firstclaw/plugin-sdk";
import type { ResolvedFeishuAccount, FeishuConfig } from "./types.js";
import { createFeishuClient } from "./client.js";
import { handleFeishuMessage, type FeishuMessageEvent } from "./bot.js";

const DEFAULT_POLL_INTERVAL_MS = 5_000;

/** Per-chat high-water mark: only process messages newer than this. */
const lastSeenTimestamps = new Map<string, string>();

/** Dedup set to avoid processing the same message twice across polls. */
const processedPolledIds = new Set<string>();
const POLLED_DEDUP_MAX = 2_000;

function prunePolledDedup() {
  if (processedPolledIds.size > POLLED_DEDUP_MAX) {
    // Remove oldest half (Set preserves insertion order)
    const iter = processedPolledIds.values();
    const toRemove = Math.floor(processedPolledIds.size / 2);
    for (let i = 0; i < toRemove; i++) {
      const val = iter.next().value;
      if (val !== undefined) processedPolledIds.delete(val);
    }
  }
}

type ListMessagesResponse = {
  code?: number;
  msg?: string;
  data?: {
    items?: Array<{
      message_id?: string;
      root_id?: string;
      parent_id?: string;
      chat_id?: string;
      msg_type?: string;
      body?: { content?: string };
      sender?: {
        id?: string;
        id_type?: string;
        sender_type?: string;
        tenant_key?: string;
      };
      mentions?: Array<{
        key?: string;
        id?: string;
        id_type?: string;
        name?: string;
        tenant_key?: string;
      }>;
      create_time?: string;
    }>;
    has_more?: boolean;
    page_token?: string;
  };
};

/**
 * Poll one group chat for recent bot messages.
 */
async function pollGroupChat(params: {
  cfg: ClawdbotConfig;
  account: ResolvedFeishuAccount;
  chatId: string;
  botOpenId: string;
  runtime?: RuntimeEnv;
  chatHistories: Map<string, HistoryEntry[]>;
}): Promise<void> {
  const { cfg, account, chatId, botOpenId, runtime, chatHistories } = params;
  const log = runtime?.log ?? console.log;
  const client = createFeishuClient(account);

  // Use high-water mark to only fetch new messages
  const startTime = lastSeenTimestamps.get(chatId);

  try {
    const response = (await client.im.message.list({
      params: {
        container_id_type: "chat",
        container_id: chatId,
        page_size: 20,
        sort_type: "ByCreateTimeDesc",
        ...(startTime ? { start_time: startTime } : {}),
      },
    })) as ListMessagesResponse;

    if (response.code !== 0) {
      log(
        `feishu-poller[${account.accountId}]: list messages failed for ${chatId}: ${response.msg ?? `code ${response.code}`}`,
      );
      return;
    }

    const items = response.data?.items ?? [];
    if (items.length === 0) return;

    // Update high-water mark to newest message's create_time
    const newestTime = items[0]?.create_time;
    if (newestTime) {
      lastSeenTimestamps.set(chatId, newestTime);
    }

    // Process items in chronological order (API returns newest first)
    for (const item of [...items].reverse()) {
      const msgId = item.message_id;
      if (!msgId) continue;

      // Skip already-processed messages
      if (processedPolledIds.has(msgId)) continue;

      // Only process messages from OTHER bots (sender_type === "app")
      if (item.sender?.sender_type !== "app") continue;

      // Skip messages from THIS bot
      const senderOpenId = item.sender?.id_type === "open_id" ? item.sender?.id : undefined;
      if (senderOpenId === botOpenId) continue;

      // Mark as processed
      processedPolledIds.add(msgId);
      prunePolledDedup();

      // Construct a synthetic FeishuMessageEvent
      const syntheticEvent: FeishuMessageEvent = {
        sender: {
          sender_id: {
            open_id: senderOpenId ?? item.sender?.id ?? "",
          },
          sender_type: "app",
          tenant_key: item.sender?.tenant_key,
        },
        message: {
          message_id: msgId,
          root_id: item.root_id,
          parent_id: item.parent_id,
          chat_id: item.chat_id ?? chatId,
          chat_type: "group",
          message_type: item.msg_type ?? "text",
          content: item.body?.content ?? "",
          mentions: item.mentions?.map((m) => ({
            key: m.key ?? "",
            id: {
              open_id: m.id_type === "open_id" ? m.id : undefined,
              user_id: m.id_type === "user_id" ? m.id : undefined,
            },
            name: m.name ?? "",
            tenant_key: m.tenant_key,
          })),
        },
      };

      log(
        `feishu-poller[${account.accountId}]: found bot message ${msgId} in ${chatId} from ${senderOpenId ?? "unknown"}`,
      );

      // Feed into the standard message handler.
      // The handler's own mention gating (native @mention + text-based @Name)
      // will decide whether this agent should respond.
      try {
        await handleFeishuMessage({
          cfg,
          event: syntheticEvent,
          botOpenId,
          runtime,
          chatHistories,
          accountId: account.accountId,
        });
      } catch (err) {
        log(
          `feishu-poller[${account.accountId}]: error handling polled message ${msgId}: ${String(err)}`,
        );
      }
    }
  } catch (err) {
    log(
      `feishu-poller[${account.accountId}]: poll error for ${chatId}: ${String(err)}`,
    );
  }
}

export type BotMessagePollerParams = {
  cfg: ClawdbotConfig;
  account: ResolvedFeishuAccount;
  botOpenId: string;
  runtime?: RuntimeEnv;
  chatHistories: Map<string, HistoryEntry[]>;
  abortSignal?: AbortSignal;
};

/**
 * Start the bot message poller for an account.
 * Runs in the background until the abort signal fires.
 */
export function startBotMessagePoller(params: BotMessagePollerParams): void {
  const { cfg, account, botOpenId, runtime, chatHistories, abortSignal } = params;
  const log = runtime?.log ?? console.log;
  const feishuCfg = account.config as FeishuConfig;
  const pollingCfg = feishuCfg.botMessagePolling;

  if (!pollingCfg?.enabled) return;

  const intervalMs = pollingCfg.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const groups = pollingCfg.groups ?? [];

  if (groups.length === 0) {
    // If no explicit groups, use groupAllowFrom as the polling targets
    const groupAllowFrom = feishuCfg.groupAllowFrom ?? [];
    for (const g of groupAllowFrom) {
      const id = String(g).trim();
      if (id && id !== "*") groups.push(id);
    }
  }

  if (groups.length === 0) {
    log(
      `feishu-poller[${account.accountId}]: botMessagePolling enabled but no groups to poll (set groups or groupAllowFrom)`,
    );
    return;
  }

  log(
    `feishu-poller[${account.accountId}]: starting bot message poller (interval=${intervalMs}ms, groups=${groups.join(", ")})`,
  );

  // Initialize high-water marks to "now" so we only look at future messages
  const nowMs = String(Math.floor(Date.now() / 1000));
  for (const chatId of groups) {
    if (!lastSeenTimestamps.has(chatId)) {
      lastSeenTimestamps.set(chatId, nowMs);
    }
  }

  const timer = setInterval(async () => {
    if (abortSignal?.aborted) {
      clearInterval(timer);
      return;
    }
    for (const chatId of groups) {
      if (abortSignal?.aborted) break;
      await pollGroupChat({
        cfg,
        account,
        chatId,
        botOpenId,
        runtime,
        chatHistories,
      });
    }
  }, intervalMs);

  // Clean up on abort
  if (abortSignal) {
    const handleAbort = () => {
      clearInterval(timer);
      log(`feishu-poller[${account.accountId}]: stopped`);
    };
    if (abortSignal.aborted) {
      clearInterval(timer);
    } else {
      abortSignal.addEventListener("abort", handleAbort, { once: true });
    }
  }
}
