import { describe, expect, it, vi } from "vitest";

const sdkState = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
  loaders: [] as Array<{ options: Record<string, unknown>; reload: ReturnType<typeof vi.fn> }>,
  model: { id: "configured-model" },
  modelAvailable: true,
  runtimeOptions: [] as unknown[],
  settings: [] as unknown[]
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  createAgentSession: sdkState.createAgentSession,
  defineTool: (tool: unknown) => tool,
  DefaultResourceLoader: class {
    reload = vi.fn(async () => undefined);
    constructor(readonly options: Record<string, unknown>) {
      sdkState.loaders.push(this);
    }
  },
  ModelRuntime: class {
    static async create(options: unknown) {
      sdkState.runtimeOptions.push(options);
      return new this();
    }
    getModel() {
      return sdkState.modelAvailable ? sdkState.model : undefined;
    }
  },
  SessionManager: { inMemory: () => ({ kind: "memory" }) },
  SettingsManager: {
    inMemory: (settings: unknown) => {
      sdkState.settings.push(settings);
      return { settings };
    }
  }
}));

import type { DevelopmentContext, DevelopmentEvent, DevelopmentToolSet } from "../src/contract";
import {
  OfficialPiTransport,
  PiDevelopmentHarness,
  piResourcePolicy,
  type PiTransport
} from "../src/pi-adapter";

const budget = {
  maxCommandMs: 1_000,
  maxCommandOutputBytes: 10_000,
  maxContextBytes: 100_000,
  maxCostUsdMicros: 1_000_000,
  maxDiffBytes: 10_000,
  maxModelInvocations: 3,
  maxTokens: 1_000,
  maxToolCalls: 20,
  maxWallClockMs: 1_000,
  maxWorkspaceBytes: 100_000
};
const context: DevelopmentContext = {
  acceptanceCriteria: "[]",
  allowedPaths: ["src"],
  baseCommit: "a".repeat(40),
  budget,
  digest: "b".repeat(64),
  forbiddenPaths: [".pi"],
  manifest: { entries: [], totalBytes: 0 },
  remainingBudget: budget,
  role: "implementer",
  sections: [{ content: "trusted constraints", path: "AGENTS.md", source: "authority" }],
  specification: "Change the fixture",
  taskTitle: "Fixture"
};

const toolInputs: Record<string, unknown> = {
  "git.diff": {},
  "git.status": {},
  "sandbox.edit": { newText: "b", oldText: "a", path: "src/a.ts" },
  "sandbox.exec": { arguments: ["test"], executable: "pnpm" },
  "sandbox.list": {},
  "sandbox.read": { path: "src/a.ts" },
  "sandbox.search": { query: "a" },
  "sandbox.write": { content: "a", path: "src/a.ts" }
};

type FakeToolDefinition = {
  execute: (id: string, input: unknown, signal?: AbortSignal) => Promise<unknown>;
  name: string;
};

type FakeSessionOptions = {
  customTools: FakeToolDefinition[];
  excludeTools: string[];
  sessionManager: unknown;
  thinkingLevel: string;
};

function tools(): DevelopmentToolSet & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    names: [
      "sandbox.read",
      "sandbox.list",
      "sandbox.search",
      "sandbox.write",
      "sandbox.edit",
      "sandbox.exec",
      "git.status",
      "git.diff"
    ],
    invoke: async (name) => {
      calls.push(name);
      return { content: `result ${name}`, safeMetadata: { tool: name } };
    }
  };
}

function assistant(stopReason: "stop" | "error" = "stop") {
  return {
    content: [],
    role: "assistant" as const,
    stopReason,
    usage: { cost: { total: 0.25 }, input: 10, output: 5 }
  };
}

describe("official Pi SDK adapter", () => {
  it("uses an in-memory session, runner-owned resources, custom tools, and normalized safe events", async () => {
    sdkState.modelAvailable = true;
    sdkState.createAgentSession.mockImplementationOnce(async (options: Record<string, unknown>) => {
      let listener: (event: unknown) => void = () => undefined;
      const session = {
        abort: vi.fn(async () => undefined),
        dispose: vi.fn(),
        messages: [assistant()],
        prompt: vi.fn(async (prompt: string) => {
          expect(prompt).toContain("Change the fixture");
          expect(prompt).toContain("trusted constraints");
          for (const definition of options.customTools as FakeToolDefinition[]) {
            await definition.execute("call-id", toolInputs[definition.name], undefined);
          }
          listener({ type: "agent_start" });
          listener({ toolCallId: "tool-1", toolName: "sandbox.read", type: "tool_execution_start" });
          listener({
            isError: false,
            toolCallId: "tool-1",
            toolName: "sandbox.read",
            type: "tool_execution_end"
          });
          listener({ message: assistant(), type: "message_end" });
        }),
        subscribe: vi.fn((value: (event: unknown) => void) => {
          listener = value;
          return vi.fn();
        })
      };
      return { session };
    });
    const emitted: DevelopmentEvent[] = [];
    const toolSet = tools();
    const transport = new OfficialPiTransport({
      agentDirectory: "/tmp/personal-agent-runner-owned-pi",
      models: {
        balanced: { modelId: "balanced-id", providerId: "provider" },
        fast: { modelId: "fast-id", providerId: "provider" },
        reasoning: { modelId: "reasoning-id", providerId: "provider" }
      }
    });
    const result = await transport.run({
      context,
      emit: (event) => emitted.push(event),
      modelProfile: "reasoning",
      signal: new AbortController().signal,
      tools: toolSet
    });
    expect(result).toEqual({
      outcome: "completion_proposed",
      usage: {
        commandMs: 0,
        commandOutputBytes: 0,
        costUsdMicros: 250_000,
        inputTokens: 10,
        modelInvocations: 1,
        outputTokens: 5,
        toolCalls: 0
      }
    });
    expect(toolSet.calls).toHaveLength(8);
    expect(emitted).toEqual([
      {
        kind: "tool",
        safeMetadata: { tool_call_id: "tool-1" },
        status: "started",
        tool: "sandbox.read"
      },
      {
        kind: "tool",
        safeMetadata: { tool_call_id: "tool-1" },
        status: "success",
        tool: "sandbox.read"
      }
    ]);
    const options = sdkState.createAgentSession.mock.calls.at(-1)?.[0] as FakeSessionOptions;
    expect(options.excludeTools).toContain("bash");
    expect(options.sessionManager).toEqual({ kind: "memory" });
    expect(options.thinkingLevel).toBe("high");
    expect(sdkState.loaders.at(-1)?.options).toMatchObject({
      cwd: "/tmp/personal-agent-runner-owned-pi",
      noContextFiles: true,
      noExtensions: true,
      noPromptTemplates: true,
      noSkills: true,
      noThemes: true
    });
    expect((sdkState.loaders.at(-1)?.options.appendSystemPromptOverride as () => unknown)()).toEqual([]);
    expect((sdkState.loaders.at(-1)?.options.systemPromptOverride as () => string)()).toContain(
      "bounded Phase 2A"
    );
    expect(piResourcePolicy).toEqual({
      contextFiles: false,
      extensions: false,
      persistence: "memory",
      projectTrust: "never",
      prompts: false,
      skills: false,
      themes: false
    });
  });

  it("normalizes model errors and cancellation without persisting Pi session identity", async () => {
    sdkState.createAgentSession.mockImplementationOnce(async () => {
      const controller = new AbortController();
      return {
        session: {
          abort: vi.fn(async () => controller.abort()),
          dispose: vi.fn(),
          messages: [assistant("error")],
          prompt: vi.fn(async () => undefined),
          subscribe: vi.fn(() => vi.fn())
        }
      };
    });
    const transport = new OfficialPiTransport({
      agentDirectory: "/tmp/pi-owned",
      models: {
        balanced: { modelId: "id", providerId: "provider" },
        fast: { modelId: "id", providerId: "provider" },
        reasoning: { modelId: "id", providerId: "provider" }
      }
    });
    await expect(
      transport.run({ context: { ...context, forbiddenPaths: [] }, emit: () => undefined, modelProfile: "fast", signal: new AbortController().signal, tools: tools() })
    ).resolves.toMatchObject({ outcome: "failed" });
    const options = sdkState.createAgentSession.mock.calls.at(-1)?.[0] as FakeSessionOptions;
    expect(options.thinkingLevel).toBe("medium");

    sdkState.createAgentSession.mockImplementationOnce(async () => {
      let listener: (event: unknown) => void = () => undefined;
      const session = {
        abort: vi.fn(async () => undefined),
        dispose: vi.fn(),
        messages: [assistant()],
        prompt: vi.fn(async () => {
          listener({ isError: true, toolCallId: "x", toolName: "sandbox.exec", type: "tool_execution_end" });
        }),
        subscribe: vi.fn((value: (event: unknown) => void) => {
          listener = value;
          return vi.fn();
        })
      };
      return { session };
    });
    const controller = new AbortController();
    controller.abort();
    const emitted: DevelopmentEvent[] = [];
    await expect(
      transport.run({ context, emit: (event) => emitted.push(event), modelProfile: "balanced", signal: controller.signal, tools: tools() })
    ).resolves.toMatchObject({ outcome: "aborted" });
    expect(emitted[0]).toMatchObject({ status: "failed" });

    let releasePrompt!: () => void;
    let promptStarted!: () => void;
    const promptWait = new Promise<void>((resolve) => {
      releasePrompt = resolve;
    });
    const started = new Promise<void>((resolve) => {
      promptStarted = resolve;
    });
    const abortSpy = vi.fn(async () => releasePrompt());
    sdkState.createAgentSession.mockImplementationOnce(async () => ({
      session: {
        abort: abortSpy,
        dispose: vi.fn(),
        messages: [assistant()],
        prompt: vi.fn(async () => {
          promptStarted();
          return promptWait;
        }),
        subscribe: vi.fn(() => vi.fn())
      }
    }));
    const activeController = new AbortController();
    const activeRun = transport.run({
      context,
      emit: () => undefined,
      modelProfile: "balanced",
      signal: activeController.signal,
      tools: tools()
    });
    await started;
    activeController.abort();
    await expect(activeRun).resolves.toMatchObject({ outcome: "aborted" });
    expect(abortSpy).toHaveBeenCalled();

    sdkState.modelAvailable = false;
    await expect(
      transport.run({ context, emit: () => undefined, modelProfile: "fast", signal: new AbortController().signal, tools: tools() })
    ).rejects.toThrow("unavailable");
    sdkState.modelAvailable = true;
  });
});

async function events(execution: Awaited<ReturnType<PiDevelopmentHarness["execute"]>>) {
  const result: DevelopmentEvent[] = [];
  for await (const event of execution.events) result.push(event);
  return result;
}

describe("project-owned Pi DevelopmentHarness", () => {
  it("normalizes completion and explicit abort", async () => {
    let transportSignal: AbortSignal | undefined;
    const transport: PiTransport = {
      run: async (input) => {
        transportSignal = input.signal;
        input.emit({ kind: "tool", safeMetadata: {}, status: "success", tool: "git.status" });
        return {
          outcome: "completion_proposed",
          usage: {
            commandMs: 0,
            commandOutputBytes: 0,
            costUsdMicros: 0,
            inputTokens: 1,
            modelInvocations: 1,
            outputTokens: 1,
            toolCalls: 0
          }
        };
      }
    };
    const harness = new PiDevelopmentHarness(transport);
    const execution = await harness.execute({
      attemptId: "00000000-0000-4000-8000-000000000001",
      budget,
      context,
      modelProfile: "fast",
      role: "implementer",
      tools: tools()
    });
    const output = await events(execution);
    expect(output.map((event) => event.kind)).toEqual([
      "execution_started",
      "tool",
      "usage",
      "completed"
    ]);
    await harness.abort(execution.executionId);
    expect(transportSignal?.aborted).toBe(false);

    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocking = new PiDevelopmentHarness({
      run: async ({ signal }) => {
        await waiting;
        return { outcome: signal.aborted ? "aborted" : "completion_proposed", usage: zeroUsageFixture() };
      }
    });
    const active = await blocking.execute({
      attemptId: "00000000-0000-4000-8000-000000000002",
      budget,
      context,
      modelProfile: "fast",
      role: "implementer",
      tools: tools()
    });
    const collecting = events(active);
    await Promise.resolve();
    await blocking.abort(active.executionId);
    release();
    expect((await collecting).at(-1)).toMatchObject({ failureClass: "aborted", kind: "failed" });
  });

  it("normalizes provider failure, thrown transport errors, caller cancellation, timeout, and role rejection", async () => {
    const failed = new PiDevelopmentHarness({
      run: async () => ({ outcome: "failed", usage: zeroUsageFixture() })
    });
    expect(
      (await events(await failed.execute({
        attemptId: "00000000-0000-4000-8000-000000000003",
        budget,
        context,
        modelProfile: "balanced",
        role: "implementer",
        tools: tools()
      }))).at(-1)
    ).toMatchObject({ failureClass: "provider" });

    const throwing = new PiDevelopmentHarness({
      run: async () => {
        throw new TypeError("transport failed");
      }
    });
    expect(
      (await events(await throwing.execute({
        attemptId: "00000000-0000-4000-8000-000000000004",
        budget,
        context,
        modelProfile: "balanced",
        role: "implementer",
        tools: tools()
      }))).at(-1)
    ).toMatchObject({ failureClass: "provider", safeMetadata: { error_class: "TypeError" } });

    const controller = new AbortController();
    const cancelled = new PiDevelopmentHarness({
      run: async ({ signal }) => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return { outcome: signal.aborted ? "aborted" : "failed", usage: zeroUsageFixture() };
      }
    });
    const cancelledExecution = await cancelled.execute({
        attemptId: "00000000-0000-4000-8000-000000000005",
        budget,
        context,
        modelProfile: "fast",
        role: "implementer",
        signal: controller.signal,
        tools: tools()
      });
    const cancelledEvents = events(cancelledExecution);
    controller.abort();
    expect((await cancelledEvents).at(-1)).toMatchObject({ failureClass: "aborted" });

    const preAbortedController = new AbortController();
    preAbortedController.abort();
    const preAborted = new PiDevelopmentHarness({
      run: async ({ signal }) => ({
        outcome: signal.aborted ? "aborted" : "failed",
        usage: zeroUsageFixture()
      })
    });
    expect(
      (await events(await preAborted.execute({
        attemptId: "00000000-0000-4000-8000-000000000009",
        budget,
        context,
        modelProfile: "fast",
        role: "implementer",
        signal: preAbortedController.signal,
        tools: tools()
      }))).at(-1)
    ).toMatchObject({ failureClass: "aborted" });

    const timeoutHarness = new PiDevelopmentHarness({
      run: async ({ signal }) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (signal.aborted) throw new Error("timed out");
        return { outcome: "failed", usage: zeroUsageFixture() };
      }
    });
    expect(
      (await events(await timeoutHarness.execute({
        attemptId: "00000000-0000-4000-8000-000000000006",
        budget: { ...budget, maxWallClockMs: 1 },
        context,
        modelProfile: "fast",
        role: "implementer",
        tools: tools()
      }))).at(-1)
    ).toMatchObject({ failureClass: "timeout" });

    await expect(
      failed.execute({
        attemptId: "00000000-0000-4000-8000-000000000007",
        budget,
        context,
        modelProfile: "fast",
        role: "reviewer" as never,
        tools: tools()
      })
    ).rejects.toThrow("Implementer");

    const nonError = new PiDevelopmentHarness({
      run: async () => Promise.reject("non-error")
    });
    expect(
      (await events(await nonError.execute({
        attemptId: "00000000-0000-4000-8000-000000000008",
        budget,
        context,
        modelProfile: "fast",
        role: "implementer",
        tools: tools()
      }))).at(-1)
    ).toMatchObject({ safeMetadata: { error_class: "unknown" } });
  });
});

function zeroUsageFixture() {
  return {
    commandMs: 0,
    commandOutputBytes: 0,
    costUsdMicros: 0,
    inputTokens: 0,
    modelInvocations: 0,
    outputTokens: 0,
    toolCalls: 0
  };
}
