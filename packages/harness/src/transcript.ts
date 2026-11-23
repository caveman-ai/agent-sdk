/**
 * Transcript (`--transcript <path>`): every message the model saw or sent, one
 * JSON line each, for trace mining. It only observes (Pi's agent events and the
 * compiled system prompt), so it never changes a request or a result:
 * - `system`: the system prompt as sent, its section ids, the tool declarations;
 * - `user`: the task and every policy follow-up, as sent;
 * - `assistant`: text, thinking text (signatures dropped), tool calls with their
 *   full input, stop reason and usage including reasoning tokens;
 * - `tool_result`: the result content exactly as the model received it (after
 *   policy reminders), images as their type and size.
 */
import { closeSync, openSync, writeSync } from "node:fs";
import type { AgentEvent } from "@earendil-works/pi-agent-core";

type Part = { type: string; text?: string; thinking?: string; data?: string; mimeType?: string; id?: string; name?: string; arguments?: unknown };

const content = (parts: unknown): unknown[] => (Array.isArray(parts) ? parts as Part[] : typeof parts === "string" ? [{ type: "text", text: parts }] : [])
  .map((part) => (typeof part === "string" ? { type: "text", text: part } : part))
  .map((part: Part) => (part.type === "image" ? { type: "image", mime_type: part.mimeType, base64_chars: part.data?.length ?? 0 } : part.type === "text" ? { type: "text", text: part.text } : part));

export class Transcript {
  private fd: number | undefined;
  private readonly startedAt = performance.now();
  private n = 0;

  constructor(path: string) {
    this.fd = openSync(path, "w");
  }

  private write(type: string, fields: Record<string, unknown>): void {
    if (this.fd === undefined) return;
    writeSync(this.fd, `${JSON.stringify({ n: ++this.n, t: Math.round(performance.now() - this.startedAt), type, ...fields })}\n`);
  }

  system(prompt: string, sections: string[], tools: { name: string; description?: string; parameters?: unknown }[]): void {
    this.write("system", { sections, text: prompt, tools: tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })) });
  }

  onEvent(event: AgentEvent): void {
    if (event.type !== "message_end") return;
    const message = event.message as unknown as Record<string, any>;
    if (message.role === "user") {
      this.write("user", { content: content(message.content) });
    } else if (message.role === "assistant") {
      const parts = (Array.isArray(message.content) ? message.content : []) as Part[];
      const usage = message.usage ?? {};
      this.write("assistant", {
        text: parts.filter((part) => part.type === "text").map((part) => part.text ?? "").join(""),
        ...(parts.some((part) => part.type === "thinking" && part.thinking) ? { thinking: parts.filter((part) => part.type === "thinking").map((part) => part.thinking ?? "").join("\n") } : {}),
        tool_calls: parts.filter((part) => part.type === "toolCall").map((part) => ({ id: part.id, name: part.name, input: part.arguments })),
        stop_reason: message.stopReason,
        usage: { input: usage.input ?? 0, cache_read: usage.cacheRead ?? 0, cache_write: usage.cacheWrite ?? 0, output: usage.output ?? 0, reasoning: usage.reasoning ?? 0 },
        ...(message.errorMessage === undefined ? {} : { error: message.errorMessage }),
      });
    } else if (message.role === "toolResult") {
      this.write("tool_result", { id: message.toolCallId, name: message.toolName, is_error: message.isError === true, content: content(message.content) });
    }
  }

  close(): void {
    if (this.fd !== undefined) closeSync(this.fd);
    this.fd = undefined;
  }
}
