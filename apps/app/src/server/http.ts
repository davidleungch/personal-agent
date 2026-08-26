import { ZodError } from "zod";
import { ApplicationError, type ApplicationErrorCode, type ProductService } from "./product";

type ErrorPayload = {
  error: { code: ApplicationErrorCode; message: string };
};

function errorResponse(code: ApplicationErrorCode, message: string, status: number): Response {
  return Response.json({ error: { code, message } } satisfies ErrorPayload, { status });
}

export function publicError(error: unknown): {
  code: ApplicationErrorCode;
  message: string;
  status: number;
} {
  if (error instanceof ApplicationError) {
    return { code: error.code, message: error.message, status: error.status };
  }
  if (error instanceof ZodError) {
    const policyDenied = error.issues.some((issue) => issue.path[0] === "toolPolicy");
    return policyDenied
      ? { code: "policy_denied", message: "Tool policy is not approved", status: 403 }
      : { code: "invalid_request", message: "Request validation failed", status: 400 };
  }
  return {
    code: "configuration_error",
    message: "The application could not complete the request",
    status: 500
  };
}

export async function respond(
  operation: () => Promise<unknown>,
  successStatus = 200,
  failureStatus?: number
): Promise<Response> {
  try {
    return Response.json(await operation(), { status: successStatus });
  } catch (error) {
    const normalized = publicError(error);
    return errorResponse(
      normalized.code,
      normalized.message,
      failureStatus ?? normalized.status
    );
  }
}

async function readJson(request: Request, allowEmpty = false): Promise<unknown> {
  const text = await request.text();
  if (!text.trim()) {
    if (allowEmpty) return {};
    throw new ApplicationError("invalid_request", 400, "A JSON request body is required");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApplicationError("invalid_request", 400, "Request body must be valid JSON");
  }
}

function query(request: Request): Record<string, string> {
  return Object.fromEntries(new URL(request.url).searchParams.entries());
}

export function createHttpApi(service: ProductService) {
  return {
    createAutomation: (request: Request) =>
      respond(async () => service.createAutomation(await readJson(request)), 201),
    createCommand: (request: Request) =>
      respond(async () => service.createCommand(await readJson(request)), 201),
    getCommand: (_request: Request, id: string) =>
      respond(() => service.getCommand(id)),
    getRun: (request: Request, id: string) =>
      respond(() => service.getRun(id, query(request))),
    health: () => respond(() => service.getStatus(), 200, 503),
    listAutomations: (request: Request) =>
      respond(() => service.listAutomations(query(request))),
    listRuns: (request: Request) => respond(() => service.listRuns(query(request))),
    resumeRun: (request: Request, id: string) =>
      respond(async () => service.resumeRun(id, await readJson(request, true))),
    status: () => respond(() => service.getStatus()),
    updateAutomation: (request: Request, id: string) =>
      respond(async () => service.updateAutomation(id, await readJson(request)))
  };
}

export type HttpApi = ReturnType<typeof createHttpApi>;
