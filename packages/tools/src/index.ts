export * from "./adapters/browser.js";
export * from "./adapters/calendar.js";
export * from "./adapters/gmail.js";
export * from "./capabilities.js";
export * from "./contract.js";
export * from "./gateway.js";
export * from "./google-auth.js";
export * from "./persistence.js";
export * from "./registry.js";

import type { BrowserOperations } from "./adapters/browser.js";
import { createBrowserToolDefinitions } from "./adapters/browser.js";
import type { CalendarTransport } from "./adapters/calendar.js";
import { createCalendarToolDefinitions } from "./adapters/calendar.js";
import type { GmailTransport } from "./adapters/gmail.js";
import { createGmailToolDefinitions } from "./adapters/gmail.js";
import type { AnyToolDefinition } from "./contract.js";
import { ToolRegistry } from "./registry.js";

export function createProductionToolRegistry(adapters: {
  browser?: BrowserOperations;
  calendar?: CalendarTransport;
  gmail?: GmailTransport;
}): ToolRegistry {
  const definitions: AnyToolDefinition[] = [];
  if (adapters.browser) definitions.push(...createBrowserToolDefinitions(adapters.browser));
  if (adapters.gmail) definitions.push(...createGmailToolDefinitions(adapters.gmail));
  if (adapters.calendar) definitions.push(...createCalendarToolDefinitions(adapters.calendar));
  return new ToolRegistry(definitions);
}
