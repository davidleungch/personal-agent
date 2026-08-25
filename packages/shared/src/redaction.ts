import { z } from "zod";
import { jsonObjectSchema, type JsonObject, type JsonValue } from "./domain.js";

const redaction = "[REDACTED]";
const sensitiveKey = /(^|[_-])(authorization|cookie|password|secret|api[_-]?key|refresh[_-]?token)($|[_-])/i;
const recognizedSecretPatterns = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bya29\.[A-Za-z0-9._-]{10,}\b/g,
  /\b1\/\/[A-Za-z0-9._-]{10,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g
];
const providerModelId = /\b(?:(?:gpt|o[1-9]|claude|gemini)-[A-Za-z0-9._-]+|luna|terra|sol)\b/i;
const prohibitedDurableKeys = new Set([
  "emailbody",
  "fullprompt",
  "html",
  "messages",
  "model",
  "modelid",
  "pagecontent",
  "prompt",
  "providermodel",
  "rawcontent",
  "transcript"
]);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizedSecrets(knownSecrets: readonly string[]): string[] {
  return [...new Set(knownSecrets.filter((value) => value.length > 0))].sort(
    (left, right) => right.length - left.length || left.localeCompare(right)
  );
}

export function redactText(value: string, knownSecrets: readonly string[] = []): string {
  let result = value;

  for (const secret of normalizedSecrets(knownSecrets)) {
    result = result.replace(new RegExp(escapeRegExp(secret), "g"), redaction);
  }

  for (const pattern of recognizedSecretPatterns) {
    result = result.replace(pattern, redaction);
  }

  return result;
}

export function isSecretFreeText(value: string, knownSecrets: readonly string[] = []): boolean {
  return redactText(value, knownSecrets) === value;
}

export function isDurableJson(value: JsonValue): boolean {
  if (typeof value === "string") {
    return !providerModelId.test(value);
  }

  if (Array.isArray(value)) {
    return value.every(isDurableJson);
  }

  if (value !== null && typeof value === "object") {
    return Object.entries(value).every(
      ([key, item]) =>
        !prohibitedDurableKeys.has(key.replace(/[^a-z0-9]/gi, "").toLowerCase()) &&
        isDurableJson(item)
    );
  }

  return true;
}

export function redactJson(value: JsonValue, knownSecrets: readonly string[] = []): JsonValue {
  if (typeof value === "string") {
    return redactText(value, knownSecrets);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactJson(item, knownSecrets));
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).map((key) => [
        key,
        sensitiveKey.test(key) ? redaction : redactJson(value[key] as JsonValue, knownSecrets)
      ])
    );
  }

  return value;
}

export function createSecretFreeTextSchema(knownSecrets: readonly string[] = []): z.ZodString {
  return z
    .string()
    .refine((value) => isSecretFreeText(value, knownSecrets), "Secret material is not allowed");
}

export function createSecretFreeJsonSchema(
  knownSecrets: readonly string[] = []
): z.ZodType<JsonObject> {
  return jsonObjectSchema.refine(
    (value) => {
      const redacted = redactJson(value, knownSecrets);
      return JSON.stringify(redacted) === JSON.stringify(value);
    },
    "Secret material is not allowed"
  );
}
