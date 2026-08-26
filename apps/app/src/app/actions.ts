"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { publicError } from "../server/http";
import { getAppRuntime } from "../server/runtime";

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

async function finish(
  operation: () => Promise<string>
): Promise<never> {
  let destination: string;
  try {
    destination = await operation();
  } catch (error) {
    destination = `/?error=${publicError(error).code}`;
  }
  revalidatePath("/");
  redirect(destination);
}

export async function createCommandAction(form: FormData): Promise<never> {
  return finish(async () => {
    const command = await getAppRuntime().service.createCommand({ content: text(form, "content") });
    return `/?command=${command.id}`;
  });
}

function automationInput(form: FormData) {
  return {
    completionMode: text(form, "completionMode"),
    enabled: form.get("enabled") === "on",
    goal: text(form, "goal"),
    modelProfile: text(form, "modelProfile"),
    name: text(form, "name"),
    schedule: text(form, "schedule"),
    timezone: text(form, "timezone"),
    toolPolicy: text(form, "toolPolicy")
  };
}

export async function createAutomationAction(form: FormData): Promise<never> {
  return finish(async () => {
    await getAppRuntime().service.createAutomation(automationInput(form));
    return "/?notice=automation_created";
  });
}

export async function updateAutomationAction(form: FormData): Promise<never> {
  return finish(async () => {
    await getAppRuntime().service.updateAutomation(text(form, "id"), {
      ...automationInput(form),
      version: Number(text(form, "version"))
    });
    return "/?notice=automation_updated";
  });
}

export async function resumeRunAction(form: FormData): Promise<never> {
  const id = text(form, "id");
  return finish(async () => {
    await getAppRuntime().service.resumeRun(id, {});
    return `/?run=${id}&notice=run_resumed`;
  });
}
