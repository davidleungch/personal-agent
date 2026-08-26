import {
  completionModeSchema,
  modelProfileSchema,
  toolPolicySchema
} from "@personal-agent/shared";
import type { ProductService } from "../server/product";
import {
  createAutomationAction,
  createCommandAction,
  resumeRunAction,
  updateAutomationAction
} from "./actions";

type CommandView = Awaited<ReturnType<ProductService["getCommand"]>>;
type AutomationList = Awaited<ReturnType<ProductService["listAutomations"]>>;
type RunList = Awaited<ReturnType<ProductService["listRuns"]>>;
type RunDetail = Awaited<ReturnType<ProductService["getRun"]>>;
type StatusView = Awaited<ReturnType<ProductService["getStatus"]>>;

export type DashboardProps = {
  automations: AutomationList;
  command?: CommandView;
  error?: string;
  notice?: string;
  run?: RunDetail;
  runs: RunList;
  status: StatusView;
};

function time(value: string | null): string {
  return value ? new Date(value).toLocaleString("en-HK", { hour12: false }) : "—";
}

function State({ value }: { value: string }) {
  return <span className={`state state-${value}`}>{value.replaceAll("_", " ")}</span>;
}

function AutomationFields({ automation }: { automation?: AutomationList["items"][number] }) {
  return (
    <>
      <label>
        Name
        <input name="name" defaultValue={automation?.name ?? ""} maxLength={200} required />
      </label>
      <label className="wide">
        Goal
        <textarea name="goal" defaultValue={automation?.goal ?? ""} maxLength={8_000} required />
      </label>
      <label>
        Schedule
        <input name="schedule" defaultValue={automation?.schedule ?? "0 9 * * *"} required />
      </label>
      <label>
        Timezone
        <input name="timezone" defaultValue={automation?.timezone ?? "Asia/Hong_Kong"} required />
      </label>
      <label>
        Model profile
        <select name="modelProfile" defaultValue={automation?.modelProfile ?? "balanced"}>
          {modelProfileSchema.options.map((profile) => <option key={profile}>{profile}</option>)}
        </select>
      </label>
      <label>
        Tool policy
        <select name="toolPolicy" defaultValue={automation?.toolPolicy ?? "none"}>
          {toolPolicySchema.options.map((policy) => <option key={policy}>{policy}</option>)}
        </select>
      </label>
      <label>
        Completion
        <select name="completionMode" defaultValue={automation?.completionMode ?? "continue"}>
          {completionModeSchema.options.map((mode) => <option key={mode}>{mode}</option>)}
        </select>
      </label>
      <label className="check">
        <input
          name="enabled"
          type="checkbox"
          defaultChecked={automation?.enabled ?? true}
        />
        Enabled
      </label>
    </>
  );
}

export function Dashboard({ automations, command, error, notice, run, runs, status }: DashboardProps) {
  return (
    <main>
      <header>
        <div>
          <p className="eyebrow">Local control plane</p>
          <h1>Personal Agent</h1>
        </div>
        <div className="status-grid" aria-label="System status">
          <span>Database <State value={status.database} /></span>
          <span>Worker <State value={status.worker} /></span>
          <span>Browser <State value={status.integrations.browser} /></span>
          <span>OpenAI <State value={status.integrations.openai} /></span>
          <span>Google <State value={status.integrations.google} /></span>
        </div>
      </header>

      {error ? <p className="message error" role="alert">{error.replaceAll("_", " ")}</p> : null}
      {notice ? <p className="message" role="status">{notice.replaceAll("_", " ")}</p> : null}

      <section>
        <div className="section-heading">
          <div><p className="eyebrow">Command</p><h2>Give the platform work</h2></div>
          <p>Commands enter the durable PostgreSQL queue. The app never executes tools.</p>
        </div>
        <form action={createCommandAction} className="command-form">
          <textarea name="content" maxLength={8_000} placeholder="What should the agent do?" required />
          <button type="submit">Queue command</button>
        </form>
        {command ? (
          <article className="record">
            <div><State value={command.status} /> <code>{command.id}</code></div>
            <p>{command.content}</p>
            <small>Updated {time(command.updatedAt)}</small>
          </article>
        ) : null}
      </section>

      <section>
        <div className="section-heading">
          <div><p className="eyebrow">Automations</p><h2>Recurring work</h2></div>
          <p>{automations.page.count} shown · limit {automations.page.limit}</p>
        </div>
        <details className="editor">
          <summary>Create automation</summary>
          <form action={createAutomationAction} className="form-grid">
            <AutomationFields />
            <button type="submit">Create automation</button>
          </form>
        </details>
        <div className="stack">
          {automations.items.map((automation) => (
            <details className="record" key={automation.id}>
              <summary>
                <span><strong>{automation.name}</strong> <State value={automation.enabled ? "enabled" : "disabled"} /></span>
                <span>{automation.schedule} · {automation.timezone}</span>
              </summary>
              <p>{automation.goal}</p>
              <dl>
                <div><dt>Next run</dt><dd>{time(automation.nextRunAt)}</dd></div>
                <div><dt>Last run</dt><dd>{time(automation.lastRunAt)}</dd></div>
                <div><dt>Policy</dt><dd>{automation.toolPolicy}</dd></div>
                <div><dt>Version</dt><dd>{automation.version}</dd></div>
              </dl>
              <form action={updateAutomationAction} className="form-grid">
                <input type="hidden" name="id" value={automation.id} />
                <input type="hidden" name="version" value={automation.version} />
                <AutomationFields automation={automation} />
                <button type="submit">Save changes</button>
              </form>
            </details>
          ))}
          {automations.items.length === 0 ? <p className="empty">No automations yet.</p> : null}
        </div>
      </section>

      <section>
        <div className="section-heading">
          <div><p className="eyebrow">Activity</p><h2>Runs</h2></div>
          <p>{runs.page.count} shown · limit {runs.page.limit}</p>
        </div>
        <div className="stack">
          {runs.items.map((item) => (
            <a className="record run-link" href={`/?run=${item.id}`} key={item.id}>
              <span><strong>{item.automation.name}</strong> <State value={item.status} /></span>
              <span>{item.workflowPhase} · attempt {item.attempt} · {time(item.updatedAt)}</span>
            </a>
          ))}
          {runs.items.length === 0 ? <p className="empty">No runs yet.</p> : null}
        </div>
      </section>

      {run ? (
        <section id="run-detail">
          <div className="section-heading">
            <div><p className="eyebrow">Run detail</p><h2>{run.automation.name}</h2></div>
            <State value={run.status} />
          </div>
          <dl>
            <div><dt>Run ID</dt><dd><code>{run.id}</code></dd></div>
            <div><dt>Trigger</dt><dd>{run.trigger}</dd></div>
            <div><dt>Phase</dt><dd>{run.workflowPhase}</dd></div>
            <div><dt>Scheduled</dt><dd>{time(run.scheduledFor)}</dd></div>
            <div><dt>Result</dt><dd>{run.resultSummary ?? "—"}</dd></div>
            <div><dt>Error</dt><dd>{run.errorSummary ?? "—"}</dd></div>
          </dl>
          {run.status === "needs_human" ? (
            <form action={resumeRunAction}>
              <input type="hidden" name="id" value={run.id} />
              <button type="submit">Resume after completing the requested step</button>
            </form>
          ) : null}

          <div className="audit-grid">
            <article>
              <h3>Events</h3>
              <ul>{run.events.map((item) => <li key={item.id}>{item.eventType} · {item.fromStatus ?? "—"} → {item.toStatus ?? "—"}</li>)}</ul>
            </article>
            <article>
              <h3>Evidence</h3>
              <ul>{run.evidence.map((item) => <li key={item.id}>{item.type} · {item.tool ?? "run"} · {item.externalId ?? "no external ID"}</li>)}</ul>
            </article>
            <article>
              <h3>Tool calls</h3>
              <ul>{run.toolCalls.map((item) => <li key={item.id}>{item.tool} · {item.status} · attempt {item.attempt}</li>)}</ul>
            </article>
            <article>
              <h3>Model invocations</h3>
              <ul>{run.modelInvocations.map((item) => <li key={item.id}>{item.role} · {item.modelProfile} · {item.status}</li>)}</ul>
            </article>
          </div>
        </section>
      ) : null}
    </main>
  );
}
