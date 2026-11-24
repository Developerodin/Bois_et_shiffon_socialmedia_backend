-- The weekly digest (server/digest/build.ts): one row per reader, workspace and week; email is opt-in per person.
ALTER TABLE "User" ADD COLUMN "digestEmail" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "Digest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "weekStart" DATE NOT NULL,
    "body" JSONB NOT NULL,
    "emailedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Digest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Digest_workspaceId_weekStart_idx" ON "Digest"("workspaceId", "weekStart");
CREATE INDEX "Digest_createdAt_idx" ON "Digest"("createdAt");
CREATE UNIQUE INDEX "Digest_userId_workspaceId_weekStart_key" ON "Digest"("userId", "workspaceId", "weekStart");

ALTER TABLE "Digest" ADD CONSTRAINT "Digest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Digest" ADD CONSTRAINT "Digest_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
