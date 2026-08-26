import { chromium } from "@playwright/test";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Dashboard } from "../src/app/dashboard";

const browserFixture = process.env.PLAYWRIGHT_FIXTURES === "1" ? it : it.skip;

describe("product UI browser boundary", () => {
  browserFixture("renders untrusted user text inertly in a real browser", async () => {
    const markup = renderToStaticMarkup(<Dashboard
      automations={{
        items: [{
          completionMode: "continue",
          createdAt: "2026-08-26T00:00:00.000Z",
          enabled: true,
          goal: "<script>window.evil=true</script>",
          id: "00000000-0000-4000-8000-000000000001",
          lastRunAt: null,
          modelProfile: "balanced",
          name: "Browser fixture",
          nextRunAt: "2026-08-27T00:00:00.000Z",
          schedule: "0 0 * * *",
          timezone: "UTC",
          toolPolicy: "browser-read",
          updatedAt: "2026-08-26T00:00:00.000Z",
          version: 1
        }],
        page: { count: 1, limit: 20, offset: 0 }
      }}
      runs={{ items: [], page: { count: 0, limit: 20, offset: 0 } }}
      status={{
        database: "available",
        integrations: { browser: "available", google: "unavailable", openai: "unavailable" },
        service: "app",
        status: "ok",
        worker: "available"
      }}
    />);
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(`<!doctype html><html><body>${markup}</body></html>`);
      expect(await page.getByRole("heading", { name: "Personal Agent" }).isVisible()).toBe(true);
      await page.getByText("Browser fixture", { exact: true }).click();
      expect(await page.getByText("<script>window.evil=true</script>").first().isVisible()).toBe(true);
      expect(await page.evaluate(() => (window as typeof window & { evil?: boolean }).evil)).toBeUndefined();
      expect(await page.locator("script").count()).toBe(1);
    } finally {
      await browser.close();
    }
  });
});
