import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/server/auth/request-user", () => ({ requestUserId: vi.fn() }));

import { prisma } from "@/server/db/prisma";
import { brandAccess } from "@/server/auth/access";
import { ensureSystemRoles } from "@/server/auth/permissions";
import { ArticleEdit, createArticle, decideArticle, deleteArticle, editArticle, type ArticleScope } from "@/server/blog/articles";

/** Articles against real tables: handles, versions on edit, the own-work approval rule and task scoping. */
let ws: string;
let brand: string;
let otherBrand: string;
const user: Record<string, string> = {};

async function scopeOf(name: string, b = brand): Promise<ArticleScope> {
  const access = await brandAccess(ws, b, user[name]!);
  return { userId: user[name]!, workspaceId: ws, brandId: b, perms: access.perms, clientReviewer: access.clientReviewer };
}
const blocks = [{ type: "p" as const, lines: [[{ text: "Wash cold.", bold: false, italic: false, href: null }]] }];
const refusal = (p: Promise<unknown>) => p.then(() => null, (e: { status?: number; code?: string }) => ({ status: e.status, code: e.code }));

beforeAll(async () => {
  ws = (await prisma.workspace.create({ data: { name: "W", slug: "w-blog" } })).id;
  brand = (await prisma.brand.create({ data: { workspaceId: ws, slug: "b", displayName: "B" } })).id;
  otherBrand = (await prisma.brand.create({ data: { workspaceId: ws, slug: "b2", displayName: "B2" } })).id;
  await ensureSystemRoles(ws);
  const admin = (await prisma.role.findFirstOrThrow({ where: { workspaceId: ws, slug: "admin" } })).id;
  for (const name of ["ana", "ben"]) {
    user[name] = (await prisma.user.create({ data: { email: `${name}@blog.test`, name } })).id;
    await prisma.workspaceMember.create({ data: { workspaceId: ws, userId: user[name]!, roleId: admin } });
  }
});

describe("blog articles", () => {
  it("handles are unique per brand: the same title gets the next free one", async () => {
    const ana = await scopeOf("ana");
    const a = await createArticle(ana, { topic: "Summer linen", productIds: [] });
    const b = await createArticle(ana, { topic: "Summer linen", productIds: [] });
    const c = await createArticle(await scopeOf("ana", otherBrand), { topic: "Summer linen", productIds: [] });
    expect([a.handle, b.handle, c.handle]).toEqual(["summer-linen", "summer-linen-2", "summer-linen"]);
    expect(await refusal(editArticle(ana, b.id, ArticleEdit.parse({ version: 1, handle: "summer-linen" })))).toEqual({ status: 409, code: "blog.handle" });
    await expect(prisma.blogArticle.create({ data: { workspaceId: ws, brandId: brand, title: "x", handle: "summer-linen", blocks: [] } })).rejects.toThrow();
  });

  it("an edit after approval goes back to review with the next version; a stale version is refused", async () => {
    const a = await createArticle(await scopeOf("ana"), { topic: "Washing", productIds: [] });
    const v2 = await editArticle(await scopeOf("ana"), a.id, ArticleEdit.parse({ version: 1, blocks }));
    expect(v2).toMatchObject({ version: 2, status: "DRAFT" });
    const approved = await decideArticle(await scopeOf("ben"), a.id, { version: 2, verdict: "APPROVED" });
    expect(approved).toMatchObject({ status: "APPROVED", approvedById: user.ben, version: 2 });
    const edited = await editArticle(await scopeOf("ben"), a.id, ArticleEdit.parse({ version: 2, title: "Washing linen" }));
    expect(edited).toMatchObject({ status: "IN_REVIEW", version: 3, approvedById: null, editedById: user.ben });
    expect(await refusal(editArticle(await scopeOf("ana"), a.id, ArticleEdit.parse({ version: 2, title: "Old" })))).toEqual({ status: 409, code: "blog.changed" });
  });

  it("approving your own article is refused while someone else can approve, allowed when nobody else can", async () => {
    const a = await createArticle(await scopeOf("ana"), { topic: "Drying", productIds: [] });
    await editArticle(await scopeOf("ana"), a.id, ArticleEdit.parse({ version: 1, blocks }));
    expect(await refusal(decideArticle(await scopeOf("ana"), a.id, { version: 2, verdict: "APPROVED" }))).toEqual({ status: 403, code: "blog.ownWork" });
    await prisma.workspaceMember.deleteMany({ where: { workspaceId: ws, userId: user.ben } });
    try {
      expect(await decideArticle(await scopeOf("ana"), a.id, { version: 2, verdict: "APPROVED" })).toMatchObject({ status: "APPROVED" });
    } finally {
      const admin = (await prisma.role.findFirstOrThrow({ where: { workspaceId: ws, slug: "admin" } })).id;
      await prisma.workspaceMember.create({ data: { workspaceId: ws, userId: user.ben!, roleId: admin } });
    }
  });

  it("an article with a write being sent or unconfirmed can't be deleted; once settled it can", async () => {
    const ana = await scopeOf("ana");
    const a = await createArticle(ana, { topic: "Ironing", productIds: [] });
    await prisma.blogArticle.update({ where: { id: a.id }, data: { shopifyId: "gid://shopify/Article/9" } });
    for (const [action, status] of [["ARTICLE_CREATE", "UNKNOWN"], ["ARTICLE_UPDATE", "PENDING"]] as const) {
      const w = await prisma.shopifyWrite.create({ data: { workspaceId: ws, brandId: brand, entityType: "BLOG_ARTICLE", entityId: a.id, version: 1, action, payloadHash: action, status, actorUserId: user.ana! } });
      expect(await refusal(deleteArticle(ana, a.id))).toEqual({ status: 409, code: "blog.writeInFlight" });
      await prisma.shopifyWrite.update({ where: { id: w.id }, data: { status: "DONE" } });
    }
    await deleteArticle(ana, a.id);
    expect((await prisma.blogArticle.findUniqueOrThrow({ where: { id: a.id } })).status).toBe("ARCHIVED");
  });

  it("a task or product of another brand is not found", async () => {
    const task = await prisma.task.create({ data: { workspaceId: ws, brandId: otherBrand, title: "Write about care", areas: ["SEO"] } });
    const product = await prisma.product.create({ data: { workspaceId: ws, brandId: otherBrand, source: "MANUAL", title: "Sheet" } });
    const ana = await scopeOf("ana");
    expect(await refusal(createArticle(ana, { taskId: task.id, productIds: [] }))).toMatchObject({ status: 404 });
    expect(await refusal(createArticle(ana, { topic: "x", productIds: [product.id] }))).toMatchObject({ status: 404 });
    const own = await createArticle(await scopeOf("ana", otherBrand), { taskId: task.id, productIds: [product.id] });
    expect(own).toMatchObject({ title: "Write about care", taskId: task.id, productIds: [product.id] });
  });
});
