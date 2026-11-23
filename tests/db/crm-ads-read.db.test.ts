import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db/prisma";
import { brandAccess } from "@/server/auth/access";
import { SYSTEM_ROLES } from "@/server/auth/permissions.catalog";
import { ensureSystemRoles } from "@/server/auth/permissions";
import { createRole } from "@/server/services/workspace-admin";

/**
 * crm.read / ads.read: a workspace seeded now (ensureSystemRoles) and one seeded before the keys existed, then migrated
 * (20261125090000_crm_ads_read, run twice), give each built-in role the same keys. A custom role named like a built-in
 * is left alone, and the role editor treats the new keys like any other.
 */
const KEYS = ["crm.read", "ads.read"];
const dir = join(__dirname, "../../prisma/migrations");
const migration = readFileSync(join(dir, readdirSync(dir).find((d) => d.endsWith("_crm_ads_read"))!, "migration.sql"), "utf8");

const ws: Record<string, string> = {};
const brand: Record<string, string> = {};
const user: Record<string, string> = {};
const slugs = ["project-admin", "manager", "creator", "approver", "client-reviewer", "viewer"];

async function seed(name: string, fresh: boolean) {
  const w = (await prisma.workspace.create({ data: { name, slug: `w-crm-ads-${name}` } })).id;
  ws[name] = w;
  brand[name] = (await prisma.brand.create({ data: { workspaceId: w, slug: "b", displayName: "B" } })).id;
  if (fresh) await ensureSystemRoles(w);
  else {
    // As a workspace made before the keys existed; Project admin already had crm.read (an owner's edit).
    await prisma.role.createMany({
      data: SYSTEM_ROLES.map((r) => ({
        ...r,
        workspaceId: w,
        isSystem: true,
        permissions: r.permissions.filter((p) => !KEYS.includes(p) || (r.slug === "project-admin" && p === "crm.read")),
      })),
    });
  }
  const role = Object.fromEntries((await prisma.role.findMany({ where: { workspaceId: w } })).map((r) => [r.slug, r.id]));
  for (const s of [...slugs, "admin"]) {
    const u = (await prisma.user.create({ data: { email: `${s}@${name}.crm-ads.test`, name: s } })).id;
    user[`${name}:${s}`] = u;
    await prisma.workspaceMember.create({ data: { workspaceId: w, userId: u, roleId: role[s === "admin" ? "admin" : "member"]! } });
    if (s !== "admin") await prisma.brandMember.create({ data: { workspaceId: w, brandId: brand[name]!, userId: u, roleId: role[s]! } });
  }
}

const perms = async (name: string, slug: string) => (await brandAccess(ws[name]!, brand[name]!, user[`${name}:${slug}`]!)).perms;
const stored = async (name: string) =>
  Object.fromEntries((await prisma.role.findMany({ where: { workspaceId: ws[name], isSystem: true } })).map((r) => [r.slug, r.permissions]));

beforeAll(async () => {
  await seed("fresh", true);
  await seed("old", false);
  // A custom role using a built-in slug, in a workspace whose built-in manager is not seeded.
  ws.custom = (await prisma.workspace.create({ data: { name: "custom", slug: "w-crm-ads-custom" } })).id;
  await prisma.role.create({ data: { workspaceId: ws.custom, slug: "manager", name: "Manager", isSystem: false, scope: "PROJECT", permissions: ["brand.read"] } });
  await prisma.$executeRawUnsafe(migration);
  await prisma.$executeRawUnsafe(migration);
});

describe("crm.read / ads.read on built-in roles", () => {
  it("a migrated workspace gives every built-in role the same keys as a fresh one", async () => {
    for (const slug of [...slugs, "admin"]) {
      expect([...(await perms("old", slug))].sort(), slug).toEqual([...(await perms("fresh", slug))].sort());
    }
    expect([...(await perms("old", "manager"))]).toEqual(expect.arrayContaining(KEYS));
  });

  it("client reviewer, viewer, approver and creator get neither", async () => {
    for (const name of ["fresh", "old"]) {
      for (const slug of ["client-reviewer", "viewer", "approver", "creator"]) {
        const p = await perms(name, slug);
        for (const k of KEYS) expect(p.has(k as never), `${name} ${slug} ${k}`).toBe(false);
      }
    }
  });

  it("the migration is re-run safe: no row holds a key twice, and stored rows match the catalog as sets", async () => {
    const rows = await stored("old");
    for (const r of SYSTEM_ROLES) {
      expect(new Set(rows[r.slug]).size, r.slug).toBe(rows[r.slug]!.length);
      expect([...rows[r.slug]!].sort(), r.slug).toEqual([...r.permissions].sort());
    }
  });

  it("leaves a custom role with a built-in slug alone", async () => {
    const r = await prisma.role.findFirstOrThrow({ where: { workspaceId: ws.custom, slug: "manager" } });
    expect(r.permissions).toEqual(["brand.read"]);
  });

  it("the role editor treats the new keys like any other: only someone holding them can put them in a role", async () => {
    const w = ws.fresh!;
    const editor = (await prisma.role.create({ data: { workspaceId: w, slug: "editor", name: "Editor", permissions: ["roles.read", "roles.manage", "brand.read"] } })).id;
    const ed = (await prisma.user.create({ data: { email: "ed@crm-ads.test", name: "ed" } })).id;
    await prisma.workspaceMember.create({ data: { workspaceId: w, userId: ed, roleId: editor } });
    const input = { name: "Sales", scope: "PROJECT" as const, permissions: ["brand.read", "crm.read"] as ("brand.read" | "crm.read")[] };
    await expect(createRole(w, ed, input)).rejects.toMatchObject({ status: 403 });
    const made = await createRole(w, user["fresh:admin"]!, input);
    expect(made.permissions).toEqual(["brand.read", "crm.read"]);
  });
});
