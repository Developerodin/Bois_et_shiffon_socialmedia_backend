import type { Prisma } from "@prisma/client";
import { AccessDeniedError } from "@/server/auth/errors";
import {
  CLIENT_REVIEWER,
  LEGACY_ROLE_SLUG,
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
type Db = Prisma.TransactionClient | typeof prisma;

export async function ensureSystemRoles(workspaceId: string, db: Db = prisma) {
  for (const r of SYSTEM_ROLES) {
    await db.role.upsert({
      where: { workspaceId_slug: { workspaceId, slug: r.slug } },
      // Owners may have edited a built-in role's permissions: keep them (Owner always tracks the catalog).
      update: { name: r.name, description: r.description, scope: r.scope, isSystem: true, ...(r.slug === "owner" ? { permissions: r.permissions } : {}) },
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
  const perms = new Set(found.role.permissions as PermissionKey[]);
  if (!brandId) return perms;

  const grant = preread === undefined ? await brandGrant(workspaceId, brandId, userId) : preread;
  for (const p of grant?.role.permissions ?? []) perms.add(p as PermissionKey);
  return perms;
}

/** The user's project grant on a brand (BrandMember + its role), or null. */
export function brandGrant(workspaceId: string, brandId: string, userId: string) {
  return prisma.brandMember.findFirst({ where: { brandId, workspaceId, userId }, include: { role: true } });
}

/** A project grant through the built-in Client reviewer role (a custom role that happens to use the slug isn't one). */
export const isClientGrant = (role: { isSystem: boolean; slug: string }) => role.isSystem && role.slug === CLIENT_REVIEWER;

/**
 * Can someone other than `userId` approve this brand's content? A one-person business can't follow a four-eyes rule.
 * A client reviewer's approval doesn't count here: staff can still approve their own post when only the client could.
 * Three queries, computed in memory. ponytail: reads every member of the workspace; a joined query if workspaces get large.
 */
export async function hasOtherApprover(workspaceId: string, brandId: string, userId: string) {
  const [members, legacy, grants] = await Promise.all([
    prisma.workspaceMember.findMany({ where: { workspaceId, userId: { not: userId } }, select: { userId: true, role: true, roleRef: { select: { permissions: true } } } }),
    prisma.role.findMany({ where: { workspaceId, slug: { in: Object.values(LEGACY_ROLE_SLUG) } }, select: { slug: true, permissions: true } }),
    prisma.brandMember.findMany({ where: { workspaceId, brandId, userId: { not: userId } }, select: { userId: true, role: { select: { isSystem: true, slug: true, permissions: true } } } }),
  ]);
  const legacyPerms = new Map(legacy.map((r) => [r.slug, r.permissions]));
  const roleOf = (m: (typeof members)[number]) => m.roleRef?.permissions ?? legacyPerms.get(LEGACY_ROLE_SLUG[m.role]);
  if (members.some((m) => roleOf(m)?.includes("content.approve"))) return true;
  // As in effectivePermissions: a grant counts only for someone with a workspace role.
  const withRole = new Set(members.filter((m) => roleOf(m)).map((m) => m.userId));
  return grants.some((g) => withRole.has(g.userId) && !isClientGrant(g.role) && g.role.permissions.includes("content.approve"));
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
