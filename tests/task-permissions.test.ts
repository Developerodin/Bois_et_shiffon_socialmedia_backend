import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isPermissionKey, permissionScope, SYSTEM_ROLES } from "@/server/auth/permissions.catalog";

const holds = (slug: string, key: string) => (SYSTEM_ROLES.find((r) => r.slug === slug)!.permissions as string[]).includes(key);

const BOTH = ["owner", "admin", "manager", "creator", "commercial-owner", "project-admin"];
const READ_ONLY = ["approver", "viewer", "client-reviewer"];

describe("task permissions", () => {
  it("are project-scope keys", () => {
    for (const key of ["tasks.read", "tasks.manage"]) {
      expect(isPermissionKey(key)).toBe(true);
      expect(permissionScope(key as never)).toBe("PROJECT");
    }
  });

  it("owner, admin, manager, creator, commercial owner and project admin hold both keys", () => {
    for (const slug of BOTH) {
      expect(holds(slug, "tasks.read"), slug).toBe(true);
      expect(holds(slug, "tasks.manage"), slug).toBe(true);
    }
  });

  it("approver, viewer and client reviewer hold tasks.read only; member holds neither", () => {
    for (const slug of READ_ONLY) {
      expect(holds(slug, "tasks.read"), slug).toBe(true);
      expect(holds(slug, "tasks.manage"), slug).toBe(false);
    }
    expect(holds("member", "tasks.read")).toBe(false);
    expect(holds("member", "tasks.manage")).toBe(false);
  });

  it("the migration grants existing system roles what the catalog gives them", () => {
    const dir = join(__dirname, "../prisma/migrations");
    const sql = readFileSync(join(dir, readdirSync(dir).find((d) => d.endsWith("_phase1_tasks"))!, "migration.sql"), "utf8");
    const named = (key: string) =>
      sql
        .match(new RegExp(`array_append\\("permissions", '${key.replace(".", "\\.")}'\\)[^;]*?WHERE "isSystem" AND "slug" IN \\(([^)]*)\\)`))![1]!
        .match(/'[^']+'/g)!
        .map((s) => s.slice(1, -1))
        .sort();
    expect(named("tasks.read")).toEqual(SYSTEM_ROLES.filter((r) => holds(r.slug, "tasks.read")).map((r) => r.slug).sort());
    expect(named("tasks.manage")).toEqual(SYSTEM_ROLES.filter((r) => holds(r.slug, "tasks.manage")).map((r) => r.slug).sort());
    // Custom project roles that make posts get tasks.read.
    expect(sql).toMatch(/array_append\("permissions", 'tasks\.read'\)[^;]*WHERE NOT "isSystem" AND "scope" = 'PROJECT' AND 'content\.create' = ANY\("permissions"\)/);
  });
});
