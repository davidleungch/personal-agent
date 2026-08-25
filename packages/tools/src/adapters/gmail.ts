import { google, type gmail_v1 } from "googleapis";
import { z } from "zod";
import { asUntrustedText, defineTool, ToolExecutionError, untrustedTextSchema, type AnyToolDefinition, type ToolExecutionContext } from "../contract.js";

export const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

export type GmailTransportMessage = {
  body: string;
  date: string;
  from: string;
  id: string;
  subject: string;
  threadId: string;
};

export interface GmailTransport {
  get(messageId: string, signal: AbortSignal): Promise<GmailTransportMessage | undefined>;
  search(query: string, maxResults: number, signal: AbortSignal): Promise<readonly { id: string; threadId: string }[]>;
}

function decode(data: string | null | undefined): string {
  if (!data) return "";
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function textBody(payload: gmail_v1.Schema$MessagePart | undefined): string {
  if (!payload) return "";
  if (payload.mimeType === "text/plain") return decode(payload.body?.data);
  return (payload.parts ?? []).map(textBody).filter(Boolean).join("\n");
}

function header(payload: gmail_v1.Schema$MessagePart | undefined, name: string): string {
  return payload?.headers?.find((item) => item.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function googleFailure(error: unknown): never {
  const status = typeof error === "object" && error !== null && "code" in error ? Number(error.code) : 0;
  throw new ToolExecutionError(status === 429 ? "rate_limited" : "transport_error", status === 429 || status >= 500 || status === 0);
}

export function createGoogleGmailTransport(auth: InstanceType<typeof google.auth.OAuth2>): GmailTransport {
  const client = google.gmail({ auth, version: "v1" });
  return {
    get: async (messageId, signal) => {
      if (signal.aborted) throw new ToolExecutionError("transport_error", true);
      try {
        const response = await client.users.messages.get({ format: "full", id: messageId, userId: "me" }, { signal });
        const message = response.data;
        if (!message.id) return undefined;
        return {
          body: textBody(message.payload),
          date: header(message.payload, "Date"),
          from: header(message.payload, "From"),
          id: message.id,
          subject: header(message.payload, "Subject"),
          threadId: message.threadId ?? ""
        };
      } catch (error) {
        return googleFailure(error);
      }
    },
    search: async (query, maxResults, signal) => {
      if (signal.aborted) throw new ToolExecutionError("transport_error", true);
      try {
        const response = await client.users.messages.list({ maxResults, q: query, userId: "me" }, { signal });
        return (response.data.messages ?? []).flatMap((message) => message.id ? [{ id: message.id, threadId: message.threadId ?? "" }] : []);
      } catch (error) {
        return googleFailure(error);
      }
    }
  };
}

const searchInput = z.object({ maxResults: z.number().int().min(1).max(50).default(10), query: z.string().min(1).max(500) });
const searchOutput = z.object({ messages: z.array(z.object({ id: z.string(), threadId: z.string() })).max(50) });
const readInput = z.object({ messageId: z.string().min(1).max(200) });
const readOutput = z.object({
  body: untrustedTextSchema,
  date: untrustedTextSchema,
  from: untrustedTextSchema,
  id: z.string(),
  subject: untrustedTextSchema,
  threadId: z.string()
});
const waitInput = searchInput.extend({ pollIntervalMs: z.number().int().min(100).max(10_000).default(1_000), timeoutMs: z.number().int().min(100).max(60_000) });
const retryPolicy = { maxAttempts: 2, retryableFailureClasses: ["rate_limited", "transport_error", "timeout"] } as const;

function messageOutput(message: GmailTransportMessage): z.infer<typeof readOutput> {
  return {
    body: asUntrustedText(message.body),
    date: asUntrustedText(message.date, 500),
    from: asUntrustedText(message.from, 500),
    id: message.id,
    subject: asUntrustedText(message.subject, 1_000),
    threadId: message.threadId
  };
}

export function createGmailToolDefinitions(
  transport: GmailTransport,
  options: { now?: () => number; sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void> } = {}
): readonly AnyToolDefinition[] {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((milliseconds: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => { clearTimeout(timer); reject(new ToolExecutionError("timeout", true)); }, { once: true });
  }));
  const search = defineTool({
    execute: async (input: z.infer<typeof searchInput>, context: ToolExecutionContext) => ({ data: { messages: [...await transport.search(input.query, input.maxResults, context.signal)] }, retryable: false, status: "success" as const }),
    inputSchema: searchInput, integration: "google" as const, name: "gmail.search", outputSchema: searchOutput, permission: "external_read" as const, retryPolicy,
    safeInputSummary: (input: z.infer<typeof searchInput>) => ({ maxResults: input.maxResults, queryLength: input.query.length }), safeOutputSummary: (output: z.infer<typeof searchOutput>) => ({ messageCount: output.messages.length }), sideEffect: "read_only" as const, timeoutMs: 15_000
  });
  const read = defineTool({
    execute: async (input: z.infer<typeof readInput>, context: ToolExecutionContext) => { const message = await transport.get(input.messageId, context.signal); if (!message) return { failureClass: "transport_error" as const, retryable: false, status: "failed" as const }; return { data: messageOutput(message), retryable: false, status: "success" as const }; },
    inputSchema: readInput, integration: "google" as const, name: "gmail.read", outputSchema: readOutput, permission: "external_read" as const, retryPolicy,
    safeInputSummary: (input: z.infer<typeof readInput>) => ({ messageId: input.messageId }), safeOutputSummary: (output: z.infer<typeof readOutput>) => ({ messageId: output.id, threadId: output.threadId }), sideEffect: "read_only" as const, timeoutMs: 15_000
  });
  const wait = defineTool({
    execute: async (input: z.infer<typeof waitInput>, context: ToolExecutionContext) => {
      const deadline = now() + input.timeoutMs;
      while (now() <= deadline) {
        const matches = await transport.search(input.query, input.maxResults, context.signal);
        const first = matches[0];
        if (first) { const message = await transport.get(first.id, context.signal); if (message) return { data: messageOutput(message), retryable: false, status: "success" as const }; }
        if (now() + input.pollIntervalMs > deadline) break;
        await sleep(input.pollIntervalMs, context.signal);
      }
      return { failureClass: "timeout" as const, retryable: true, status: "failed" as const };
    },
    inputSchema: waitInput, integration: "google" as const, name: "gmail.wait_for_message", outputSchema: readOutput, permission: "external_read" as const, retryPolicy,
    safeInputSummary: (input: z.infer<typeof waitInput>) => ({ maxResults: input.maxResults, timeoutMs: input.timeoutMs }), safeOutputSummary: (output: z.infer<typeof readOutput>) => ({ messageId: output.id }), sideEffect: "read_only" as const, timeoutMs: 65_000
  });
  return [search, read, wait] as unknown as readonly AnyToolDefinition[];
}
