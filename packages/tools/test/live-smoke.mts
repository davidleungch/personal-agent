import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { google } from "googleapis";
import { chromium } from "playwright";
import {
  createCalendarToolDefinitions,
  createGoogleCalendarTransport,
  createGoogleGmailTransport,
  createGoogleOAuthClient
} from "../src/index.ts";
import { deleteMarkedSmokeEvent, SMOKE_TEST_MARKER } from "./support/calendar-cleanup.ts";

const environment = process.env;

if (environment.PHASE1_LIVE_SMOKE !== "1") {
  console.log("SKIP live smoke: set PHASE1_LIVE_SMOKE=1 to opt in");
  process.exit(0);
}

const required = [
  "GOOGLE_CLIENT_ID_FILE",
  "GOOGLE_CLIENT_SECRET_FILE",
  "GOOGLE_REFRESH_TOKEN_FILE",
  "PHASE1_LIVE_CALENDAR_ID"
] as const;
const missing = required.filter((name) => !environment[name]);
if (missing.length > 0) {
  console.log(`SKIP live smoke: missing required configuration (${missing.join(", ")})`);
  process.exit(0);
}

async function credential(path: string): Promise<string> {
  const value = (await readFile(path, "utf8")).trim();
  if (!value) throw new Error("credential_file_empty");
  return value;
}

const calendarId = environment.PHASE1_LIVE_CALENDAR_ID!;
const marker = `${SMOKE_TEST_MARKER}:${randomUUID()}`;
let createdEventId: string | undefined;
let cleanup: (() => Promise<void>) | undefined;
let cleanupUnknown = false;

try {
  const auth = createGoogleOAuthClient({
    clientId: await credential(environment.GOOGLE_CLIENT_ID_FILE!),
    clientSecret: await credential(environment.GOOGLE_CLIENT_SECRET_FILE!),
    refreshToken: await credential(environment.GOOGLE_REFRESH_TOKEN_FILE!)
  });
  const signal = new AbortController().signal;
  const gmail = createGoogleGmailTransport(auth);
  const calendar = createGoogleCalendarTransport(auth);
  const client = google.calendar({ auth, version: "v3" });
  cleanup = async () => {
    if (!createdEventId) return;
    await deleteMarkedSmokeEvent({
      calendarId,
      configuredTestCalendarId: calendarId,
      eventId: createdEventId,
      marker,
      transport: {
        delete: async (targetCalendarId, eventId) => {
          await client.events.delete({ calendarId: targetCalendarId, eventId });
        },
        get: async (targetCalendarId, eventId) => {
          const response = await client.events.get({ calendarId: targetCalendarId, eventId });
          return response.data.summary ? { summary: response.data.summary } : undefined;
        }
      }
    });
    createdEventId = undefined;
  };

  await gmail.search(environment.PHASE1_LIVE_GMAIL_QUERY ?? "newer_than:1d", 1, signal);
  console.log("PASS live Gmail read-only search");
  await calendar.list({ calendarId, maxResults: 1 }, signal);
  console.log("PASS live Calendar read-only list");

  if (environment.PHASE1_LIVE_BROWSER_URL) {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(environment.PHASE1_LIVE_BROWSER_URL, { waitUntil: "domcontentloaded" });
      await page.title();
      console.log("PASS live browser non-consequential open");
    } finally {
      await browser.close();
    }
  } else {
    console.log("SKIP live browser: PHASE1_LIVE_BROWSER_URL is unset");
  }

  if (environment.PHASE1_LIVE_CALENDAR_WRITE === "1") {
    const create = createCalendarToolDefinitions(calendar).find(
      (definition) => definition.name === "calendar.create_event"
    );
    if (!create) throw new Error("calendar_create_tool_missing");
    const start = new Date(Date.now() + 60 * 60 * 1_000);
    const result = await create.execute({
      calendarId,
      end: new Date(start.getTime() + 15 * 60 * 1_000).toISOString(),
      operationKey: marker,
      start: start.toISOString(),
      summary: marker,
      timezone: "UTC"
    }, {
      operationKey: marker,
      reportSideEffectStarted: () => undefined,
      runId: randomUUID(),
      signal
    });
    createdEventId = result.externalId;
    if (result.status !== "success" || !createdEventId) {
      cleanupUnknown = true;
      console.log(`UNKNOWN live Calendar write; inspect calendar ${calendarId} for marker ${marker}`);
    } else {
      console.log("PASS live Calendar uniquely marked create and read-back");
    }
  } else {
    console.log("SKIP live Calendar write: PHASE1_LIVE_CALENDAR_WRITE=1 is not set");
  }

} catch {
  cleanupUnknown = true;
} finally {
  if (createdEventId && cleanup) {
    try {
      await cleanup();
      console.log("PASS live Calendar cleanup");
    } catch {
      cleanupUnknown = true;
    }
  }
}

if (cleanupUnknown) {
  console.log(`UNKNOWN live smoke; manually inspect calendar ${calendarId} for marker ${marker}`);
  process.exitCode = 1;
} else {
  console.log("PASS live smoke boundaries");
}
