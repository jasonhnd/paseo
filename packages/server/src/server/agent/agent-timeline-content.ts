import { StringDecoder } from "node:string_decoder";
import type { AgentTimelineItem } from "./agent-sdk-types.js";

const TOOL_CALL_CONTENT_MAX_BYTES = 64 * 1024;

function limitTextContent(value: string): string {
  if (Buffer.byteLength(value, "utf8") <= TOOL_CALL_CONTENT_MAX_BYTES) {
    return value;
  }
  const bytes = Buffer.from(value, "utf8").subarray(0, TOOL_CALL_CONTENT_MAX_BYTES);
  return new StringDecoder("utf8").write(bytes);
}

function limitFailedShellError(item: AgentTimelineItem): AgentTimelineItem {
  if (
    item.type !== "tool_call" ||
    item.detail.type !== "shell" ||
    item.status !== "failed" ||
    typeof item.error !== "object" ||
    item.error === null
  ) {
    return item;
  }

  const error: Record<string, unknown> = { ...item.error };
  let changed = false;
  for (const key of ["content", "message"] as const) {
    const value = error[key];
    if (typeof value !== "string") {
      continue;
    }
    const limitedValue = limitTextContent(value);
    if (limitedValue !== value) {
      error[key] = limitedValue;
      changed = true;
    }
  }
  if (!changed) {
    return item;
  }
  return {
    ...item,
    error,
  };
}

export function limitAgentTimelineItemContent(item: AgentTimelineItem): AgentTimelineItem {
  item = limitFailedShellError(item);
  if (
    item.type !== "tool_call" ||
    item.detail.type !== "shell" ||
    typeof item.detail.output !== "string"
  ) {
    return item;
  }
  const output = limitTextContent(item.detail.output);
  if (output === item.detail.output) {
    return item;
  }
  return {
    ...item,
    detail: {
      ...item.detail,
      output,
    },
  };
}
