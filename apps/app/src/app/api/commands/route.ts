import { getAppRuntime } from "../../../server/runtime";

export const dynamic = "force-dynamic";

export function POST(request: Request) {
  return getAppRuntime().api.createCommand(request);
}
