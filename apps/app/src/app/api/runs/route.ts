import { getAppRuntime } from "../../../server/runtime";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return getAppRuntime().api.listRuns(request);
}
