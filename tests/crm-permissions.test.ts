import { describe, expect, it } from "vitest";
import { isPermissionKey, permissionScope, SYSTEM_ROLES } from "@/server/auth/permissions.catalog";
import { CRM_TASK_KEYS } from "@/shared";

const holds = (slug: string, key: string) => (SYSTEM_ROLES.find((r) => r.slug === slug)!.permissions as string[]).includes(key);

describe("crm.manage", () => {
  it("is a project-scope key in the crm group, apart from crm.read", () => {
    expect(isPermissionKey("crm.manage")).toBe(true);
    expect(permissionScope("crm.manage")).toBe("PROJECT");
  });

  it("owner, admin, project admin and manager hold it; client reviewer, viewer, creator and approver don't", () => {
    expect(SYSTEM_ROLES.filter((r) => holds(r.slug, "crm.manage")).map((r) => r.slug).sort()).toEqual(["admin", "manager", "owner", "project-admin"]);
  });

  it("approver keeps inbox.read; the client reviewer holds no CRM task key by default", () => {
    expect(holds("approver", "inbox.read")).toBe(true);
    for (const k of CRM_TASK_KEYS) expect(holds("client-reviewer", k), k).toBe(false);
  });
});
