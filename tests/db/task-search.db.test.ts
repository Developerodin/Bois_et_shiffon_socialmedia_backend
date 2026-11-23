import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db/prisma";
import { brandAccess } from "@/server/auth/access";
import { taskViewer } from "@/server/tasks/access";
import { searchBrand } from "@/server/tasks/search";

/** Two brands with "Menu" rows of every kind; staff owns the workspace, the client holds a client-reviewer grant on b1. */
let ws: string;
let b1: string;
let b2: string;
let staff: string;
let client: string;

beforeAll(async () => {
  ws = (await prisma.workspace.create({ data: { name: "W", slug: "w-task-search" } })).id;
  [b1, b2] = (
    await Promise.all([
      prisma.brand.create({ data: { workspaceId: ws, slug: "b1", displayName: "B1" } }),
      prisma.brand.create({ data: { workspaceId: ws, slug: "b2", displayName: "B2" } }),
    ])
  ).map((b) => b.id) as [string, string];
  const [ownerRole, memberRole, clientRole] = await Promise.all([
    prisma.role.create({ data: { workspaceId: ws, slug: "owner", name: "Owner", isSystem: true, permissions: ["brand.read", "content.approve", "tasks.read", "tasks.manage"] } }),
    prisma.role.create({ data: { workspaceId: ws, slug: "member", name: "Member", isSystem: true, permissions: [] } }),
    prisma.role.create({ data: { workspaceId: ws, slug: "client-reviewer", name: "Client", isSystem: true, scope: "PROJECT", permissions: ["brand.read", "content.approve", "tasks.read"] } }),
  ]);
  staff = (await prisma.user.create({ data: { email: "staff@task-search.test" } })).id;
  client = (await prisma.user.create({ data: { email: "client@task-search.test" } })).id;
  await prisma.workspaceMember.createMany({ data: [{ workspaceId: ws, userId: staff, roleId: ownerRole.id }, { workspaceId: ws, userId: client, roleId: memberRole.id }] });
  await prisma.brandMember.create({ data: { workspaceId: ws, brandId: b1, userId: client, roleId: clientRole.id } });

  for (const brandId of [b1, b2]) {
    const tag = brandId === b1 ? "one" : "two";
    const [shared, internal] = await Promise.all([
      prisma.workProject.create({ data: { workspaceId: ws, brandId, name: `Menu shared ${tag}`, clientVisible: true } }),
      prisma.workProject.create({ data: { workspaceId: ws, brandId, name: `Menu internal ${tag}` } }),
    ]);
    await prisma.task.createMany({
      data: [
        { workspaceId: ws, brandId, title: `Menu reviewed ${tag}`, reviewerId: client },
        { workspaceId: ws, brandId, title: `Menu in shared ${tag}`, workProjectId: shared.id },
        { workspaceId: ws, brandId, title: `Menu internal ${tag}`, workProjectId: internal.id },
        { workspaceId: ws, brandId, title: `Menu plain ${tag}` },
      ],
    });
    await Promise.all([
      prisma.contentItem.create({ data: { workspaceId: ws, brandId, title: `Menu post ${tag}`, channel: "INSTAGRAM_POST" } }),
      prisma.product.create({ data: { workspaceId: ws, brandId, source: "MANUAL", title: `Menu board ${tag}` } }),
      prisma.campaign.create({ data: { workspaceId: ws, brandId, name: `Menu sale ${tag}`, startsAt: new Date("2026-11-01T00:00:00Z") } }),
    ]);
  }
});

async function search(userId: string, brandId: string, q = "menu") {
  const access = await brandAccess(ws, brandId, userId);
  const scope = { userId, workspaceId: ws, brandId, perms: access.perms, clientReviewer: access.clientReviewer };
  return searchBrand(scope, taskViewer(scope), q);
}
const titles = (hits: { title: string }[]) => hits.map((h) => h.title).sort();

describe("search", () => {
  it("search hides internal tasks from clients", async () => {
    const out = await search(client, b1);
    expect(titles(out.tasks)).toEqual(["Menu in shared one", "Menu reviewed one"]);
    expect(titles(out.projects)).toEqual(["Menu shared one"]);
    expect(titles(out.posts)).toEqual(["Menu post one"]);
    expect(out.products).toEqual([]);
    expect(out.campaigns).toEqual([]);
  });

  it("search never returns another brand's rows", async () => {
    const out = await search(staff, b1);
    const all = [...out.tasks, ...out.projects, ...out.posts, ...out.products, ...out.campaigns];
    expect(all.length).toBe(4 + 2 + 1 + 1 + 1);
    expect(all.every((h) => h.title.endsWith(" one"))).toBe(true);
  });

  it("a typed % is a character, not a wildcard", async () => {
    const out = await search(staff, b1, "m%u");
    expect([...out.tasks, ...out.projects, ...out.posts, ...out.products, ...out.campaigns]).toEqual([]);
  });
});
