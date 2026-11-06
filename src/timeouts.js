export const DEFAULT_TOOL_TIMEOUT_SECONDS = 15 * 60;
export const MAX_TOOL_TIMEOUT_SECONDS = 2 * 60 * 60;

export function toolTimeoutSeconds(value = DEFAULT_TOOL_TIMEOUT_SECONDS) {
  return Math.max(1, Math.min(Number.parseInt(value, 10) || 1, MAX_TOOL_TIMEOUT_SECONDS));
}
