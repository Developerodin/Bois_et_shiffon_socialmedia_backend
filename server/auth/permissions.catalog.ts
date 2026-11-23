/**
 * Permission catalog — single source of truth for permission keys (ported from
 * Cad `permissions.catalog.ts`). Keys are `resource.action`. Roles store keys.
 */
import { PERMISSIONS, type PermissionKey } from "@/shared";

export { PERMISSIONS, type PermissionKey };
export const PERMISSION_KEYS = PERMISSIONS.map(([key]) => key) as PermissionKey[];

export function isPermissionKey(key: string): key is PermissionKey {
  return (PERMISSION_KEYS as string[]).includes(key);
}

const ALL = PERMISSION_KEYS;
const WORKSPACE_ONLY: PermissionKey[] = [
  "workspace.manage", "members.read", "members.manage", "invitations.manage",
  "roles.read", "roles.manage", "audit.read", "brand.create", "brand.archive",
  // A cloned voice is someone's likeness, usable across the workspace: never granted with a project.
  "voices.manage",
];
export const PROJECT_KEYS = ALL.filter((k) => !WORKSPACE_ONLY.includes(k));
export const permissionScope = (k: PermissionKey) => (WORKSPACE_ONLY.includes(k) ? "WORKSPACE" : "PROJECT");
const READ: PermissionKey[] = ["brand.read", "agents.read", "analytics.read"];
/** A client's person on one project: approves, but never publishes, and their approval alone never counts as staff review (hasOtherApprover). */
export const CLIENT_REVIEWER = "client-reviewer";

/**
 * Seeded per workspace. Workspace roles decide who runs the workspace; project roles decide what someone does on one
 * project (brand). Owner and Admin take their permissions from here (rolePermissions), so a change to them applies to
 * every workspace at once; owners may edit the other built-ins, so a new key reaches those through a migration.
 * ponytail: Prisma filters on Role.permissions (`permissions: { has }`, `= ANY(permissions)`) read the stored copy, also
 * Owner's and Admin's; ship a change to those two with a migration that rewrites their rows (as 20261124130000 does).
 */
export const SYSTEM_ROLES: ReadonlyArray<{
  slug: string;
  name: string;
  description: string;
  scope: "WORKSPACE" | "PROJECT";
  permissions: PermissionKey[];
}> = [
  { slug: "owner", name: "Owner", scope: "WORKSPACE", description: "Full control of the workspace and every project, including ownership and billing", permissions: ALL },
  { slug: "admin", name: "Admin", scope: "WORKSPACE", description: "Manages people, roles and every project; not ownership", permissions: ALL.filter((p) => p !== "workspace.manage") },
  { slug: "member", name: "Member", scope: "WORKSPACE", description: "Sees only the projects they are invited to", permissions: [] },

  { slug: "project-admin", name: "Project admin", scope: "PROJECT", description: "Everything on this project, including who works on it", permissions: PROJECT_KEYS },
  {
    slug: "manager",
    name: "Manager",
    scope: "PROJECT",
    description: "Runs agents, strategy, the calendar, publishing, product priorities, campaigns and offers",
    permissions: [...READ, "agents.run", "context.edit", "context.confirm", "content.create", "content.download", "publish.execute", "integrations.manage", "inbox.read", "commercial.manage", "crm.read", "ads.read", "tasks.read", "tasks.manage"],
  },
  { slug: "creator", name: "Creator", scope: "PROJECT", description: "Writes and edits drafts", permissions: [...READ, "content.create", "tasks.read", "tasks.manage"] },
  {
    slug: "approver",
    name: "Approver",
    scope: "PROJECT",
    description: "Reviews posts, brand rules and strategy",
    permissions: [...READ, "context.edit", "context.confirm", "rules.approve", "content.approve", "content.download", "inbox.read", "tasks.read"],
  },
  {
    slug: CLIENT_REVIEWER,
    name: "Client reviewer",
    scope: "PROJECT",
    description: "Sees the work and reports, approves posts and downloads",
    // No agents.read (assistant, Translate) and no inbox.read: customer messages stay with the team that answers them.
    permissions: ["brand.read", "analytics.read", "content.approve", "content.download", "tasks.read"],
  },
  { slug: "viewer", name: "Viewer", scope: "PROJECT", description: "Read-only access to this project", permissions: [...READ, "tasks.read"] },
];

/** The built-in roles whose permissions are fixed in code: they hold every key (Admin all but ownership), always. */
const FIXED_ROLES = ["owner", "admin"];

/**
 * A role's permissions: built-in Owner and Admin from SYSTEM_ROLES (a new key reaches them with the code, and a stale
 * stored copy can't lock owners out); every other role, the other built-ins included (owners may edit those), from
 * its row.
 */
export function rolePermissions(role: { isSystem: boolean; slug: string; permissions: string[] }): string[] {
  if (!role.isSystem || !FIXED_ROLES.includes(role.slug)) return role.permissions;
  return SYSTEM_ROLES.find((r) => r.slug === role.slug)!.permissions;
}

/** Legacy WorkspaceRole enum → system role slug (fallback while roleId is null). */
export const LEGACY_ROLE_SLUG = {
  OWNER: "owner",
  ADMIN: "admin",
  EDITOR: "member",
  REVIEWER: "member",
  VIEWER: "member",
} as const;
