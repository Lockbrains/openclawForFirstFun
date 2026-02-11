import type { FirstClawConfig } from "../../config/types.js";

export type DirectoryConfigParams = {
  cfg: FirstClawConfig;
  accountId?: string | null;
  query?: string | null;
  limit?: number | null;
};
