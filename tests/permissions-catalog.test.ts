import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isPermissionKey, PERMISSION_KEYS, permissionScope, rolePermissions, SYSTEM_ROLES } from "@/server/auth/permissions.catalog";
import { backoffMs } from "@/server/jobs/queue";

describe("permission catalog + system roles", () => {
  const role = (slug: string) => new Set(SYSTEM_ROLES.find((r) => r.slug === slug)!.permissions);

  it("keys are unique and every system role uses known keys", () => {
    expect(new Set(PERMISSION_KEYS).size).toBe(PERMISSION_KEYS.length);
    for (const r of SYSTEM_ROLES) for (const p of r.permissions) expect(isPermissionKey(p)).toBe(true);
  });

  it("owner has everything; admin everything but ownership", () => {
    expect(role("owner").size).toBe(PERMISSION_KEYS.length);
    expect(role("admin").has("workspace.manage")).toBe(false);
    expect(role("admin").has("members.manage")).toBe(true);
  });

  it("brief duties stay separated", () => {
    expect(role("manager").has("agents.run")).toBe(true);
    expect(role("manager").has("content.approve")).toBe(false);
    expect(role("approver").has("content.approve")).toBe(true);
    expect(role("creator").has("context.confirm")).toBe(false);
    expect(role("viewer").has("content.create")).toBe(false);
  });

  it("Commercial owner merged into Manager: Manager holds commercial.manage, Approver doesn't (brief B7)", () => {
    expect(SYSTEM_ROLES.some((r) => r.slug === "commercial-owner")).toBe(false);
    expect(role("approver").has("commercial.manage")).toBe(false);
    expect(role("manager").has("commercial.manage")).toBe(true);
    expect(role("project-admin").has("commercial.manage")).toBe(true);
  });

  it("crm.read and ads.read are held by Owner, Admin, Project admin and Manager only", () => {
    for (const key of ["crm.read", "ads.read"] as const) {
      expect(permissionScope(key)).toBe("PROJECT");
      expect(SYSTEM_ROLES.filter((r) => r.permissions.includes(key)).map((r) => r.slug).sort()).toEqual(["admin", "manager", "owner", "project-admin"]);
    }
    for (const slug of ["client-reviewer", "viewer", "approver", "creator"]) {
      expect(role(slug).has("crm.read")).toBe(false);
      expect(role(slug).has("ads.read")).toBe(false);
    }
  });

  it("project roles hold only project permissions; Member reaches no project by itself", () => {
    for (const r of SYSTEM_ROLES.filter((r) => r.scope === "PROJECT")) {
      for (const p of r.permissions) expect(permissionScope(p)).toBe("PROJECT");
      expect(r.permissions).toContain("brand.read");
    }
    expect(role("member").size).toBe(0);
    expect(role("project-admin").has("project.members.manage")).toBe(true);
  });
});

describe("rolePermissions", () => {
  it("Owner and Admin come from the catalog whatever is stored; other roles, built-in or not, from their row", () => {
    const admin = SYSTEM_ROLES.find((r) => r.slug === "admin")!.permissions;
    expect(rolePermissions({ isSystem: true, slug: "admin", permissions: ["brand.read"] })).toEqual(admin);
    expect(rolePermissions({ isSystem: true, slug: "owner", permissions: [] })).toContain("tasks.all");
    // An owner's edit of a built-in Creator is honoured.
    expect(rolePermissions({ isSystem: true, slug: "creator", permissions: ["brand.read", "tasks.read"] })).toEqual(["brand.read", "tasks.read"]);
    // A custom role named like a built-in isn't one.
    expect(rolePermissions({ isSystem: false, slug: "admin", permissions: ["brand.read"] })).toEqual(["brand.read"]);
  });

  it("the role-reset migration, with later key additions, writes exactly the catalog for every built-in role, and moves Commercial owner to Manager", () => {
    const dir = join(__dirname, "../prisma/migrations");
    const sql = readFileSync(join(dir, readdirSync(dir).find((d) => d.endsWith("_task_owner_role"))!, "migration.sql"), "utf8");
    const rows = [...sql.matchAll(/^\s+\('([a-z-]+)', '([^']*)', '([^']*)', '(WORKSPACE|PROJECT)', ARRAY\[([^\]]*)\]::TEXT\[\]\)/gm)].map((m) => ({
      slug: m[1], name: m[2], description: m[3], scope: m[4], permissions: [...m[5]!.matchAll(/'([^']+)'/g)].map((k) => k[1]),
    }));
    // Later migrations add keys to built-in rows; with those applied, the snapshot is the catalog (as sets: appended keys
    // land at the end of a stored row).
    let migrated = rows;
    for (const name of ["_crm_ads_read", "_crm_manage"]) {
      const added = readFileSync(join(dir, readdirSync(dir).find((d) => d.endsWith(name))!, "migration.sql"), "utf8");
      const addedKeys = [...added.match(/unnest\(ARRAY\[([^\]]*)\]/)![1]!.matchAll(/'([^']+)'/g)].map((k) => k[1]!);
      const addedTo = [...added.match(/"slug" IN \(([^)]*)\)/)![1]!.matchAll(/'([^']+)'/g)].map((k) => k[1]);
      migrated = migrated.map((r) => ({ ...r, permissions: addedTo.includes(r.slug) ? [...r.permissions, ...addedKeys] : r.permissions }));
    }
    migrated = migrated.map((r) => ({ ...r, permissions: [...r.permissions].sort() }));
    expect(migrated).toEqual(SYSTEM_ROLES.map((r) => ({ slug: r.slug, name: r.name, description: r.description, scope: r.scope, permissions: [...r.permissions].sort() })));
    for (const table of ["BrandMember", "WorkspaceMember", "Invitation"]) expect(sql).toContain(`UPDATE "${table}"`);
    expect(sql).toMatch(/DELETE FROM "Role" co\s+WHERE co."isSystem" AND co.slug = 'commercial-owner'/);
  });
});

describe("job backoff", () => {
  it("grows exponentially and caps at one hour", () => {
    expect(backoffMs(1)).toBe(30_000);
    expect(backoffMs(30)).toBe(60 * 60_000);
  });
});
