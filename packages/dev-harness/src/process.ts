import { spawn } from "node:child_process";

export type ProcessResult = {
  durationMs: number;
  exitCode: number | null;
  outputLimitExceeded: boolean;
  stderr: string;
  stdout: string;
  timedOut: boolean;
};

export async function runProcess(input: {
  arguments: readonly string[];
  command: string;
  cwd?: string;
  environment?: NodeJS.ProcessEnv;
  maxOutputBytes: number;
  signal?: AbortSignal;
  timeoutMs: number;
}): Promise<ProcessResult> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(input.command, input.arguments, {
      cwd: input.cwd,
      env: input.environment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let timedOut = false;
    let outputLimitExceeded = false;

    const stop = () => child.kill("SIGKILL");
    const append = (
      current: Buffer<ArrayBufferLike>,
      chunk: Buffer<ArrayBufferLike>
    ): Buffer<ArrayBufferLike> => {
      const remaining = input.maxOutputBytes - stdout.length - stderr.length;
      if (remaining <= 0) {
        outputLimitExceeded = true;
        stop();
        return current;
      }
      if (chunk.length > remaining) {
        outputLimitExceeded = true;
        stop();
        return Buffer.concat([current, chunk.subarray(0, remaining)]);
      }
      return Buffer.concat([current, chunk]);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.on("error", reject);

    const timeout = setTimeout(() => {
      timedOut = true;
      stop();
    }, input.timeoutMs);
    const abort = () => stop();
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted) stop();

    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", abort);
      resolve({
        durationMs: Date.now() - startedAt,
        exitCode,
        outputLimitExceeded,
        stderr: stderr.toString("utf8"),
        stdout: stdout.toString("utf8"),
        timedOut
      });
    });
  });
}

export async function requireProcess(
  input: Parameters<typeof runProcess>[0],
  trimOutput = true
): Promise<string> {
  const result = await runProcess(input);
  if (result.exitCode !== 0 || result.timedOut || result.outputLimitExceeded) {
    throw new Error(
      `${input.command} failed (exit=${String(result.exitCode)}, timeout=${String(result.timedOut)}, output_limit=${String(result.outputLimitExceeded)}): ${result.stderr.trim()}`
    );
  }
  return trimOutput ? result.stdout.trim() : result.stdout;
}
