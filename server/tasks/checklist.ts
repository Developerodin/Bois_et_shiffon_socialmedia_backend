import "server-only";
import type { TaskChecklistItem } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/server/db/prisma";
import { TX } from "@/server/services/publishing";
import { lockTaskForEdit, type TaskViewer } from "@/server/tasks/access";
import { taskAudit } from "@/server/tasks/audit";
import { TaskError } from "@/server/tasks/errors";
import type { TaskScope } from "@/server/tasks/service";
import type { TaskChecklistItemDto } from "@/shared";

const text = z.string().trim().min(1).max(300);
const ItemAdd = z.object({ text });
const ItemPatch = z
  .object({ text: text.optional(), done: z.boolean().optional(), position: z.number().int().min(0).max(100_000).optional() })
  .refine((o) => o.text !== undefined || o.done !== undefined || o.position !== undefined, "Nothing to change");

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new TaskError(r.error.issues[0]?.message ?? "Invalid checklist item", 400);
  return r.data;
}

export const toChecklistDto = (i: TaskChecklistItem): TaskChecklistItemDto => ({ id: i.id, text: i.text, position: i.position, doneAt: i.doneAt?.toISOString() ?? null, doneById: i.doneById });

/** The item, only if it belongs to this task (404 otherwise, so another task's id reads as missing). */
async function itemOf(tx: Parameters<typeof lockTaskForEdit>[0], taskId: string, itemId: string) {
  const item = await tx.taskChecklistItem.findFirst({ where: { id: itemId, taskId } });
  if (!item) throw new TaskError("Checklist item not found", 404);
  return item;
}

/**
 * Add a line at the end (owner or tasks.manage). The task lock makes "last position + 1" safe against a second add.
 * ponytail: no cap on lines per task; add one if a task ever gets hundreds.
 */
export async function addChecklistItem(scope: TaskScope, v: TaskViewer, taskId: string, body: unknown): Promise<TaskChecklistItemDto> {
  const input = parse(ItemAdd, body);
  return prisma.$transaction(async (tx) => {
    const task = await lockTaskForEdit(tx, v, scope.perms, taskId);
    const { _max } = await tx.taskChecklistItem.aggregate({ where: { taskId }, _max: { position: true } });
    const item = await tx.taskChecklistItem.create({ data: { taskId, text: input.text, position: (_max.position ?? -1) + 1 } });
    await taskAudit(tx, scope, "task.checklist.add", { type: "Task", id: taskId, title: task.title }, { itemId: item.id });
    return toChecklistDto(item);
  }, TX);
}

/** Edit a line's text, tick or untick it (records who and when), or move it (owner or tasks.manage). */
export async function patchChecklistItem(scope: TaskScope, v: TaskViewer, taskId: string, itemId: string, body: unknown): Promise<TaskChecklistItemDto> {
  const input = parse(ItemPatch, body);
  return prisma.$transaction(async (tx) => {
    const task = await lockTaskForEdit(tx, v, scope.perms, taskId);
    const current = await itemOf(tx, taskId, itemId);
    const data: Record<string, unknown> = {};
    if (input.text !== undefined) data.text = input.text;
    if (input.position !== undefined) data.position = input.position;
    if (input.done !== undefined) {
      data.doneAt = input.done ? (current.doneAt ?? new Date()) : null;
      data.doneById = input.done ? (current.doneById ?? scope.userId) : null;
    }
    const item = await tx.taskChecklistItem.update({ where: { id: itemId }, data });
    await taskAudit(tx, scope, "task.checklist.update", { type: "Task", id: taskId, title: task.title }, { itemId, fields: Object.keys(input) });
    return toChecklistDto(item);
  }, TX);
}

/** Remove a line (owner or tasks.manage); its text stays in the audit event. */
export async function removeChecklistItem(scope: TaskScope, v: TaskViewer, taskId: string, itemId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const task = await lockTaskForEdit(tx, v, scope.perms, taskId);
    const current = await itemOf(tx, taskId, itemId);
    await tx.taskChecklistItem.delete({ where: { id: itemId } });
    await taskAudit(tx, scope, "task.checklist.remove", { type: "Task", id: taskId, title: task.title }, { itemId, text: current.text });
  }, TX);
}
