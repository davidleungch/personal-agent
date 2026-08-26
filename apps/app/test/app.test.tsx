import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicationError } from "../src/server/product";

const mocks = vi.hoisted(() => {
  const response = () => Promise.resolve(Response.json({ ok: true }));
  return {
    api: {
      createAutomation: vi.fn(response), createCommand: vi.fn(response), getCommand: vi.fn(response),
      getRun: vi.fn(response), health: vi.fn(response), listAutomations: vi.fn(response),
      listRuns: vi.fn(response), resumeRun: vi.fn(response), status: vi.fn(response),
      updateAutomation: vi.fn(response)
    },
    redirect: vi.fn((destination: string): never => { throw new Error(`REDIRECT:${destination}`); }),
    revalidatePath: vi.fn(),
    service: {
      createAutomation: vi.fn(), createCommand: vi.fn(), getCommand: vi.fn(), getRun: vi.fn(),
      getStatus: vi.fn(), listAutomations: vi.fn(), listRuns: vi.fn(), resumeRun: vi.fn(),
      updateAutomation: vi.fn()
    }
  };
});

vi.mock("../src/server/runtime", () => ({
  getAppRuntime: () => ({ api: mocks.api, service: mocks.service })
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));

import { POST as createCommandRoute } from "../src/app/api/commands/route";
import { GET as getCommandRoute } from "../src/app/api/commands/[id]/route";
import { GET as listAutomationsRoute, POST as createAutomationRoute } from "../src/app/api/automations/route";
import { PATCH as updateAutomationRoute } from "../src/app/api/automations/[id]/route";
import { GET as listRunsRoute } from "../src/app/api/runs/route";
import { GET as getRunRoute } from "../src/app/api/runs/[id]/route";
import { POST as resumeRunRoute } from "../src/app/api/runs/[id]/resume/route";
import { GET as statusRoute } from "../src/app/api/status/route";
import { GET as healthRoute } from "../src/app/health/route";
import { createAutomationAction, createCommandAction, resumeRunAction, updateAutomationAction } from "../src/app/actions";
import { Dashboard, type DashboardProps } from "../src/app/dashboard";
import RootLayout from "../src/app/layout";
import Home from "../src/app/page";

const automation = {
  completionMode: "continue", createdAt: "2026-08-26T00:00:00.000Z", enabled: true,
  goal: "<script>window.evil=true</script>", id: "00000000-0000-4000-8000-000000000001",
  lastRunAt: null, modelProfile: "balanced", name: "Fixture automation",
  nextRunAt: "2026-08-27T00:00:00.000Z", schedule: "0 0 * * *", timezone: "UTC",
  toolPolicy: "browser-read", updatedAt: "2026-08-26T00:00:00.000Z", version: 2
};
const run = {
  attempt: 1, automation: { id: automation.id, name: automation.name }, completedAt: null,
  createdAt: "2026-08-26T00:00:00.000Z", errorSummary: null,
  id: "00000000-0000-4000-8000-000000000002", modelProfile: "balanced",
  resultSummary: "<img src=x onerror=window.evil=true>", scheduledFor: null, startedAt: null,
  status: "needs_human", trigger: "manual", updatedAt: "2026-08-26T00:00:00.000Z",
  workflowPhase: "needs_human"
};
const detail = {
  ...run,
  evidence: [
    { createdAt: run.createdAt, externalId: "external-1", id: "e1", tool: "browser.submit", type: "confirmation" },
    { createdAt: run.createdAt, externalId: null, id: "e2", tool: null, type: "run_metadata" }
  ],
  events: [
    { createdAt: run.createdAt, eventType: "status_changed", fromStatus: "running", id: "r1", toStatus: "needs_human" },
    { createdAt: run.createdAt, eventType: "checkpoint_saved", fromStatus: null, id: "r2", toStatus: null }
  ],
  modelInvocations: [{ completedAt: null, id: "m1", latencyMs: null, modelProfile: "balanced", role: "general", schemaOutcome: "valid", startedAt: run.createdAt, status: "succeeded", summary: "decision_needs_human", usage: {} }],
  toolCalls: [{ attempt: 1, completedAt: null, externalId: null, failureClass: null, id: "t1", requestedAt: run.createdAt, sideEffectClass: "consequential", status: "unknown", tool: "browser.submit" }]
};
const status = {
  database: "available", integrations: { browser: "available", google: "unavailable", openai: "unavailable" },
  service: "app", status: "ok", worker: "available"
} as const;
const dashboardProps: DashboardProps = {
  automations: {
    items: [automation, {
      ...automation,
      enabled: false,
      id: "00000000-0000-4000-8000-000000000004",
      lastRunAt: run.createdAt,
      name: "Disabled automation"
    }],
    page: { count: 2, limit: 20, offset: 0 }
  },
  command: {
    completedAt: null, content: "<svg onload=window.evil=true>", createdAt: run.createdAt,
    errorSummary: null, id: "00000000-0000-4000-8000-000000000003", intentType: null,
    status: "pending", updatedAt: run.updatedAt
  },
  error: "version_conflict", notice: "run_resumed", run: detail,
  runs: { items: [run], page: { count: 1, limit: 20, offset: 0 } }, status
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.service.getStatus.mockResolvedValue(status);
  mocks.service.listAutomations.mockResolvedValue(dashboardProps.automations);
  mocks.service.listRuns.mockResolvedValue(dashboardProps.runs);
  mocks.service.getCommand.mockResolvedValue(dashboardProps.command);
  mocks.service.getRun.mockResolvedValue(detail);
  mocks.service.createCommand.mockResolvedValue(dashboardProps.command);
  mocks.service.createAutomation.mockResolvedValue(automation);
  mocks.service.updateAutomation.mockResolvedValue(automation);
  mocks.service.resumeRun.mockResolvedValue({ id: run.id, resumed: true, status: "queued" });
});

describe("thin Next.js route wrappers", () => {
  it("delegates every approved route to the app-owned HTTP boundary", async () => {
    const request = new Request("http://localhost/api?limit=1", { body: "{}", method: "POST" });
    const context = { params: Promise.resolve({ id: run.id }) };
    await createCommandRoute(request.clone());
    await getCommandRoute(request.clone(), context);
    await listAutomationsRoute(request.clone());
    await createAutomationRoute(request.clone());
    await updateAutomationRoute(request.clone(), context);
    await listRunsRoute(request.clone());
    await getRunRoute(request.clone(), context);
    await resumeRunRoute(request.clone(), context);
    await statusRoute();
    await healthRoute();
    expect(mocks.api.createCommand).toHaveBeenCalledOnce();
    expect(mocks.api.getCommand).toHaveBeenCalledWith(expect.any(Request), run.id);
    expect(mocks.api.listAutomations).toHaveBeenCalledOnce();
    expect(mocks.api.createAutomation).toHaveBeenCalledOnce();
    expect(mocks.api.updateAutomation).toHaveBeenCalledWith(expect.any(Request), run.id);
    expect(mocks.api.listRuns).toHaveBeenCalledOnce();
    expect(mocks.api.getRun).toHaveBeenCalledWith(expect.any(Request), run.id);
    expect(mocks.api.resumeRun).toHaveBeenCalledWith(expect.any(Request), run.id);
    expect(mocks.api.status).toHaveBeenCalledOnce();
    expect(mocks.api.health).toHaveBeenCalledOnce();
  });
});

describe("server-rendered product UI", () => {
  it("renders operational surfaces and untrusted strings only as inert text", () => {
    const markup = renderToStaticMarkup(<Dashboard {...dashboardProps} />);
    expect(markup).toContain("Personal Agent");
    expect(markup).toContain("Queue command");
    expect(markup).toContain("Create automation");
    expect(markup).toContain("Run detail");
    expect(markup).toContain("Resume after completing");
    expect(markup).toContain("version conflict");
    expect(markup).toContain("run resumed");
    expect(markup).toContain("&lt;script&gt;window.evil=true&lt;/script&gt;");
    expect(markup).toContain("&lt;svg onload=window.evil=true&gt;");
    expect(markup).not.toContain("<script>window.evil=true</script>");
    expect(markup).not.toContain("dangerouslySetInnerHTML");
  });

  it("renders empty states and omits ineligible resume controls", () => {
    const markup = renderToStaticMarkup(<Dashboard
      automations={{ items: [], page: { count: 0, limit: 20, offset: 0 } }}
      runs={{ items: [], page: { count: 0, limit: 20, offset: 0 } }}
      status={{ ...status, worker: "unavailable" }}
    />);
    expect(markup).toContain("No automations yet");
    expect(markup).toContain("No runs yet");
    expect(markup).not.toContain("Resume after completing");
    const completed = renderToStaticMarkup(<Dashboard
      {...dashboardProps}
      error={undefined as never}
      notice={undefined as never}
      run={{
        ...detail,
        errorSummary: "fixture failure",
        resultSummary: null,
        scheduledFor: run.createdAt,
        status: "succeeded"
      }}
    />);
    expect(completed).not.toContain("Resume after completing");
  });

  it("loads bounded server data and renders a safe unavailable state", async () => {
    const loaded = await Home({ searchParams: Promise.resolve({
      command: dashboardProps.command!.id, error: "invalid_request", notice: "saved", run: run.id
    }) });
    expect(renderToStaticMarkup(loaded)).toContain("Fixture automation");
    expect(mocks.service.listAutomations).toHaveBeenCalledWith({});
    expect(mocks.service.getRun).toHaveBeenCalledWith(run.id, {});
    mocks.service.getCommand.mockRejectedValueOnce(new Error("missing"));
    mocks.service.getRun.mockRejectedValueOnce(new Error("missing"));
    const ignored = await Home({ searchParams: Promise.resolve({ command: "bad", run: "bad" }) });
    expect(renderToStaticMarkup(ignored)).not.toContain("Run detail");
    const arrayParams = await Home({ searchParams: Promise.resolve({ command: ["a"], run: ["b"] }) });
    expect(renderToStaticMarkup(arrayParams)).toContain("Personal Agent");
    mocks.service.getStatus.mockRejectedValueOnce(new Error("raw database stack"));
    const unavailable = await Home({});
    expect(renderToStaticMarkup(unavailable)).toContain("local control plane is unavailable");
  });

  it("renders the root document language and child content", () => {
    const markup = renderToStaticMarkup(<RootLayout><p>child</p></RootLayout>);
    expect(markup).toContain('<html lang="en">');
    expect(markup).toContain("<p>child</p>");
  });
});

function automationForm(enabled = true) {
  const form = new FormData();
  form.set("id", automation.id); form.set("version", String(automation.version));
  form.set("name", automation.name); form.set("goal", automation.goal);
  form.set("schedule", automation.schedule); form.set("timezone", automation.timezone);
  form.set("modelProfile", automation.modelProfile); form.set("toolPolicy", automation.toolPolicy);
  form.set("completionMode", automation.completionMode);
  if (enabled) form.set("enabled", "on");
  return form;
}

describe("server actions", () => {
  it("queues commands and creates, edits, and resumes through the product service", async () => {
    const commandForm = new FormData(); commandForm.set("content", "Safe command");
    await expect(createCommandAction(commandForm)).rejects.toThrow(`REDIRECT:/?command=${dashboardProps.command!.id}`);
    await expect(createAutomationAction(automationForm())).rejects.toThrow("REDIRECT:/?notice=automation_created");
    await expect(updateAutomationAction(automationForm(false))).rejects.toThrow("REDIRECT:/?notice=automation_updated");
    const resume = new FormData(); resume.set("id", run.id);
    await expect(resumeRunAction(resume)).rejects.toThrow(`REDIRECT:/?run=${run.id}&notice=run_resumed`);
    expect(mocks.service.createCommand).toHaveBeenCalledWith({ content: "Safe command" });
    expect(mocks.service.createAutomation).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
    expect(mocks.service.updateAutomation).toHaveBeenCalledWith(automation.id, expect.objectContaining({ enabled: false, version: automation.version }));
    expect(mocks.service.resumeRun).toHaveBeenCalledWith(run.id, {});
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/");
  });

  it("redirects stable errors and ignores non-text form values", async () => {
    mocks.service.createCommand.mockRejectedValueOnce(new ApplicationError("invalid_request", 400, "safe"));
    const form = new FormData(); form.set("content", new Blob(["unsafe"]));
    await expect(createCommandAction(form)).rejects.toThrow("REDIRECT:/?error=invalid_request");
    expect(mocks.service.createCommand).toHaveBeenCalledWith({ content: "" });
  });
});
