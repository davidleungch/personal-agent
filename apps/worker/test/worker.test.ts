import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createHealthServer } from "../src/index";

const servers: ReturnType<typeof createHealthServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }

            resolve();
          });
        })
    )
  );
});

async function startTestWorker(): Promise<string> {
  const server = createHealthServer();
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

describe("worker scaffold", () => {
  it("reports healthy with optional integrations unavailable", async () => {
    const baseUrl = await startTestWorker();
    const response = await fetch(`${baseUrl}/health`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      integrations: {
        browser: "available",
        google: "unavailable",
        openai: "unavailable"
      },
      service: "worker",
      status: "ok"
    });
  });

  it("returns a structured not-found response", async () => {
    const baseUrl = await startTestWorker();
    const response = await fetch(`${baseUrl}/missing`);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ status: "not_found" });
  });
});
