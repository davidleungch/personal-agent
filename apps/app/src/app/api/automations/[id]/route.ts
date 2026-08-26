import { getAppRuntime } from "../../../../server/runtime";

export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  return getAppRuntime().api.updateAutomation(request, (await context.params).id);
}
