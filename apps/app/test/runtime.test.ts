import type { Database } from "@personal-agent/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAppRuntime, getAppRuntime } from "../src/server/runtime";

afterEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.WORKER_HEALTH_URL;
});

describe("app runtime wiring", () => {
  it("wires database, worker health, product service, HTTP API, and close ownership", async () => {
    const close = vi.fn(async () => undefined);
    const database = { execute: vi.fn(async () => undefined) } as unknown as Database;
    const createConnection = vi.fn(() => ({ close, database, pool: {} as never }));
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({
      integrations: { browser: "available", google: "unavailable", openai: "unavailable" },
      service: "worker",
      status: "ok"
    }));
    const runtime = createAppRuntime({
      DATABASE_URL: "postgresql://user:password@localhost/test",
      WORKER_HEALTH_URL: "http://worker:3001/health"
    }, { createConnection: createConnection as never, fetcher });

    await expect(runtime.service.getStatus()).resolves.toMatchObject({
      integrations: { browser: "available" },
      worker: "available"
    });
    expect(runtime.api).toBeDefined();
    expect(createConnection).toHaveBeenCalledWith("postgresql://user:password@localhost/test");
    await runtime.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it("creates one lazy production runtime", async () => {
    process.env.DATABASE_URL = "postgresql://user:password@127.0.0.1:1/test";
    const first = getAppRuntime();
    const second = getAppRuntime();
    expect(second).toBe(first);
    await first.close();
  });
});
