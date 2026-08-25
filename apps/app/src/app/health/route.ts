export function GET(): Response {
  return Response.json({
    integrations: {
      google: "unavailable",
      openai: "unavailable"
    },
    service: "app",
    status: "ok"
  });
}
