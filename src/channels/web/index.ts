/* istanbul ignore file - WhatsApp/Web channel removed; stubs for compatibility */

const REMOVED = "WhatsApp/Web channel removed" as const;

/** @deprecated Channel removed */
export async function createWaSocket(): Promise<never> {
  throw new Error(REMOVED);
}

/** @deprecated Channel removed */
export async function loginWeb(): Promise<never> {
  throw new Error(REMOVED);
}

/** @deprecated Channel removed */
export function logWebSelfId(): void {
  // no-op
}

/** @deprecated Channel removed */
export async function monitorWebChannel(): Promise<never> {
  throw new Error(REMOVED);
}

/** @deprecated Channel removed */
export async function monitorWebInbox(): Promise<never> {
  throw new Error(REMOVED);
}

/** @deprecated Channel removed */
export async function pickWebChannel(): Promise<never> {
  throw new Error(REMOVED);
}

/** @deprecated Channel removed */
export async function sendMessageWhatsApp(): Promise<never> {
  throw new Error(REMOVED);
}

/** @deprecated Channel removed */
export const WA_WEB_AUTH_DIR = "";

/** @deprecated Channel removed */
export async function waitForWaConnection(): Promise<never> {
  throw new Error(REMOVED);
}

/** @deprecated Channel removed */
export function webAuthExists(): boolean {
  return false;
}
