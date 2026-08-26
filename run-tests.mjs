import { spawnSync } from "node:child_process";

const suppliedDatabaseUrl = process.env.TEST_DATABASE_URL;
const containerName = `personal-agent-test-postgres-${process.pid}`;
let startedContainer = false;

function run(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    encoding: "utf8",
    env: process.env,
    stdio: options.capture ? "pipe" : "inherit"
  });
  if (result.error) throw result.error;
  return result;
}

function requireSuccess(result, message) {
  if (result.status !== 0) throw new Error(message);
  return result;
}

async function provisionDatabase() {
  requireSuccess(
    run("docker", [
      "run",
      "--detach",
      "--rm",
      "--name",
      containerName,
      "--publish",
      "127.0.0.1::5432",
      "--env",
      "POSTGRES_DB=personal_agent_test",
      "--env",
      "POSTGRES_PASSWORD=personal_agent_test",
      "--env",
      "POSTGRES_USER=personal_agent",
      "postgres:17-bookworm"
    ]),
    "Unable to start the isolated PostgreSQL test container"
  );
  startedContainer = true;

  const portOutput = requireSuccess(
    run("docker", ["port", containerName, "5432/tcp"], { capture: true }),
    "Unable to resolve the PostgreSQL test port"
  ).stdout.trim();
  const port = portOutput.match(/:(\d+)$/)?.[1];
  if (!port) throw new Error("Docker returned an invalid PostgreSQL test port");

  for (let attempt = 0; attempt < 60; attempt += 1) {
    const ready = run(
      "docker",
      ["exec", containerName, "pg_isready", "-U", "personal_agent", "-d", "personal_agent_test"],
      { capture: true }
    );
    if (ready.status === 0) {
      return `postgresql://personal_agent:personal_agent_test@127.0.0.1:${port}/personal_agent_test`;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error("PostgreSQL test container did not become ready");
}

try {
  const databaseUrl = suppliedDatabaseUrl ?? await provisionDatabase();
  const result = spawnSync("pnpm", ["exec", "vitest", "run", ...process.argv.slice(2)], {
    env: { ...process.env, TEST_DATABASE_URL: databaseUrl },
    stdio: "inherit"
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  if (startedContainer) {
    const stopped = run("docker", ["stop", containerName], { capture: true });
    if (stopped.status !== 0) {
      console.error(`Unable to stop PostgreSQL test container ${containerName}`);
      process.exitCode = 1;
    }
  }
}
