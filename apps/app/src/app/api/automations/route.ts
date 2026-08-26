import { getAppRuntime } from "../../../server/runtime";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return getAppRuntime().api.listAutomations(request);
}

export function POST(request: Request) {
  return getAppRuntime().api.createAutomation(request);
}
