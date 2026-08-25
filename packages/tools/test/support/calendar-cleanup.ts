export const SMOKE_TEST_MARKER = "PERSONAL_AGENT_CALENDAR_SMOKE";

export interface CalendarCleanupTransport {
  delete(calendarId: string, eventId: string): Promise<void>;
  get(calendarId: string, eventId: string): Promise<{ description?: string; summary?: string } | undefined>;
}

export async function deleteMarkedSmokeEvent(input: {
  calendarId: string;
  configuredTestCalendarId: string;
  eventId: string;
  marker: string;
  transport: CalendarCleanupTransport;
}): Promise<void> {
  if (input.calendarId !== input.configuredTestCalendarId) throw new Error("Cleanup calendar is not the configured test calendar");
  if (!input.marker.startsWith(`${SMOKE_TEST_MARKER}:`) || input.marker.length <= SMOKE_TEST_MARKER.length + 1) throw new Error("Cleanup marker is not uniquely scoped");
  const event = await input.transport.get(input.calendarId, input.eventId);
  if (!event || !`${event.summary ?? ""}\n${event.description ?? ""}`.includes(input.marker)) throw new Error("Refusing to delete an unmarked event");
  await input.transport.delete(input.calendarId, input.eventId);
}
