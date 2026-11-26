import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// list.ts also holds the route handlers, whose auth import pulls next-auth (unloadable under vitest). Not used here.
vi.mock("@/server/auth/request-user", () => ({ requestUserId: vi.fn() }));
import { prisma } from "@/server/db/prisma";
import { ensureSystemRoles, hasOtherHolder } from "@/server/auth/permissions";
import { pruneNotifications } from "@/server/notifications/daily-tasks";
import { countUnread, listNotifications, markRead } from "@/server/notifications/list";
import { adAlertRecipients, notifyAdAlert } from "@/server/notifications/ads";

/**
 * AD_ALERT notices in the bell against Postgres: who is notified (brand.read and ads.read on role ∪ grant, workspace role
 * required, active), that the read rule agrees with it, and that losing the key or archiving the brand hides them.
 *
 * People on brand `bell-a`: Owner (DB role), Admin (legacy enum role, no roleId), Manager and Project admin grants,
 * Viewer, Creator and Client reviewer grants, a custom workspace role with brand.read plus a grant adding ads.read
 * (`mixed`), a grant of ads.read alone (`adsOnly`), a Manager grant without any workspace membership (`grantOnly`) and a
 * disabled Manager.
 */
let ws: string;
let brand: string;
const user: Record<string, string> = {};
const roles: Record<string, string> = {};

beforeAll(async () => {
  ws = (await prisma.workspace.create({ data: { name: "W", slug: "w-ad-alert-bell" } })).id;
  brand = (await prisma.brand.create({ data: { workspaceId: ws, slug: "bell-a", displayName: "Bell A" } })).id;
  await ensureSystemRoles(ws);
  for (const r of await prisma.role.findMany({ where: { workspaceId: ws } })) roles[r.slug] = r.id;
  roles.brandReader = (await prisma.role.create({ data: { workspaceId: ws, slug: "brand-reader", name: "Brand reader", permissions: ["brand.read"] } })).id;
  roles.adsReader = (await prisma.role.create({ data: { workspaceId: ws, slug: "ads-reader", name: "Ads reader", scope: "PROJECT", permissions: ["ads.read"] } })).id;
  const people = ["owner", "admin", "manager", "padmin", "viewer", "creator", "clientr", "mixed", "adsOnly", "grantOnly", "disabled"];
  for (const n of people) {
    user[n] = (await prisma.user.create({ data: { email: `${n}@ad-alert-bell.test`, status: n === "disabled" ? "DISABLED" : "ACTIVE" } })).id;
  }
  const member = (n: string, roleId: string | null, role: "OWNER" | "ADMIN" | "EDITOR" = "EDITOR") =>
    prisma.workspaceMember.create({ data: { workspaceId: ws, userId: user[n], roleId, role } });
  const grant = (n: string, slug: string) => prisma.brandMember.create({ data: { workspaceId: ws, brandId: brand, userId: user[n], roleId: roles[slug] } });
  await member("owner", roles.owner);
  await member("admin", null, "ADMIN");
  for (const n of ["manager", "padmin", "viewer", "creator", "clientr", "adsOnly", "disabled"]) await member(n, roles.member);
  await member("mixed", roles.brandReader);
  await grant("manager", "manager");
  await grant("padmin", "project-admin");
  await grant("viewer", "viewer");
  await grant("creator", "creator");
  await grant("clientr", "client-reviewer");
  await grant("mixed", "adsReader");
  await grant("adsOnly", "adsReader");
  await grant("grantOnly", "manager");
  await grant("disabled", "manager");
});

beforeEach(async () => {
  await prisma.notification.deleteMany({});
  await prisma.adAlert.deleteMany({});
  await prisma.task.deleteMany({});
  await prisma.brand.update({ where: { id: brand }, data: { status: "ACTIVE" } });
  await prisma.brandMember.updateMany({ where: { userId: user.manager }, data: { roleId: roles.manager } });
});

const scope = () => ({ workspaceId: ws, brandId: brand });
let seq = 0;
const alert = () =>
  prisma.adAlert.create({
    data: {
      ...scope(), kind: "NO_PURCHASES", accountId: "act_1", campaignName: `Spring${String.fromCharCode(10)}sale`, currency: "EUR",
      firstDay: new Date("2026-11-22"), lastDay: new Date("2026-11-22"), values: { day: "2026-11-22", spend: "46.10" },
      subjectKey: `s${++seq}`, dedupeKey: `s${seq}:2026-11-22`,
    },
  });
const name = (id: string) => Object.keys(user).find((k) => user[k] === id);

describe("who is notified", () => {
  it("Owner, Admin (legacy role), Manager, Project admin and role ∪ grant holding both keys; not Viewer, Creator, Client reviewer, ads.read alone, a grant without a workspace role or a disabled person", async () => {
    expect((await adAlertRecipients(scope())).map(name).sort()).toEqual(["admin", "manager", "mixed", "owner", "padmin"]);
  });

  it("the people notified are exactly the people who can list the notice", async () => {
    const a = await alert();
    // Everyone gets a notice row, so the read rule alone decides who sees it.
    const everyone = Object.values(user);
    await prisma.$transaction((tx) => notifyAdAlert(tx, { id: a.id, ...scope() }, everyone));
    const recipients = new Set(await adAlertRecipients(scope()));
    for (const id of everyone) {
      if (id === user.disabled) continue; // can't sign in; the read rule doesn't look at status
      const listed = (await listNotifications(id, ws)).notifications.length;
      expect([name(id), listed]).toEqual([name(id), recipients.has(id) ? 1 : 0]);
      expect(await countUnread(id, ws)).toBe(recipients.has(id) ? 1 : 0);
    }
  });

  it("lists the alert's cleaned text; a notice is hidden and uncounted once the reader loses ads.read", async () => {
    const a = await alert();
    await prisma.$transaction((tx) => notifyAdAlert(tx, { id: a.id, ...scope() }, [user.manager, user.manager]));
    const [n] = (await listNotifications(user.manager, ws)).notifications;
    expect(n).toMatchObject({ kind: "AD_ALERT", brandId: brand, taskId: null, actor: null, count: 1 });
    expect(n.alert).toEqual({ kind: "NO_PURCHASES", text: 'Campaign "Spring sale" spent 46.10 EUR with no purchases for 3 days to 2026-11-22 (purchases can still grow a little)' });
    await prisma.brandMember.updateMany({ where: { userId: user.manager }, data: { roleId: roles.viewer } });
    expect(await countUnread(user.manager, ws)).toBe(0);
    expect((await listNotifications(user.manager, ws)).notifications).toEqual([]);
  });

  it("an archived brand notifies nobody and hides its notices, also from a reader through a grant", async () => {
    const a = await alert();
    await prisma.$transaction((tx) => notifyAdAlert(tx, { id: a.id, ...scope() }, [user.owner, user.manager]));
    await prisma.brand.update({ where: { id: brand }, data: { status: "ARCHIVED" } });
    expect(await adAlertRecipients(scope())).toEqual([]);
    for (const who of ["owner", "manager"]) expect(await countUnread(user[who], ws)).toBe(0);
    expect((await listNotifications(user.manager, ws)).notifications).toEqual([]);
  });
});

describe("the bell", () => {
  it("countUnread makes the same queries as before: the role, the grants and the count", async () => {
    const a = await alert();
    await prisma.$transaction((tx) => notifyAdAlert(tx, { id: a.id, ...scope() }, [user.manager]));
    const raw = vi.spyOn(prisma, "$queryRaw");
    const member = vi.spyOn(prisma.workspaceMember, "findUnique");
    const grants = vi.spyOn(prisma.brandMember, "findMany");
    const role = vi.spyOn(prisma.role, "findUnique");
    expect(await countUnread(user.manager, ws)).toBe(1);
    expect([raw.mock.calls.length, member.mock.calls.length, grants.mock.calls.length, role.mock.calls.length]).toEqual([1, 1, 1, 0]);
    vi.restoreAllMocks();
  });

  it("a group read of AD_ALERT marks only those, not task notices", async () => {
    const [a, b] = [await alert(), await alert()];
    await prisma.$transaction(async (tx) => {
      await notifyAdAlert(tx, { id: a.id, ...scope() }, [user.owner]);
      await notifyAdAlert(tx, { id: b.id, ...scope() }, [user.owner]);
    });
    const t = await prisma.task.create({ data: { workspaceId: ws, brandId: brand, title: "T", ownerId: user.owner } });
    await prisma.notification.create({ data: { userId: user.owner, workspaceId: ws, brandId: brand, kind: "TASK_ASSIGNED", taskId: t.id, dedupeKey: "task" } });
    const groups = (await listNotifications(user.owner, ws)).notifications;
    expect(groups.map((g) => [g.kind, g.count]).sort()).toEqual([["AD_ALERT", 2], ["TASK_ASSIGNED", 1]]);
    expect(await markRead(user.owner, ws, { kind: "AD_ALERT", brandId: brand, upTo: new Date().toISOString() })).toBe(2);
    expect((await prisma.notification.findMany({ where: { readAt: null } })).map((n) => n.kind)).toEqual(["TASK_ASSIGNED"]);
  });

  it("prune removes alert notices after 90 days and keeps the alert", async () => {
    const a = await alert();
    await prisma.notification.create({
      data: { userId: user.owner, workspaceId: ws, brandId: brand, kind: "AD_ALERT", adAlertId: a.id, dedupeKey: "old", createdAt: new Date(Date.now() - 91 * 86_400_000) },
    });
    await pruneNotifications(new Date());
    expect(await prisma.notification.count()).toBe(0);
    expect(await prisma.adAlert.count()).toBe(1);
  });
});

describe("hasOtherHolder", () => {
  it("is unchanged: an inactive other holder still counts, a client grant never does", async () => {
    expect(await hasOtherHolder(ws, brand, user.owner, "ads.read")).toBe(true); // Admin, Manager…
    const solo = (await prisma.workspace.create({ data: { name: "Solo", slug: "w-ad-alert-bell-solo" } })).id;
    const b = (await prisma.brand.create({ data: { workspaceId: solo, slug: "solo", displayName: "Solo" } })).id;
    await ensureSystemRoles(solo);
    const r = Object.fromEntries((await prisma.role.findMany({ where: { workspaceId: solo } })).map((x) => [x.slug, x.id]));
    const [me, gone, cli] = await Promise.all(["me", "gone", "cli"].map((n) => prisma.user.create({ data: { email: `${n}@solo.test`, status: n === "gone" ? "DISABLED" : "ACTIVE" } })));
    await prisma.workspaceMember.createMany({ data: [{ workspaceId: solo, userId: me.id, roleId: r.owner }, { workspaceId: solo, userId: cli.id, roleId: r.member }] });
    await prisma.brandMember.create({ data: { workspaceId: solo, brandId: b, userId: cli.id, roleId: r["client-reviewer"] } });
    expect(await hasOtherHolder(solo, b, me.id, "content.approve")).toBe(false);
    await prisma.workspaceMember.create({ data: { workspaceId: solo, userId: gone.id, roleId: r.admin } });
    expect(await hasOtherHolder(solo, b, me.id, "content.approve")).toBe(true);
  });
});
