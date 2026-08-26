import { createHash } from "node:crypto";
import { google, type calendar_v3 } from "googleapis";
import { z } from "zod";
import { asUntrustedText, defineTool, ToolExecutionError, untrustedTextSchema, type AnyToolDefinition, type ToolExecutionContext } from "../contract.js";

export const CALENDAR_EVENTS_SCOPE = "https://www.googleapis.com/auth/calendar.events";
export const CALENDAR_IDEMPOTENCY_PROPERTY = "personalAgentIdempotencyKey";

export type CalendarEvent = {
  description?: string;
  end: string;
  id: string;
  location?: string;
  privateProperties?: Readonly<Record<string, string>>;
  start: string;
  summary: string;
  timezone?: string;
};

export interface CalendarTransport {
  get(calendarId: string, eventId: string, signal: AbortSignal): Promise<CalendarEvent | undefined>;
  insert(calendarId: string, event: Omit<CalendarEvent, "id">, signal: AbortSignal): Promise<CalendarEvent>;
  list(input: { calendarId: string; idempotencyKey?: string; maxResults: number; timeMax?: string; timeMin?: string }, signal: AbortSignal): Promise<readonly CalendarEvent[]>;
  update(calendarId: string, eventId: string, event: Omit<CalendarEvent, "id">, signal: AbortSignal): Promise<CalendarEvent>;
}

function googleFailure(error: unknown): never {
  const status = typeof error === "object" && error !== null && "code" in error ? Number(error.code) : 0;
  throw new ToolExecutionError(status === 429 ? "rate_limited" : "transport_error", status === 429 || status >= 500 || status === 0);
}

function fromGoogle(event: calendar_v3.Schema$Event): CalendarEvent | undefined {
  const start = event.start?.dateTime ?? event.start?.date;
  const end = event.end?.dateTime ?? event.end?.date;
  if (!event.id || !start || !end) return undefined;
  return {
    ...(event.description ? { description: event.description } : {}),
    end,
    id: event.id,
    ...(event.location ? { location: event.location } : {}),
    ...(event.extendedProperties?.private ? { privateProperties: event.extendedProperties.private } : {}),
    start,
    summary: event.summary ?? "",
    ...(event.start?.timeZone ? { timezone: event.start.timeZone } : {})
  };
}

function toGoogle(event: Omit<CalendarEvent, "id">): calendar_v3.Schema$Event {
  return {
    ...(event.description ? { description: event.description } : {}),
    end: { dateTime: event.end, ...(event.timezone ? { timeZone: event.timezone } : {}) },
    ...(event.privateProperties ? { extendedProperties: { private: { ...event.privateProperties } } } : {}),
    ...(event.location ? { location: event.location } : {}),
    start: { dateTime: event.start, ...(event.timezone ? { timeZone: event.timezone } : {}) },
    summary: event.summary
  };
}

export function createGoogleCalendarTransport(auth: InstanceType<typeof google.auth.OAuth2>): CalendarTransport {
  const client = google.calendar({ auth, version: "v3" });
  return {
    get: async (calendarId, eventId, signal) => {
      try { const response = await client.events.get({ calendarId, eventId }, { signal }); return fromGoogle(response.data); } catch (error) { return googleFailure(error); }
    },
    insert: async (calendarId, event, signal) => {
      try { const response = await client.events.insert({ calendarId, requestBody: toGoogle(event) }, { signal }); const parsed = fromGoogle(response.data); if (!parsed) throw new ToolExecutionError("transport_error", false); return parsed; } catch (error) { return googleFailure(error); }
    },
    list: async (input, signal) => {
      try {
        const params: calendar_v3.Params$Resource$Events$List = { calendarId: input.calendarId, maxResults: input.maxResults, singleEvents: true };
        if (input.idempotencyKey) params.privateExtendedProperty = [`${CALENDAR_IDEMPOTENCY_PROPERTY}=${input.idempotencyKey}`];
        if (input.timeMax) params.timeMax = input.timeMax;
        if (input.timeMin) params.timeMin = input.timeMin;
        const response = await client.events.list(params, { signal });
        return (response.data.items ?? []).flatMap((event) => { const parsed = fromGoogle(event); return parsed ? [parsed] : []; });
      } catch (error) { return googleFailure(error); }
    },
    update: async (calendarId, eventId, event, signal) => {
      try { const response = await client.events.update({ calendarId, eventId, requestBody: toGoogle(event) }, { signal }); const parsed = fromGoogle(response.data); if (!parsed) throw new ToolExecutionError("transport_error", false); return parsed; } catch (error) { return googleFailure(error); }
    }
  };
}

const calendarId = z.string().min(1).max(500);
const isoDate = z.iso.datetime({ offset: true });
const eventFields = z.object({
  calendarId,
  description: z.string().max(5_000).optional(),
  end: isoDate,
  location: z.string().max(1_000).optional(),
  start: isoDate,
  summary: z.string().min(1).max(1_000),
  timezone: z.string().min(1).max(100).optional()
}).refine((value) => new Date(value.end) > new Date(value.start), "Event end must be after start");
const listInput = z.object({ calendarId, maxResults: z.number().int().min(1).max(50).default(20), timeMax: isoDate.optional(), timeMin: isoDate.optional() });
const eventOutput = z.object({ end: z.string(), id: z.string(), start: z.string(), summary: untrustedTextSchema });
const listOutput = z.object({ events: z.array(eventOutput).max(50) });
const createInput = eventFields.safeExtend({ operationKey: z.string().min(1).max(500) });
const updateInput = eventFields.safeExtend({ eventId: z.string().min(1).max(500) });
const retryPolicy = { maxAttempts: 2, retryableFailureClasses: ["rate_limited", "transport_error", "timeout"] } as const;

function stableKey(scope: string, values: readonly string[]): string {
  return `${scope}:${createHash("sha256").update(values.join("\u0000")).digest("hex")}`;
}

function output(event: CalendarEvent): z.infer<typeof eventOutput> {
  return { end: event.end, id: event.id, start: event.start, summary: asUntrustedText(event.summary, 1_000) };
}

function desired(input: z.infer<typeof eventFields>, privateProperties?: Readonly<Record<string, string>>): Omit<CalendarEvent, "id"> {
  return {
    ...(input.description ? { description: input.description } : {}),
    end: input.end,
    ...(input.location ? { location: input.location } : {}),
    ...(privateProperties ? { privateProperties } : {}),
    start: input.start,
    summary: input.summary,
    ...(input.timezone ? { timezone: input.timezone } : {})
  };
}

function sameEvent(event: CalendarEvent, expected: Omit<CalendarEvent, "id">): boolean {
  return event.summary === expected.summary && event.start === expected.start && event.end === expected.end && event.description === expected.description && event.location === expected.location && event.timezone === expected.timezone;
}

export function createCalendarToolDefinitions(transport: CalendarTransport): readonly AnyToolDefinition[] {
  const list = defineTool({
    execute: async (input: z.infer<typeof listInput>, context: ToolExecutionContext) => ({ data: { events: (await transport.list({ calendarId: input.calendarId, maxResults: input.maxResults, ...(input.timeMax ? { timeMax: input.timeMax } : {}), ...(input.timeMin ? { timeMin: input.timeMin } : {}) }, context.signal)).map(output) }, retryable: false, status: "success" as const }),
    inputSchema: listInput, integration: "google" as const, name: "calendar.list_events", outputSchema: listOutput, permission: "external_read" as const, retryPolicy,
    safeInputSummary: (input: z.infer<typeof listInput>) => ({ calendarId: input.calendarId, maxResults: input.maxResults }), safeOutputSummary: (value: z.infer<typeof listOutput>) => ({ eventCount: value.events.length }), sideEffect: "read_only" as const, timeoutMs: 15_000
  });
  const create = defineTool({
    execute: async (input: z.infer<typeof createInput>, context: ToolExecutionContext) => {
      const key = stableKey("calendar.create", [input.calendarId, input.operationKey]);
      const existing = (await transport.list({ calendarId: input.calendarId, idempotencyKey: key, maxResults: 2 }, context.signal))[0];
      if (existing) return { data: output(existing), evidence: [{ payload: { externalId: existing.id, method: "lookup_before_create" }, type: "calendar_event" }], externalId: existing.id, retryable: false, status: "success" as const };
      context.reportSideEffectStarted();
      const inserted = await transport.insert(input.calendarId, desired(input, { [CALENDAR_IDEMPOTENCY_PROPERTY]: key }), context.signal);
      const verified = await transport.get(input.calendarId, inserted.id, context.signal);
      if (!verified) return { externalId: inserted.id, failureClass: "verification_failed" as const, retryable: false, status: "unknown" as const };
      return { data: output(verified), evidence: [{ payload: { externalId: verified.id, method: "read_back" }, type: "calendar_event" }], externalId: verified.id, retryable: false, status: "success" as const };
    },
    idempotencyKey: (input: z.infer<typeof createInput>) => stableKey("calendar.create", [input.calendarId, input.operationKey]), inputSchema: createInput, integration: "google" as const, name: "calendar.create_event", outputSchema: eventOutput, permission: "external_write" as const, retryPolicy,
    safeInputSummary: (input: z.infer<typeof createInput>) => ({ calendarId: input.calendarId, operationKey: input.operationKey }), safeOutputSummary: (value: z.infer<typeof eventOutput>) => ({ eventId: value.id }), sideEffect: "consequential" as const, timeoutMs: 20_000,
    verify: async (input: z.infer<typeof createInput>, context: ToolExecutionContext) => { const key = stableKey("calendar.create", [input.calendarId, input.operationKey]); const existing = (await transport.list({ calendarId: input.calendarId, idempotencyKey: key, maxResults: 2 }, context.signal))[0]; return existing ? { data: output(existing), evidence: [{ payload: { externalId: existing.id, method: "private_property_lookup" }, type: "calendar_event" }], externalId: existing.id, status: "exists" as const } : { status: "absent" as const }; }
  });
  const update = defineTool({
    execute: async (input: z.infer<typeof updateInput>, context: ToolExecutionContext) => { const expected = desired(input); const current = await transport.get(input.calendarId, input.eventId, context.signal); if (current && sameEvent(current, expected)) return { data: output(current), evidence: [{ payload: { externalId: current.id, method: "already_current" }, type: "calendar_event" }], externalId: current.id, retryable: false, status: "success" as const }; context.reportSideEffectStarted(); await transport.update(input.calendarId, input.eventId, expected, context.signal); const verified = await transport.get(input.calendarId, input.eventId, context.signal); if (!verified || !sameEvent(verified, expected)) return { externalId: input.eventId, failureClass: "verification_failed" as const, retryable: false, status: "unknown" as const }; return { data: output(verified), evidence: [{ payload: { externalId: verified.id, method: "read_back" }, type: "calendar_event" }], externalId: verified.id, retryable: false, status: "success" as const }; },
    idempotencyKey: (input: z.infer<typeof updateInput>) => stableKey("calendar.update", [input.calendarId, input.eventId, input.summary, input.start, input.end, input.description ?? "", input.location ?? "", input.timezone ?? ""]), inputSchema: updateInput, integration: "google" as const, name: "calendar.update_event", outputSchema: eventOutput, permission: "external_write" as const, retryPolicy,
    safeInputSummary: (input: z.infer<typeof updateInput>) => ({ calendarId: input.calendarId, eventId: input.eventId }), safeOutputSummary: (value: z.infer<typeof eventOutput>) => ({ eventId: value.id }), sideEffect: "consequential" as const, timeoutMs: 20_000,
    verify: async (input: z.infer<typeof updateInput>, context: ToolExecutionContext) => { const event = await transport.get(input.calendarId, input.eventId, context.signal); if (!event) return { status: "absent" as const }; return sameEvent(event, desired(input)) ? { data: output(event), evidence: [{ payload: { externalId: event.id, method: "read_back" }, type: "calendar_event" }], externalId: event.id, status: "exists" as const } : { status: "absent" as const }; }
  });
  return [list, create, update] as unknown as readonly AnyToolDefinition[];
}
