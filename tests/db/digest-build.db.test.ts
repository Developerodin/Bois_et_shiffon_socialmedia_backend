import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db/prisma";
import { ensureSystemRoles } from "@/server/auth/permissions";
import { buildDigest, readableDigest, readerAccess } from "@/server/digest/build";

/**
 * buildDigest on built-in roles. `admin` is workspace Admin (every key); `viewer`, `client` hold the Viewer and Client
 * reviewer grants; `lead` a custom project role with tasks.all but no CRM key. The week is 2026-11-16..22 (UTC brand).
 */
const NOW = new Date("2026-11-23T08:00:00Z");
let ws: string;
let brand: string;
const user: Record<string, string> = {};

const kinds = (body: Awaited<ReturnType<typeof buildDigest>>) => body?.brands.map((b) => [b.brandId, b.sections.map((s) => s.kind)]);
const tasksOf = (body: Awaited<ReturnType<typeof buildDigest>>) => body?.brands[0]?.sections.find((s) => s.kind === "tasks");

beforeAll(async () => {
  ws = (await prisma.workspace.create({ data: { name: "W", slug: "w-digest" } })).id;
  brand = (await prisma.brand.create({ data: { workspaceId: ws, slug: "b", displayName: "B" } })).id;
  await ensureSystemRoles(ws);
  const role = Object.fromEntries((await prisma.role.findMany({ where: { workspaceId: ws } })).map((r) => [r.slug, r.id]));
  role.lead = (await prisma.role.create({ data: { workspaceId: ws, slug: "lead", name: "Lead", scope: "PROJECT", permissions: ["brand.read", "tasks.read", "tasks.all"] } })).id;
  for (const [name, grant] of [["admin", null], ["viewer", "viewer"], ["client", "client-reviewer"], ["lead", "lead"]] as const) {
    user[name] = (await prisma.user.create({ data: { email: `${name}@digest.test`, name } })).id;
    await prisma.workspaceMember.create({ data: { workspaceId: ws, userId: user[name]!, roleId: role[grant ? "member" : "admin"]! } });
    if (grant) await prisma.brandMember.create({ data: { workspaceId: ws, brandId: brand, userId: user[name]!, roleId: role[grant]! } });
  }
  const synced = { syncedThrough: new Date("2026-11-20T00:00:00Z") };
  await prisma.dataSource.createMany({
    data: [
      { workspaceId: ws, brandId: brand, kind: "SEARCH_CONSOLE", externalId: "sc-domain:b.test", ...synced },
      { workspaceId: ws, brandId: brand, kind: "SHOPIFY_ORDERS", externalId: "b.myshopify.com", ...synced },
      { workspaceId: ws, brandId: brand, kind: "META_ADS", externalId: "act_1", ...synced },
    ],
  });
  await prisma.contentItem.create({ data: { workspaceId: ws, brandId: brand, title: "Post", channel: "INSTAGRAM_POST", status: "AWAITING_APPROVAL" } });
  await prisma.task.createMany({
    data: [
      { workspaceId: ws, brandId: brand, title: "Fix the footer", areas: ["WEBSITE"], ownerId: user.viewer, dueOn: new Date("2026-11-20T00:00:00Z") },
      { workspaceId: ws, brandId: brand, title: "Reply to a conversation", areas: ["CRM"] },
      { workspaceId: ws, brandId: brand, title: "Done last week", areas: ["GENERAL"], status: "DONE", completedAt: new Date("2026-11-18T10:00:00Z") },
    ],
  });
});

describe("buildDigest", () => {
  it("an admin gets every section, CRM tasks counted", async () => {
    const body = await buildDigest(user.admin!, ws, NOW);
    expect(kinds(body)).toEqual([[brand, ["content", "tasks", "seo", "posts", "sales", "ads"]]]);
    expect(body?.brands[0]?.week).toEqual({ from: "2026-11-16", to: "2026-11-22" });
    expect(tasksOf(body)).toMatchObject({ crm: true, done: 1, open: 2, overdue: 1, overdueTasks: [{ title: "Fix the footer" }] });
    expect(body?.brands[0]?.sections.find((s) => s.kind === "sales")).toMatchObject({ data: [] });
  });

  it("a viewer gets no sales or ads, and counts only their own tasks", async () => {
    const body = await buildDigest(user.viewer!, ws, NOW);
    expect(kinds(body)).toEqual([[brand, ["content", "tasks", "seo", "posts"]]]);
    expect(tasksOf(body)).toMatchObject({ crm: false, done: 0, open: 1, overdue: 1 });
  });

  it("a client reviewer by default gets no sales or ads, and no task they can't see", async () => {
    const body = await buildDigest(user.client!, ws, NOW);
    expect(kinds(body)).toEqual([[brand, ["content", "tasks", "seo", "posts"]]]);
    expect(tasksOf(body)).toMatchObject({ done: 0, open: 0, overdue: 0 });
  });

  it("a CRM task is counted only with inbox.read or crm.manage", async () => {
    expect(tasksOf(await buildDigest(user.lead!, ws, NOW))).toMatchObject({ crm: false, done: 1, open: 1 });
  });

  it("an overdue task the reader can no longer see is dropped on read; the counts stay as built", async () => {
    const body = (await buildDigest(user.viewer!, ws, NOW))!;
    const task = await prisma.task.findFirstOrThrow({ where: { workspaceId: ws, title: "Fix the footer" } });
    await prisma.task.update({ where: { id: task.id }, data: { ownerId: user.admin } });
    try {
      const now = await readableDigest(body, user.viewer!, ws, (await readerAccess(user.viewer!, ws))!);
      expect(tasksOf(now)).toMatchObject({ overdue: 1, overdueTasks: [] });
    } finally {
      await prisma.task.update({ where: { id: task.id }, data: { ownerId: user.viewer } });
    }
  });

  it("nothing to say → null; a non-member → null", async () => {
    const quiet = (await prisma.workspace.create({ data: { name: "Q", slug: "w-digest-quiet" } })).id;
    await prisma.brand.create({ data: { workspaceId: quiet, slug: "q", displayName: "Q" } });
    await ensureSystemRoles(quiet);
    const admin = await prisma.role.findFirstOrThrow({ where: { workspaceId: quiet, slug: "admin" } });
    await prisma.workspaceMember.create({ data: { workspaceId: quiet, userId: user.viewer!, roleId: admin.id } });
    expect(await buildDigest(user.viewer!, quiet, NOW)).toBeNull();
    expect(await buildDigest(user.client!, quiet, NOW)).toBeNull();
  });

  it("another workspace's brands are never included", async () => {
    const other = (await prisma.workspace.create({ data: { name: "O", slug: "w-digest-other" } })).id;
    const otherBrand = (await prisma.brand.create({ data: { workspaceId: other, slug: "o", displayName: "O" } })).id;
    await ensureSystemRoles(other);
    const admin = await prisma.role.findFirstOrThrow({ where: { workspaceId: other, slug: "admin" } });
    await prisma.workspaceMember.create({ data: { workspaceId: other, userId: user.admin!, roleId: admin.id } });
    await prisma.contentItem.create({ data: { workspaceId: other, brandId: otherBrand, title: "Other", channel: "INSTAGRAM_POST", status: "AWAITING_APPROVAL" } });
    expect((await buildDigest(user.admin!, ws, NOW))?.brands.map((b) => b.brandId)).toEqual([brand]);
    expect((await buildDigest(user.admin!, other, NOW))?.brands.map((b) => b.brandId)).toEqual([otherBrand]);
  });
});
