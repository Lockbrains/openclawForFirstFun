/* istanbul ignore file - LINE channel removed; stubs for compatibility */

import type { ReplyPayload } from "../types.js";

/** @deprecated LINE channel removed - always returns false */
export function hasLineDirectives(_text: string): boolean {
  return false;
}

/** @deprecated LINE channel removed - returns payload unchanged */
export function parseLineDirectives(payload: ReplyPayload): ReplyPayload {
  return payload;
}
