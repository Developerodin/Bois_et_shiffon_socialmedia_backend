import { beforeAll, describe, expect, it, vi } from "vitest";

const who = vi.hoisted(() => ({ userId: "" }));
vi.mock("@/server/auth/request-user", () => ({ requestUserId: vi.fn(async () => who.userId) }));
// The Quality run is the agent engine's; here only that it is asked for.
const run = vi.hoisted(() => vi.fn(async () => null));
vi.mock("@/server/agents/engine", () => ({ startAgentRun: run, NothingToDoError: class extends Error {} }));
vi.mock("@/server/jobs/runner", () => ({ kickRunner: vi.fn() }));

import { prisma } from "@/server/db/prisma";
import { GET as list, POST as create } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/content/route";

/** New post's written channels against a real database: the item, its first version and its place in the calendar. */
let ws: string;
let brand: string;

beforeAll(async () => {
  ws = (await prisma.workspace.create({ data: { name: "W", slug: "w-written-post" } })).id;
  brand = (await prisma.brand.create({ data: { workspaceId: ws, slug: "b", displayName: "B" } })).id;
  const role = await prisma.role.create({ data: { workspaceId: ws, slug: "editor", name: "editor", permissions: ["brand.read", "content.create"] } });
  const u = await prisma.user.create({ data: { email: "editor@written-post.test", name: "Editor" } });
  await prisma.workspaceMember.create({ data: { workspaceId: ws, userId: u.id, roleId: role.id } });
  who.userId = u.id;
});

const base = () => `http://x/api/v1/workspaces/${ws}/brands/${brand}`;
const params = () => ({ params: Promise.resolve({ workspaceId: ws, brandId: brand }) });
const post = (b: object) => create(new Request(`${base()}/content`, { method: "POST", body: JSON.stringify(b), headers: { "content-type": "application/json" } }), params());

describe("POST content, written post", () => {
  it("stores the post at draft review with v1 by the person, dated as asked, and the calendar lists it", async () => {
    const at = new Date(Date.now() + 2 * 86_400_000);
    const requestId = "5d2b8f1a-3c4e-4f6a-9b7c-1e2d3f4a5b6c";
    const res = await post({ channel: "PINTEREST_PIN", text: "Oiled oak, made to last", pinTitle: "Oak dining table", pinLink: "https://shop.example/oak", photoKeys: [`${ws}/${brand}/a.jpg`], scheduledFor: at.toISOString(), requestId });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const item = await prisma.contentItem.findUniqueOrThrow({ where: { id }, include: { versions: true } });
    expect(item).toMatchObject({ channel: "PINTEREST_PIN", status: "DRAFT_REVIEW", title: "Oak dining table", ownerId: who.userId, brief: { written: true, requestId } });
    expect(item.scheduledFor?.toISOString()).toBe(at.toISOString());
    expect(item.versions).toHaveLength(1);
    expect(item.versions[0]).toMatchObject({ version: 1, createdBy: who.userId, body: { caption: "Oiled oak, made to last", pinTitle: "Oak dining table", pinLink: "https://shop.example/oak", photoKeys: [`${ws}/${brand}/a.jpg`] } });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ agentKey: "quality", input: { itemId: id, version: 1 } }));
    // The same request again: the same post, no second check.
    const again = await post({ channel: "PINTEREST_PIN", text: "Oiled oak, made to last", pinTitle: "Oak dining table", photoKeys: [`${ws}/${brand}/a.jpg`], requestId });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { id: string }).id).toBe(id);
    expect(await prisma.contentItem.count({ where: { brandId: brand } })).toBe(1);
    const listed = (await (await list(new Request(`${base()}/content`), params())).json()) as { items: { id: string; latest: { version: number } | null }[] };
    expect(listed.items.find((i) => i.id === id)?.latest?.version).toBe(1);
  });

  it("refuses an X post over 280 characters and stores nothing", async () => {
    const before = await prisma.contentItem.count({ where: { brandId: brand } });
    const res = await post({ channel: "X_POST", text: "a".repeat(281) });
    expect(res.status).toBe(400);
    expect(await prisma.contentItem.count({ where: { brandId: brand } })).toBe(before);
  });
});
