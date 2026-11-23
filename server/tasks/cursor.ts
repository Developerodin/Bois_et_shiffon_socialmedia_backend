import type { z } from "zod";
import { TaskError } from "@/server/tasks/errors";

/** A page's last sort key as an opaque `nextCursor`: base64url JSON. */
export const toCursor = (key: object): string => Buffer.from(JSON.stringify(key)).toString("base64url");

/** The key back, checked by `schema`; bad base64, JSON or shape is a 400 "Invalid cursor". */
export function fromCursor<T>(schema: z.ZodType<T>, s: string): T {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
  } catch {
    raw = null;
  }
  const key = schema.safeParse(raw);
  if (!key.success) throw new TaskError("Invalid cursor", 400);
  return key.data;
}
