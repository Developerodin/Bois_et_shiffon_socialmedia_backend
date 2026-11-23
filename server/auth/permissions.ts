import type { Prisma } from "@prisma/client";
import { AccessDeniedError } from "@/server/auth/errors";
import {
  CLIENT_REVIEWER,
  LEGACY_ROLE_SLUG,
  rolePermissions,
  SYSTEM_ROLES,
  type PermissionKey,
} from "@/server/auth/permissions.catalog";
import { prisma } from "@/server/db/prisma";

/**
 * Authorization engine: effective permissions on a project (brand) = workspace role ∪ that
 * project's role. Owner/Admin carry every project permission in their workspace role, so they
 * reach every project; a Member reaches only projects with a BrandMember grant.
 * ponytail: computed per request (2 small indexed queries); cache by role
 * updatedAt if it shows up in traces.
 */
export type Db = Prisma.TransactionClient | typeof prisma;

export async function ensureSystemRoles(workspaceId: string, db: Db = prisma) {
  for (const r of SYSTEM_ROLES) {
    await db.role.upsert({
      where: { workspaceId_slug: { workspaceId, slug: r.slug } },
      // Owners may have edited a built-in role's permissions: keep them (Owner and Admin read theirs from code anyway).
      update: { name: r.name, description: r.description, scope: r.scope, isSystem: true },
      create: { workspaceId, slug: r.slug, name: r.name, description: r.description, scope: r.scope, permissions: r.permissions, isSystem: true },
    });
  }
}

/** The member's workspace role (DB role, or legacy enum mapped to a system role). */
export async function memberRole(workspaceId: string, userId: string) {
  const member = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    include: { roleRef: true },
  });
  if (!member) return null;
  if (member.roleRef) return { member, role: member.roleRef };
  const role = await prisma.role.findUnique({
    where: { workspaceId_slug: { workspaceId, slug: LEGACY_ROLE_SLUG[member.role] } },
  });
  return { member, role };
}

export async function effectivePermissions(
  workspaceId: string,
  userId: string,
  brandId?: string,
): Promise<Set<PermissionKey>> {
  return permissionsOf(await memberRole(workspaceId, userId), workspaceId, userId, brandId);
}

/** effectivePermissions from a memberRole already read (one query less for a caller that needed the member anyway). */
export async function permissionsOf(
  found: Awaited<ReturnType<typeof memberRole>>,
  workspaceId: string,
  userId: string,
  brandId?: string,
  /** brandGrant already read (in parallel with the member, by brandAccess); undefined reads it here. */
  preread?: Awaited<ReturnType<typeof brandGrant>>,
): Promise<Set<PermissionKey>> {
  if (!found?.role) return new Set();
  const perms = new Set(rolePermissions(found.role) as PermissionKey[]);
  if (!brandId) return perms;

  const grant = preread === undefined ? await brandGrant(workspaceId, brandId, userId) : preread;
  for (const p of grant ? rolePermissions(grant.role) : []) perms.add(p as PermissionKey);
  return perms;
}

/** The user's project grant on a brand (BrandMember + its role), or null. */
export function brandGrant(workspaceId: string, brandId: string, userId: string) {
  return prisma.brandMember.findFirst({ where: { brandId, workspaceId, userId }, include: { role: true } });
}

/** A project grant through the built-in Client reviewer role (a custom role that happens to use the slug isn't one). */
export const isClientGrant = (role: { isSystem: boolean; slug: string }) => role.isSystem && role.slug === CLIENT_REVIEWER;
/** The same rule as a Prisma filter on Role (`NOT: CLIENT_GRANT_WHERE` leaves client grants out). It and isClientGrant must change together. */
export const CLIENT_GRANT_WHERE = { isSystem: true, slug: CLIENT_REVIEWER } as const;
/**
 * THE client rule: someone is a client on a brand when their grant there is a client grant and their workspace role
 * doesn't approve content (else they approve as staff). brandAccess, the task reads and the people lists all use it;
 * isClientOn (server/tasks/access.ts) and clientMemberSql are the same rule as a query.
 */
export const isClientMember = (clientGrant: boolean, workspacePerms: readonly string[]) => clientGrant && !workspacePerms.includes("content.approve");

/**
 * Does someone other than `userId` hold `key` on this brand? A client reviewer's grant doesn't count: clients are never
 * the "other" staff member. Three queries, computed in memory.
 * ponytail: reads every member of the workspace; a joined query if workspaces get large.
 */
export async function hasOtherHolder(workspaceId: string, brandId: string, userId: string, key: PermissionKey) {
  const [members, legacy, grants] = await Promise.all([
    prisma.workspaceMember.findMany({ where: { workspaceId, userId: { not: userId } }, select: { userId: true, role: true, roleRef: { select: { isSystem: true, slug: true, permissions: true } } } }),
    prisma.role.findMany({ where: { workspaceId, slug: { in: Object.values(LEGACY_ROLE_SLUG) } }, select: { isSystem: true, slug: true, permissions: true } }),
    prisma.brandMember.findMany({ where: { workspaceId, brandId, userId: { not: userId } }, select: { userId: true, role: { select: { isSystem: true, slug: true, permissions: true } } } }),
  ]);
  const legacyPerms = new Map(legacy.map((r) => [r.slug, rolePermissions(r)]));
  const roleOf = (m: (typeof members)[number]) => (m.roleRef ? rolePermissions(m.roleRef) : legacyPerms.get(LEGACY_ROLE_SLUG[m.role]));
  if (members.some((m) => roleOf(m)?.includes(key))) return true;
  // As in effectivePermissions: a grant counts only for someone with a workspace role.
  const withRole = new Set(members.filter((m) => roleOf(m)).map((m) => m.userId));
  return grants.some((g) => withRole.has(g.userId) && !isClientGrant(g.role) && rolePermissions(g.role).includes(key));
}

/**
 * Can someone other than `userId` approve this brand's content? A one-person business can't follow a four-eyes rule.
 * A client reviewer's approval doesn't count here: staff can still approve their own post when only the client could.
 */
export const hasOtherApprover = (workspaceId: string, brandId: string, userId: string) =>
  hasOtherHolder(workspaceId, brandId, userId, "content.approve");

/**
 * Does an active `userId` hold `key` on the brand as staff: through their workspace role or a project grant that is not
 * the client-reviewer role? Two indexed lookups (the same rule as brandOwners, for one person). Unlike
 * effectivePermissions it reads only DB roles (roleRef), not the legacy enum, as the owner pickers do.
 */
export async function brandMemberPerms(db: Db, scope: { workspaceId: string; brandId: string }, userId: string, key: PermissionKey) {
  const user = { status: "ACTIVE" as const, deletedAt: null };
  const [viaWorkspace, viaGrant] = await Promise.all([
    db.workspaceMember.findFirst({ where: { workspaceId: scope.workspaceId, userId, roleRef: { permissions: { has: key } }, user }, select: { id: true } }),
    db.brandMember.findFirst({ where: { workspaceId: scope.workspaceId, brandId: scope.brandId, userId, role: { permissions: { has: key }, NOT: CLIENT_GRANT_WHERE }, user }, select: { id: true } }),
  ]);
  return !!viaWorkspace || !!viaGrant;
}

export async function requirePermission(
  workspaceId: string,
  userId: string,
  permission: PermissionKey,
  brandId?: string,
) {
  const perms = await effectivePermissions(workspaceId, userId, brandId);
  if (!perms.has(permission)) {
    throw new AccessDeniedError(`Missing permission ${permission}`);
  }
}
