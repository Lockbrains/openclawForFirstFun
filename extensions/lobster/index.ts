import type {
  AnyAgentTool,
  FirstClawPluginApi,
  FirstClawPluginToolFactory,
} from "../../src/plugins/types.js";
import { createLobsterTool } from "./src/lobster-tool.js";

export default function register(api: FirstClawPluginApi) {
  api.registerTool(
    ((ctx) => {
      if (ctx.sandboxed) {
        return null;
      }
      return createLobsterTool(api) as AnyAgentTool;
    }) as FirstClawPluginToolFactory,
    { optional: true },
  );
}
