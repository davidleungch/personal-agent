import { getAppRuntime } from "../../../../server/runtime";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  return getAppRuntime().api.getCommand(request, (await context.params).id);
}
