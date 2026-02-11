import type { OutboundSendDeps } from "../infra/outbound/deliver.js";
import { logWebSelfId, sendMessageWhatsApp } from "../channels/web/index.js";
import { sendMessageIMessage } from "../imessage/send.js";

async function stubChannelRemoved(): Promise<never> {
  throw new Error("Channel removed");
}

export type CliDeps = {
  sendMessageWhatsApp: typeof sendMessageWhatsApp;
  sendMessageTelegram: typeof stubChannelRemoved;
  sendMessageDiscord: typeof stubChannelRemoved;
  sendMessageSlack: typeof stubChannelRemoved;
  sendMessageSignal: typeof stubChannelRemoved;
  sendMessageIMessage: typeof sendMessageIMessage;
};

export function createDefaultDeps(): CliDeps {
  return {
    sendMessageWhatsApp,
    sendMessageTelegram: stubChannelRemoved,
    sendMessageDiscord: stubChannelRemoved,
    sendMessageSlack: stubChannelRemoved,
    sendMessageSignal: stubChannelRemoved,
    sendMessageIMessage,
  };
}

// Provider docking: extend this mapping when adding new outbound send deps.
export function createOutboundSendDeps(deps: CliDeps): OutboundSendDeps {
  return {
    sendWhatsApp: deps.sendMessageWhatsApp,
    sendTelegram: deps.sendMessageTelegram,
    sendDiscord: deps.sendMessageDiscord,
    sendSlack: deps.sendMessageSlack,
    sendSignal: deps.sendMessageSignal,
    sendIMessage: deps.sendMessageIMessage,
  };
}

export { logWebSelfId };
