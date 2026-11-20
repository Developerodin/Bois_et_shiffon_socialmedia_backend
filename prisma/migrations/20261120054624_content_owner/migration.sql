-- AlterTable
ALTER TABLE "ContentItem" ADD COLUMN     "ownerId" TEXT;

-- CreateIndex
CREATE INDEX "ContentItem_brandId_ownerId_idx" ON "ContentItem"("brandId", "ownerId");

-- AddForeignKey
ALTER TABLE "ContentItem" ADD CONSTRAINT "ContentItem_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: the owner of an existing post is the person who made it, when they still belong to its workspace.
UPDATE "ContentItem" c SET "ownerId" = a."actorUserId"
FROM (
  SELECT DISTINCT ON ("entityId") "entityId", "actorUserId"
  FROM "AuditEvent"
  WHERE "entityType" = 'ContentItem' AND action = 'content.create' AND "actorUserId" IS NOT NULL
  ORDER BY "entityId", "createdAt"
) a
WHERE c.id = a."entityId"
  AND EXISTS (SELECT 1 FROM "WorkspaceMember" m JOIN "User" u ON u.id = m."userId" WHERE m."workspaceId" = c."workspaceId" AND m."userId" = a."actorUserId" AND u."deletedAt" IS NULL);
