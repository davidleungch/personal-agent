import { createServer, type Server } from "node:http";

const healthPayload = JSON.stringify({
  integrations: {
    google: "unavailable",
    openai: "unavailable"
  },
  service: "worker",
  status: "ok"
});

export function createHealthServer(): Server {
  return createServer((request, response) => {
    response.setHeader("content-type", "application/json");

    if (request.url !== "/health") {
      response.writeHead(404);
      response.end(JSON.stringify({ status: "not_found" }));
      return;
    }

    response.writeHead(200);
    response.end(healthPayload);
  });
}

export function startWorker(port: number): Server {
  const server = createHealthServer();
  server.listen(port, "0.0.0.0");
  return server;
}
