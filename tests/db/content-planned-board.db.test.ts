import { beforeAll, describe, expect, it, vi } from "vitest";

const who = vi.hoisted(() => ({ userId: "" }));
vi.mock("@/server/auth/request-user", () => ({ requestUserId: vi.fn(async () => who.userId) }));

import { prisma } from "@/server/db/prisma";
import { GET as list } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/content/route";
import { POST as act } from "@/app/api/v1/workspaces/[workspaceId]/brands/[brandId]/content/[contentId]/route";

/** A Pinterest Pin's planned board through the real brand guard: who may set it, what is stored, and what GET content sends. */
let ws: string;
let brand: string;
let pin: string;
let fb: string;
const users: Record<string, string> = {};

beforeAll(async () => {
  ws = (await prisma.workspace.create({ data: { name: "W", slug: "w-planned-board" } })).id;
  brand = (await prisma.brand.create({ data: { workspaceId: ws, slug: "b", displayName: "B" } })).id;
  const roles: Record<string, string[]> = {
    editor: ["brand.read", "content.create"],
    publisher: ["brand.read", "publish.execute"],
    viewer: ["brand.read"],
  };
  for (const [slug, permissions] of Object.entries(roles)) {
    const role = await prisma.role.create({ data: { workspaceId: ws, slug, name: slug, permissions } });
    const u = await prisma.user.create({ data: { email: `${slug}@planned-board.test`, name: slug } });
    await prisma.workspaceMember.create({ data: { workspaceId: ws, userId: u.id, roleId: role.id } });
    users[slug] = u.id;
  }
  pin = (await prisma.contentItem.create({ data: { workspaceId: ws, brandId: brand, title: "Oak pin", channel: "PINTEREST_PIN", status: "APPROVED", scheduledFor: new Date(Date.now() + 86_400_000) } })).id;
  fb = (await prisma.contentItem.create({ data: { workspaceId: ws, brandId: brand, title: "Oak post", channel: "FACEBOOK_POST", status: "APPROVED" } })).id;
});

const base = () => `http://x/api/v1/workspaces/${ws}/brands/${brand}`;
const plan = (id: string, board: unknown) =>
  act(new Request(`${base()}/content/${id}`, { method: "POST", body: JSON.stringify({ action: "planBoard", board }), headers: { "content-type": "application/json" } }), {
    params: Promise.resolve({ workspaceId: ws, brandId: brand, contentId: id }),
  });
const stored = () => prisma.contentItem.findUniqueOrThrow({ where: { id: pin }, select: { plannedBoardId: true, plannedBoardName: true } });
const as = (slug: string) => (who.userId = users[slug]!);

describe("planBoard", () => {
  it("someone who edits posts plans and clears a pin's board; the post view and the calendar send it", async () => {
    as("editor");
    const res = await plan(pin, { id: "bd1", name: " Living room " });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { plannedBoard: unknown }).plannedBoard).toEqual({ id: "bd1", name: "Living room" });
    expect(await stored()).toEqual({ plannedBoardId: "bd1", plannedBoardName: "Living room" });
    expect(await prisma.auditEvent.count({ where: { workspaceId: ws, action: "content.board", entityId: pin } })).toBe(1);
    const items = ((await (await list(new Request(`${base()}/content`), { params: Promise.resolve({ workspaceId: ws, brandId: brand }) })).json()) as { items: { id: string; plannedBoardName?: string | null }[] }).items;
    expect(items.find((i) => i.id === pin)?.plannedBoardName).toBe("Living room");
    expect((await plan(pin, null)).status).toBe(200);
    expect(await stored()).toEqual({ plannedBoardId: null, plannedBoardName: null });
  });

  it("needs content.create: a publisher or viewer who can't edit the post is refused", async () => {
    for (const slug of ["publisher", "viewer"]) {
      as(slug);
      expect((await plan(pin, { id: "bd1", name: "Living room" })).status).toBe(403);
    }
    expect(await stored()).toEqual({ plannedBoardId: null, plannedBoardName: null });
  });

  it("refuses a post that isn't a pin, and a board without an id or a name", async () => {
    as("editor");
    expect((await plan(fb, { id: "bd1", name: "Living room" })).status).toBe(400);
    expect((await plan(pin, { id: "bd1", name: "  " })).status).toBe(400);
    expect((await plan(pin, { id: "", name: "Living room" })).status).toBe(400);
    expect((await plan(pin, { id: "bd1" })).status).toBe(400);
  });
});
