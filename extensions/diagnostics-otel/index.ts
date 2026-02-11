import type { FirstClawPluginApi } from "firstclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "firstclaw/plugin-sdk";
import { createDiagnosticsOtelService } from "./src/service.js";

const plugin = {
  id: "diagnostics-otel",
  name: "Diagnostics OpenTelemetry",
  description: "Export diagnostics events to OpenTelemetry",
  configSchema: emptyPluginConfigSchema(),
  register(api: FirstClawPluginApi) {
    api.registerService(createDiagnosticsOtelService());
  },
};

export default plugin;
