import { randomUUID } from "node:crypto";
import { automationRuns, automations, runEvents, type Database } from "@personal-agent/db";
import { and, asc, eq, lte, sql } from "drizzle-orm";
import { Cron } from "croner";

const CATCH_UP_WINDOW_MS = 24 * 60 * 60 * 1_000;

export type ScheduleDecision = {
  automationId: string;
  nextRunAt: Date;
  outcome: "created" | "deduplicated" | "overlap" | "skipped";
  scheduledFor?: Date;
};

function cronFor(schedule: string, timezone: string): Cron {
  return new Cron(schedule, { mode: "5-part", paused: true, timezone });
}

export function previousOccurrence(schedule: string, timezone: string, now: Date): Date {
  const cron = cronFor(schedule, timezone);
  const currentMinute = cron.nextRun(new Date(now.getTime() - 60_000));

  if (currentMinute && currentMinute <= now) {
    return currentMinute;
  }

  const [occurrence] = cron.previousRuns(1, now);

  return occurrence!;
}

export function nextOccurrence(schedule: string, timezone: string, now: Date): Date {
  const occurrence = cronFor(schedule, timezone).nextRun(now);

  return occurrence!;
}

export async function scheduleDueAutomations(
  database: Database,
  now: Date,
  limit = 100
): Promise<ScheduleDecision[]> {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error("Scheduler batch limit must be a positive integer");
  }

  return database.transaction(async (transaction) => {
    const dueAutomations = await transaction
      .select()
      .from(automations)
      .where(and(eq(automations.enabled, true), lte(automations.nextRunAt, now)))
      .orderBy(asc(automations.nextRunAt), asc(automations.id))
      .limit(limit)
      .for("update", { skipLocked: true });
    const decisions: ScheduleDecision[] = [];

    for (const automation of dueAutomations) {
      const future = nextOccurrence(automation.schedule, automation.timezone, now);
      const latestMissed = previousOccurrence(automation.schedule, automation.timezone, now);
      const eligible = latestMissed.getTime() >= now.getTime() - CATCH_UP_WINDOW_MS;
      const runId = randomUUID();
      const inserted = await transaction
        .insert(automationRuns)
        .values({
          automationId: automation.id,
          availableAt: now,
          completedAt: eligible ? null : now,
          createdAt: now,
          id: runId,
          modelProfile: automation.modelProfile,
          scheduledFor: latestMissed,
          status: eligible ? "queued" : "succeeded",
          trigger: "scheduled",
          updatedAt: now,
          workflowPhase: eligible ? "scheduled" : "schedule_skipped"
        })
        .onConflictDoNothing()
        .returning({ id: automationRuns.id });

      let outcome: ScheduleDecision["outcome"];

      if (inserted.length > 0) {
        outcome = eligible ? "created" : "skipped";
        await transaction.insert(runEvents).values({
          createdAt: now,
          eventType: eligible ? "run_scheduled" : "schedule_skipped",
          id: randomUUID(),
          payload: eligible ? {} : { reason: "outside_catch_up_window" },
          runId,
          toStatus: eligible ? "queued" : "succeeded"
        });
      } else {
        const [duplicate] = await transaction
          .select({ id: automationRuns.id })
          .from(automationRuns)
          .where(
            and(
              eq(automationRuns.automationId, automation.id),
              eq(automationRuns.scheduledFor, latestMissed)
            )
          )
          .limit(1);

        if (!duplicate) {
          decisions.push({
            automationId: automation.id,
            nextRunAt: automation.nextRunAt,
            outcome: "overlap"
          });
          continue;
        }

        outcome = "deduplicated";
      }

      await transaction
        .update(automations)
        .set({ nextRunAt: future, updatedAt: now, version: sql`${automations.version} + 1` })
        .where(eq(automations.id, automation.id));
      decisions.push({
        automationId: automation.id,
        nextRunAt: future,
        outcome,
        scheduledFor: latestMissed
      });
    }

    return decisions;
  });
}
