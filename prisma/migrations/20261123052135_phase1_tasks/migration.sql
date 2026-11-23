-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('TODO', 'IN_PROGRESS', 'IN_REVIEW', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TaskPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "TaskArea" AS ENUM ('CONTENT', 'WEBSITE', 'SEO', 'GENERAL');

-- CreateEnum
CREATE TYPE "WebsiteChangeKind" AS ENUM ('PRODUCT_PAGE', 'COLLECTION', 'MENU', 'HOMEPAGE', 'LANDING_PAGE', 'BUG', 'CORRECTION', 'OTHER');

-- CreateEnum
CREATE TYPE "WorkProjectStatus" AS ENUM ('ACTIVE', 'DONE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "TaskCommentKind" AS ENUM ('COMMENT', 'APPROVED', 'CHANGES_REQUESTED', 'SYSTEM');

-- CreateEnum
CREATE TYPE "NotificationKind" AS ENUM ('TASK_ASSIGNED', 'REVIEW_REQUESTED', 'TASK_OVERDUE', 'TASK_RECHECK');

-- CreateEnum
CREATE TYPE "TaskAttachmentRole" AS ENUM ('BEFORE', 'AFTER', 'OTHER');

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "TaskStatus" NOT NULL DEFAULT 'TODO',
    "priority" "TaskPriority" NOT NULL DEFAULT 'NORMAL',
    "areas" "TaskArea"[] DEFAULT ARRAY['GENERAL']::"TaskArea"[],
    "ownerId" TEXT,
    "reviewerId" TEXT,
    "createdById" TEXT,
    "dueOn" DATE,
    "blockedReason" TEXT,
    "blockedOnId" TEXT,
    "workProjectId" TEXT,
    "contentItemId" TEXT,
    "url" TEXT,
    "changeKind" "WebsiteChangeKind",
    "acceptanceCriteria" TEXT,
    "previewUrl" TEXT,
    "checkedLiveAt" TIMESTAMP(3),
    "checkedLiveById" TEXT,
    "auditReportId" TEXT,
    "findingKind" "AuditKind",
    "findingId" TEXT,
    "findingUrls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "findingClearedAt" TIMESTAMP(3),
    "recheckOn" DATE,
    "completedAt" TIMESTAMP(3),
    "requestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskChecklistItem" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "doneAt" TIMESTAMP(3),
    "doneById" TEXT,
    "position" INTEGER NOT NULL,

    CONSTRAINT "TaskChecklistItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskAttachment" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "mediaUploadId" TEXT NOT NULL,
    "role" "TaskAttachmentRole" NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkProject" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "ownerId" TEXT,
    "status" "WorkProjectStatus" NOT NULL DEFAULT 'ACTIVE',
    "startsOn" DATE,
    "dueOn" DATE,
    "campaignId" TEXT,
    "clientVisible" BOOLEAN NOT NULL DEFAULT false,
    "requestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkProject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkProjectMilestone" (
    "id" TEXT NOT NULL,
    "workProjectId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "dueOn" DATE NOT NULL,
    "doneAt" TIMESTAMP(3),
    "position" INTEGER NOT NULL,

    CONSTRAINT "WorkProjectMilestone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskComment" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "authorId" TEXT,
    "kind" "TaskCommentKind" NOT NULL,
    "body" TEXT NOT NULL,
    "byClient" BOOLEAN NOT NULL DEFAULT false,
    "internal" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskComment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "kind" "NotificationKind" NOT NULL,
    "taskId" TEXT,
    "actorId" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Task_workProjectId_status_idx" ON "Task"("workProjectId", "status");

-- CreateIndex
CREATE INDEX "Task_contentItemId_idx" ON "Task"("contentItemId");

-- CreateIndex
CREATE UNIQUE INDEX "Task_brandId_requestId_key" ON "Task"("brandId", "requestId");

-- CreateIndex
CREATE INDEX "TaskChecklistItem_taskId_position_idx" ON "TaskChecklistItem"("taskId", "position");

-- CreateIndex
CREATE INDEX "TaskAttachment_taskId_idx" ON "TaskAttachment"("taskId");

-- CreateIndex
CREATE INDEX "TaskAttachment_mediaUploadId_idx" ON "TaskAttachment"("mediaUploadId");

-- CreateIndex
CREATE INDEX "WorkProject_brandId_status_dueOn_idx" ON "WorkProject"("brandId", "status", "dueOn");

-- CreateIndex
CREATE UNIQUE INDEX "WorkProject_brandId_campaignId_key" ON "WorkProject"("brandId", "campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkProject_brandId_requestId_key" ON "WorkProject"("brandId", "requestId");

-- CreateIndex
CREATE INDEX "WorkProjectMilestone_workProjectId_dueOn_idx" ON "WorkProjectMilestone"("workProjectId", "dueOn");

-- CreateIndex
CREATE INDEX "TaskComment_taskId_createdAt_idx" ON "TaskComment"("taskId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_dedupeKey_key" ON "Notification"("dedupeKey");

-- CreateIndex
CREATE INDEX "Notification_userId_workspaceId_readAt_createdAt_idx" ON "Notification"("userId", "workspaceId", "readAt", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_createdAt_idx" ON "Notification"("createdAt");

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_brandId_workspaceId_fkey" FOREIGN KEY ("brandId", "workspaceId") REFERENCES "Brand"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_blockedOnId_fkey" FOREIGN KEY ("blockedOnId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_workProjectId_fkey" FOREIGN KEY ("workProjectId") REFERENCES "WorkProject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_contentItemId_fkey" FOREIGN KEY ("contentItemId") REFERENCES "ContentItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_auditReportId_fkey" FOREIGN KEY ("auditReportId") REFERENCES "AuditReport"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskChecklistItem" ADD CONSTRAINT "TaskChecklistItem_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskAttachment" ADD CONSTRAINT "TaskAttachment_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskAttachment" ADD CONSTRAINT "TaskAttachment_mediaUploadId_fkey" FOREIGN KEY ("mediaUploadId") REFERENCES "MediaUpload"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkProject" ADD CONSTRAINT "WorkProject_brandId_workspaceId_fkey" FOREIGN KEY ("brandId", "workspaceId") REFERENCES "Brand"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkProject" ADD CONSTRAINT "WorkProject_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkProject" ADD CONSTRAINT "WorkProject_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkProjectMilestone" ADD CONSTRAINT "WorkProjectMilestone_workProjectId_fkey" FOREIGN KEY ("workProjectId") REFERENCES "WorkProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskComment" ADD CONSTRAINT "TaskComment_brandId_workspaceId_fkey" FOREIGN KEY ("brandId", "workspaceId") REFERENCES "Brand"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskComment" ADD CONSTRAINT "TaskComment_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_brandId_workspaceId_fkey" FOREIGN KEY ("brandId", "workspaceId") REFERENCES "Brand"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Raw SQL Prisma can't express. Open = status IN ('TODO','IN_PROGRESS','IN_REVIEW'); queries must repeat that literal
-- predicate (and COALESCE("dueOn",'infinity'::date) for due order) for the planner to use these indexes.
-- ponytail: plain CREATE INDEX (blocks writes while it builds); fine on new tables and today's ContentItem / Product /
-- Campaign sizes. Past ~1M rows, add such an index with CREATE INDEX CONCURRENTLY in a migration of its own.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Open tasks: by owner, by reviewer, by due day, the blocked ones, and one open task per audit finding (race-safe).
CREATE INDEX "task_open_owner" ON "Task" ("brandId", "ownerId", COALESCE("dueOn", 'infinity'::date), "id")
WHERE status IN ('TODO','IN_PROGRESS','IN_REVIEW');

CREATE INDEX "task_open_reviewer" ON "Task" ("brandId", "reviewerId", COALESCE("dueOn", 'infinity'::date), "id")
WHERE status IN ('TODO','IN_PROGRESS','IN_REVIEW');

CREATE INDEX "task_open_due" ON "Task" ("brandId", COALESCE("dueOn", 'infinity'::date), "id")
WHERE status IN ('TODO','IN_PROGRESS','IN_REVIEW');

CREATE INDEX "task_open_blocked" ON "Task" ("brandId")
WHERE status IN ('TODO','IN_PROGRESS','IN_REVIEW') AND "blockedReason" IS NOT NULL;

CREATE UNIQUE INDEX "task_open_finding" ON "Task" ("brandId", "findingKind", "findingId")
WHERE status IN ('TODO','IN_PROGRESS','IN_REVIEW') AND "findingId" IS NOT NULL;

-- The Done view, newest first, and the SEO re-check sweep.
CREATE INDEX "task_done" ON "Task" ("brandId", "completedAt" DESC, "id") WHERE status = 'DONE';

CREATE INDEX "task_recheck" ON "Task" ("recheckOn") WHERE "recheckOn" IS NOT NULL AND status = 'DONE';

-- Search.
CREATE INDEX "Task_title_trgm_idx" ON "Task" USING gin ("title" gin_trgm_ops);
CREATE INDEX "WorkProject_name_trgm_idx" ON "WorkProject" USING gin ("name" gin_trgm_ops);
CREATE INDEX "ContentItem_title_trgm_idx" ON "ContentItem" USING gin ("title" gin_trgm_ops);
CREATE INDEX "Product_title_trgm_idx" ON "Product" USING gin ("title" gin_trgm_ops);
CREATE INDEX "Campaign_name_trgm_idx" ON "Campaign" USING gin ("name" gin_trgm_ops);

-- Task permissions for existing roles (snapshot of SYSTEM_ROLES in permissions.catalog.ts). Owner rows only track the
-- catalog when ensureSystemRoles runs, so they get the keys here like the others. Every append is guarded, so a role
-- that already holds a key is left alone.
UPDATE "Role" SET "permissions" = array_append("permissions", 'tasks.read'), "updatedAt" = now()
WHERE "isSystem" AND "slug" IN ('owner', 'admin', 'project-admin', 'manager', 'creator', 'commercial-owner', 'approver', 'viewer', 'client-reviewer')
  AND NOT ("permissions" @> ARRAY['tasks.read']);

UPDATE "Role" SET "permissions" = array_append("permissions", 'tasks.manage'), "updatedAt" = now()
WHERE "isSystem" AND "slug" IN ('owner', 'admin', 'project-admin', 'manager', 'creator', 'commercial-owner')
  AND NOT ("permissions" @> ARRAY['tasks.manage']);

-- Custom project roles that make posts see tasks (and comment); managing tasks stays an explicit choice.
UPDATE "Role" SET "permissions" = array_append("permissions", 'tasks.read'), "updatedAt" = now()
WHERE NOT "isSystem" AND "scope" = 'PROJECT' AND 'content.create' = ANY("permissions")
  AND NOT ("permissions" @> ARRAY['tasks.read']);
