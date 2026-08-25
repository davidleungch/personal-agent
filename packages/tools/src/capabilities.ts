import type { PermissionClass } from "./contract.js";

export type ToolPolicy =
  | "none"
  | "browser-read"
  | "browser-interact"
  | "gmail-read"
  | "calendar-read"
  | "calendar-write"
  | "course-registration";

const policyTools: Readonly<Record<ToolPolicy, readonly string[]>> = Object.freeze({
  "browser-interact": [
    "browser.open",
    "browser.read",
    "browser.click",
    "browser.type",
    "browser.select",
    "browser.upload"
  ],
  "browser-read": ["browser.open", "browser.read"],
  "calendar-read": ["calendar.list_events"],
  "calendar-write": [
    "calendar.list_events",
    "calendar.create_event",
    "calendar.update_event"
  ],
  "course-registration": [
    "browser.open",
    "browser.read",
    "browser.click",
    "browser.type",
    "browser.select",
    "browser.upload",
    "browser.submit",
    "gmail.search",
    "gmail.read",
    "gmail.wait_for_message",
    "calendar.list_events",
    "calendar.create_event",
    "calendar.update_event"
  ],
  "gmail-read": ["gmail.search", "gmail.read", "gmail.wait_for_message"],
  none: []
});

const policyPermissions: Readonly<Record<ToolPolicy, readonly PermissionClass[]>> = Object.freeze({
  "browser-interact": ["external_read", "browser_interact"],
  "browser-read": ["external_read"],
  "calendar-read": ["external_read"],
  "calendar-write": ["external_read", "external_write"],
  "course-registration": ["external_read", "browser_interact", "external_write"],
  "gmail-read": ["external_read"],
  none: []
});

export type IntegrationAvailability = Readonly<{
  browser: "available" | "unavailable";
  google: "available" | "unavailable";
}>;

export type ResolvedCapabilities = Readonly<{
  permissions: ReadonlySet<PermissionClass>;
  policyConfigured: boolean;
  tools: ReadonlySet<string>;
  unavailable: ReadonlySet<"browser" | "google">;
}>;

export function resolveCapabilities(
  toolPolicy: string,
  integrations: IntegrationAvailability
): ResolvedCapabilities {
  const configured = Object.hasOwn(policyTools, toolPolicy);
  const policy = configured ? (toolPolicy as ToolPolicy) : "none";
  const unavailable = new Set<"browser" | "google">();
  if (integrations.browser === "unavailable") unavailable.add("browser");
  if (integrations.google === "unavailable") unavailable.add("google");

  const tools = policyTools[policy].filter((name) =>
    name.startsWith("browser.")
      ? integrations.browser === "available"
      : integrations.google === "available"
  );

  return Object.freeze({
    permissions: new Set(policyPermissions[policy]),
    policyConfigured: configured,
    tools: new Set(tools),
    unavailable
  });
}
