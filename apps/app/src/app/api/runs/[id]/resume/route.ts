import { getAppRuntime } from "../../../../../server/runtime";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  return getAppRuntime().api.resumeRun(request, (await context.params).id);
}
