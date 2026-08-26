import { Dashboard } from "./dashboard";
import { getAppRuntime } from "../server/runtime";

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

function one(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export default async function Home({
  searchParams
}: {
  searchParams?: Promise<SearchParams>;
}) {
  const parameters: SearchParams = await (
    searchParams ?? Promise.resolve({} as SearchParams)
  );
  const runtime = getAppRuntime();
  let data:
    | {
        automations: Awaited<ReturnType<typeof runtime.service.listAutomations>>;
        command?: Awaited<ReturnType<typeof runtime.service.getCommand>>;
        run?: Awaited<ReturnType<typeof runtime.service.getRun>>;
        runs: Awaited<ReturnType<typeof runtime.service.listRuns>>;
        status: Awaited<ReturnType<typeof runtime.service.getStatus>>;
      }
    | undefined;
  try {
    const [status, automations, runs] = await Promise.all([
      runtime.service.getStatus(),
      runtime.service.listAutomations({}),
      runtime.service.listRuns({})
    ]);
    const commandId = one(parameters.command);
    const runId = one(parameters.run);
    const [command, run] = await Promise.all([
      commandId ? runtime.service.getCommand(commandId).catch(() => undefined) : undefined,
      runId ? runtime.service.getRun(runId, {}).catch(() => undefined) : undefined
    ]);
    data = {
      automations,
      ...(command ? { command } : {}),
      ...(run ? { run } : {}),
      runs,
      status
    };
  } catch {
    data = undefined;
  }
  if (!data) {
    return (
      <main>
        <h1>Personal Agent</h1>
        <p className="message error" role="alert">The local control plane is unavailable.</p>
      </main>
    );
  }
  const error = one(parameters.error);
  const notice = one(parameters.notice);
  return (
    <Dashboard
      {...data}
      {...(error ? { error } : {})}
      {...(notice ? { notice } : {})}
    />
  );
}
