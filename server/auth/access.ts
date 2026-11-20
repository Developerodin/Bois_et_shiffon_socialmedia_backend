import "server-only";
import { BrandStatus } from "@prisma/client";
import { prisma } from "@/server/db/prisma";
import { AccessDeniedError, BrandArchivedError } from "@/server/auth/errors";
import { brandGrant, isClientGrant, memberRole, permissionsOf } from "@/server/auth/permissions";

export type BrandAccessOptions = {
  /** Allow read-style access when brand is archived (AT-024 history). */
  allowArchived?: boolean;
};

/**
 * Fail closed if the user is not a workspace member (AT-001 / AT-017).
 */
export async function requireWorkspaceMember(
  workspaceId: string,
  userId: string,
) {
  const member = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
  });

  if (!member) {
    throw new AccessDeniedError("Not a workspace member");
  }

  return member;
}

/**
 * Workspace member + brand in workspace + brand.read on it: from the workspace role
 * (Owner/Admin reach every project) or from a project grant (BrandMember).
 */
export async function requireBrandAccess(
  workspaceId: string,
  brandId: string,
  userId: string,
  options?: BrandAccessOptions,
) {
  return (await brandAccess(workspaceId, brandId, userId, options)).brand;
}

/**
 * requireBrandAccess plus the caller's permissions on the brand, worked out once: the role read proves membership,
 * so a brand route costs the member, the brand and the project grant (3–4 reads) instead of 7–9.
 */
export async function brandAccess(
  workspaceId: string,
  brandId: string,
  userId: string,
  options?: BrandAccessOptions,
) {
  // The three reads need only the ids, so they go together: one round trip's wait instead of three on every brand
  // route. The checks below still run in the old order, so a non-member hears "not a member" whatever the brand.
  const [found, brand, grant] = await Promise.all([
    memberRole(workspaceId, userId),
    prisma.brand.findFirst({ where: { id: brandId, workspaceId } }),
    brandGrant(workspaceId, brandId, userId),
  ]);
  if (!found) {
    throw new AccessDeniedError("Not a workspace member");
  }

  if (!brand) {
    throw new AccessDeniedError("Brand not found in workspace");
  }

  if (brand.status === BrandStatus.ARCHIVED && !options?.allowArchived) {
    throw new BrandArchivedError();
  }

  const perms = await permissionsOf(found, workspaceId, userId, brandId, grant);
  if (!perms.has("brand.read")) {
    throw new AccessDeniedError("You don't have access to this project");
  }

  // Same test as isClientReviewer, from the reads above: approves only as the client, not through a workspace role.
  const clientReviewer = !!grant && isClientGrant(grant.role) && !found.role?.permissions.includes("content.approve");
  return { brand, perms, clientReviewer };
}
