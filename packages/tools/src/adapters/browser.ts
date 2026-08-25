import { chmod, mkdir } from "node:fs/promises";
import { chromium, type BrowserContext, type Locator, type Page } from "playwright";
import { z } from "zod";
import {
  asUntrustedText,
  defineTool,
  ToolExecutionError,
  untrustedTextSchema,
  type AnyToolDefinition,
  type ToolExecutionContext
} from "../contract.js";

const roleSchema = z.enum(["button", "checkbox", "combobox", "heading", "link", "listitem", "option", "radio", "textbox"]);
const targetSchema = z.object({
  label: z.string().min(1).max(200).optional(),
  name: z.string().min(1).max(200).optional(),
  role: roleSchema.optional(),
  testId: z.string().min(1).max(200).optional()
}).refine((value) => Number(Boolean(value.label)) + Number(Boolean(value.testId)) + Number(Boolean(value.role)) === 1 && (value.role ? Boolean(value.name) : !value.name), "Target requires exactly one label, testId, or role/name locator");
type Target = z.infer<typeof targetSchema>;

const browserLocationSchema = z.object({ title: untrustedTextSchema, url: z.string().url() });
const readOutputSchema = z.object({ fields: z.array(z.object({ key: z.string(), value: untrustedTextSchema })).max(20), url: z.string().url() });
const actionOutputSchema = z.object({ acted: z.literal(true), url: z.string().url() });

export interface BrowserOperations {
  click(target: Target, signal: AbortSignal): Promise<void>;
  currentUrl(): string;
  navigationClick(target: Target, signal: AbortSignal): Promise<void>;
  open(url: string, signal: AbortSignal): Promise<{ title: string; url: string }>;
  read(target: Target, signal: AbortSignal): Promise<string>;
  select(target: Target, value: string, signal: AbortSignal): Promise<void>;
  type(target: Target, value: string, signal: AbortSignal): Promise<void>;
  upload(target: Target, fileToken: string, signal: AbortSignal): Promise<void>;
  waitFor(target: Target, signal: AbortSignal): Promise<void>;
}

function abortable(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("aborted");
}

export class PlaywrightBrowserOperations implements BrowserOperations {
  readonly #context: BrowserContext;
  readonly #page: Page;
  readonly #uploads: Readonly<Record<string, string>>;

  private constructor(context: BrowserContext, page: Page, uploads: Readonly<Record<string, string>>) {
    this.#context = context;
    this.#page = page;
    this.#uploads = uploads;
  }

  static async launch(options: { headless?: boolean; profileDirectory: string; uploads?: Readonly<Record<string, string>> }): Promise<PlaywrightBrowserOperations> {
    await mkdir(options.profileDirectory, { recursive: true, mode: 0o700 });
    await chmod(options.profileDirectory, 0o700);
    const context = await chromium.launchPersistentContext(options.profileDirectory, { headless: options.headless ?? true });
    const page = context.pages()[0] ?? (await context.newPage());
    return new PlaywrightBrowserOperations(context, page, options.uploads ?? {});
  }

  #locator(target: Target): Locator {
    if (target.label) return this.#page.getByLabel(target.label).first();
    if (target.testId) return this.#page.getByTestId(target.testId).first();
    return this.#page.getByRole(target.role!, { name: target.name! }).first();
  }

  async click(target: Target, signal: AbortSignal): Promise<void> { abortable(signal); await this.#locator(target).click(); abortable(signal); }
  async close(): Promise<void> { await this.#context.close(); }
  currentUrl(): string { return this.#page.url(); }
  async navigationClick(target: Target, signal: AbortSignal): Promise<void> {
    abortable(signal);
    const href = await this.#locator(target).getAttribute("href");
    if (!href) throw new ToolExecutionError("policy_denied", false);
    const destination = new URL(href, this.#page.url());
    if (!["http:", "https:"].includes(destination.protocol)) {
      throw new ToolExecutionError("policy_denied", false);
    }
    await this.#page.goto(destination.href, { waitUntil: "domcontentloaded" });
    abortable(signal);
  }
  async open(url: string, signal: AbortSignal): Promise<{ title: string; url: string }> { abortable(signal); await this.#page.goto(url, { waitUntil: "domcontentloaded" }); abortable(signal); return { title: await this.#page.title(), url: this.#page.url() }; }
  async read(target: Target, signal: AbortSignal): Promise<string> { abortable(signal); const text = await this.#locator(target).innerText(); abortable(signal); return text; }
  async select(target: Target, value: string, signal: AbortSignal): Promise<void> { abortable(signal); await this.#locator(target).selectOption(value); abortable(signal); }
  async type(target: Target, value: string, signal: AbortSignal): Promise<void> { abortable(signal); await this.#locator(target).fill(value); abortable(signal); }
  async upload(target: Target, fileToken: string, signal: AbortSignal): Promise<void> { const path = this.#uploads[fileToken]; if (!path) throw new Error("Unapproved upload token"); abortable(signal); await this.#locator(target).setInputFiles(path); abortable(signal); }
  async waitFor(target: Target, signal: AbortSignal): Promise<void> { abortable(signal); await this.#locator(target).waitFor({ state: "visible" }); abortable(signal); }
}

const targetInput = z.object({ target: targetSchema });
const readInput = z.object({ items: z.array(z.object({ key: z.string().min(1).max(100), target: targetSchema })).min(1).max(20) });
const typeInput = targetInput.extend({ value: z.string().max(5_000) });
const selectInput = targetInput.extend({ value: z.string().min(1).max(500) });
const uploadInput = targetInput.extend({ fileToken: z.string().min(1).max(100) });
const submitInput = targetInput.extend({ operationKey: z.string().min(1).max(200), verification: z.object({ expectedText: z.string().min(1).max(500), target: targetSchema }) });

function actionResult(browser: BrowserOperations) { return { data: { acted: true as const, url: browser.currentUrl() }, retryable: false, status: "success" as const }; }
const readRetry = { maxAttempts: 2, retryableFailureClasses: ["timeout", "transport_error"] } as const;
const noRetry = { maxAttempts: 1, retryableFailureClasses: [] } as const;

async function verifySubmission(
  browser: BrowserOperations,
  input: z.infer<typeof submitInput>,
  context: ToolExecutionContext
) {
  try {
    const text = await browser.read(input.verification.target, context.signal);
    if (!text.includes(input.verification.expectedText)) return { status: "absent" as const };
    return {
      data: actionResult(browser).data,
      evidence: [{ payload: { method: "visible_confirmation" }, type: "browser_confirmation" }],
      status: "exists" as const
    };
  } catch {
    return { failureClass: "verification_failed" as const, status: "unknown" as const };
  }
}

export function createBrowserToolDefinitions(browser: BrowserOperations): readonly AnyToolDefinition[] {
  const open = defineTool({
    execute: async (input: { url: string }, context: ToolExecutionContext) => { const location = await browser.open(input.url, context.signal); return { data: { title: asUntrustedText(location.title, 500), url: location.url }, retryable: false, status: "success" as const }; },
    inputSchema: z.object({ url: z.url().refine((url) => ["http:", "https:"].includes(new URL(url).protocol)) }), integration: "browser" as const, name: "browser.open", outputSchema: browserLocationSchema, permission: "external_read" as const, retryPolicy: readRetry,
    safeInputSummary: (input: { url: string }) => ({ origin: new URL(input.url).origin }), safeOutputSummary: (output: z.infer<typeof browserLocationSchema>) => ({ origin: new URL(output.url).origin }), sideEffect: "read_only" as const, timeoutMs: 15_000
  });
  const read = defineTool({
    execute: async (input: z.infer<typeof readInput>, context: ToolExecutionContext) => ({ data: { fields: await Promise.all(input.items.map(async (item) => ({ key: item.key, value: asUntrustedText(await browser.read(item.target, context.signal)) }))), url: browser.currentUrl() }, retryable: false, status: "success" as const }),
    inputSchema: readInput, integration: "browser" as const, name: "browser.read", outputSchema: readOutputSchema, permission: "external_read" as const, retryPolicy: readRetry,
    safeInputSummary: (input: z.infer<typeof readInput>) => ({ fields: input.items.map((item) => item.key) }), safeOutputSummary: (output: z.infer<typeof readOutputSchema>) => ({ fieldCount: output.fields.length }), sideEffect: "read_only" as const, timeoutMs: 10_000
  });
  const action = <Input>(name: string, inputSchema: z.ZodType<Input>, operation: (input: Input, context: ToolExecutionContext) => Promise<void>) => defineTool({
    execute: async (input: Input, context: ToolExecutionContext) => { await operation(input, context); return actionResult(browser); }, inputSchema, integration: "browser" as const, name, outputSchema: actionOutputSchema, permission: "browser_interact" as const, retryPolicy: noRetry,
    safeInputSummary: () => ({ action: name }), safeOutputSummary: () => ({ acted: true }), sideEffect: "reversible" as const, timeoutMs: 10_000
  });
  const navigationClick = defineTool({
    execute: async (input: z.infer<typeof targetInput>, context: ToolExecutionContext) => { await browser.navigationClick(input.target, context.signal); return actionResult(browser); },
    inputSchema: targetInput, integration: "browser" as const, name: "browser.click", outputSchema: actionOutputSchema, permission: "browser_interact" as const, retryPolicy: readRetry,
    safeInputSummary: () => ({ action: "browser.click", classification: "deterministic_navigation" }), safeOutputSummary: (output: z.infer<typeof actionOutputSchema>) => ({ navigatedOrigin: new URL(output.url).origin }), sideEffect: "read_only" as const, timeoutMs: 15_000
  });
  const submit = defineTool({
    execute: async (input: z.infer<typeof submitInput>, context: ToolExecutionContext) => {
      await browser.waitFor(input.target, context.signal);
      context.reportSideEffectStarted();
      await browser.click(input.target, context.signal);
      const verification = await verifySubmission(browser, input, context);
      return verification.status === "exists"
        ? { ...actionResult(browser), evidence: verification.evidence }
        : {
            evidence: [{ payload: { method: "browser_verification_required" }, type: "submission_attempt" }],
            failureClass: "verification_failed" as const,
            retryable: false,
            status: "unknown" as const
          };
    },
    idempotencyKey: (input: z.infer<typeof submitInput>) => `browser.submit:${input.operationKey}`, inputSchema: submitInput, integration: "browser" as const, name: "browser.submit", outputSchema: actionOutputSchema, permission: "external_write" as const,
    retryPolicy: { maxAttempts: 2, retryableFailureClasses: ["timeout", "transport_error"] } as const, safeInputSummary: (input: z.infer<typeof submitInput>) => ({ operationKey: input.operationKey }), safeOutputSummary: () => ({ submitted: true }), sideEffect: "consequential" as const, timeoutMs: 15_000,
    verify: async (input: z.infer<typeof submitInput>, context: ToolExecutionContext) => verifySubmission(browser, input, context)
  });
  return [
    open, read,
    navigationClick,
    action("browser.type", typeInput, (input, context) => browser.type(input.target, input.value, context.signal)),
    action("browser.select", selectInput, (input, context) => browser.select(input.target, input.value, context.signal)),
    action("browser.upload", uploadInput, (input, context) => browser.upload(input.target, input.fileToken, context.signal)),
    submit
  ] as unknown as readonly AnyToolDefinition[];
}
