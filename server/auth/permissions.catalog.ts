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
 * Seeded per workspace; read-only in the UI. Workspace roles decide who runs the workspace;
 * project roles decide what someone does on one project (brand).
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
    description: "Runs agents, strategy, the calendar and publishing",
    permissions: [...READ, "agents.run", "context.edit", "context.confirm", "content.create", "content.download", "publish.execute", "integrations.manage", "inbox.read", "tasks.read", "tasks.manage"],
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
  {
    slug: "commercial-owner",
    name: "Commercial owner",
    scope: "PROJECT",
    description: "Sets product priorities, campaigns and offers",
    permissions: [...READ, "commercial.manage", "tasks.read", "tasks.manage"],
  },
  { slug: "viewer", name: "Viewer", scope: "PROJECT", description: "Read-only access to this project", permissions: [...READ, "tasks.read"] },
];

/** Legacy WorkspaceRole enum → system role slug (fallback while roleId is null). */
export const LEGACY_ROLE_SLUG = {
  OWNER: "owner",
  ADMIN: "admin",
  EDITOR: "member",
  REVIEWER: "member",
  VIEWER: "member",
} as const;
