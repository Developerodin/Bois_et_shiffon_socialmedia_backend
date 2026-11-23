import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db/prisma";
import type { PermissionKey } from "@/server/auth/permissions.catalog";
import { taskViewer } from "@/server/tasks/access";
import { listProjects } from "@/server/tasks/projects";

/** 25 dated + 10 undated projects: the first page (30) ends on an undated one, so the cursor row has dueOn NULL. */
let scope: { workspaceId: string; brandId: string; userId: string; perms: Set<PermissionKey>; clientReviewer: boolean };

beforeAll(async () => {
  const ws = (await prisma.workspace.create({ data: { name: "W", slug: "w-projects-list" } })).id;
  const brandId = (await prisma.brand.create({ data: { workspaceId: ws, slug: "b", displayName: "B" } })).id;
  const userId = (await prisma.user.create({ data: { email: "manager@projects-list.test" } })).id;
  scope = { workspaceId: ws, brandId, userId, perms: new Set(["brand.read", "tasks.read", "tasks.manage"]), clientReviewer: false };
  await prisma.workProject.createMany({
    data: Array.from({ length: 35 }, (_, i) => ({
      workspaceId: ws,
      brandId,
      name: `P${i}`,
      dueOn: i < 25 ? new Date(Date.UTC(2026, 11, 1 + i)) : null,
    })),
  });
});

describe("project list paging", () => {
  it("pages past an undated cursor row without losing or repeating projects", async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 5; i++) {
      const page = await listProjects(scope, taskViewer(scope), { cursor });
      seen.push(...page.projects.map((p) => p.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(seen).toHaveLength(35);
    expect(new Set(seen).size).toBe(35);
  });
});
