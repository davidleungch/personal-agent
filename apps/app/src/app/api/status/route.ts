import { getAppRuntime } from "../../../server/runtime";

export const dynamic = "force-dynamic";

export function GET() {
  return getAppRuntime().api.status();
}
