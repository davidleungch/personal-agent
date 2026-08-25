import type { Database } from "@personal-agent/db";
import { createRunState } from "./run-state.js";
import { scheduleDueAutomations } from "./scheduler.js";

export const SCHEDULER_POLL_INTERVAL_MS = 15_000;

export function createDurablePolling(
  database: Database,
  options: {
    clock?: () => Date;
    executeRun?: (now: Date) => Promise<void>;
    onError?: (error: unknown) => void;
    pollIntervalMs?: number;
  } = {}
) {
  const clock = options.clock ?? (() => new Date());
  const onError = options.onError ?? (() => undefined);
  const pollIntervalMs = options.pollIntervalMs ?? SCHEDULER_POLL_INTERVAL_MS;
  const runState = createRunState(database);
  let polling = false;
  let timer: NodeJS.Timeout | undefined;

  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new Error("Poll interval must be a positive integer");
  }

  async function tick(): Promise<void> {
    if (polling) {
      return;
    }

    polling = true;
    try {
      const now = clock();
      await scheduleDueAutomations(database, now);
      await runState.recoverExpiredLeases(now);
      await options.executeRun?.(now);
    } finally {
      polling = false;
    }
  }

  async function wake(): Promise<void> {
    try {
      await tick();
    } catch (error) {
      onError(error);
    }
  }

  function start(): void {
    if (timer) {
      return;
    }

    void wake();
    timer = setInterval(wake, pollIntervalMs);
  }

  function stop(): void {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
  }

  return { start, stop, tick };
}
