-- Tell whoever sent a task for review what the reviewer decided.
ALTER TYPE "NotificationKind" ADD VALUE 'TASK_APPROVED';
ALTER TYPE "NotificationKind" ADD VALUE 'TASK_CHANGES_REQUESTED';

-- The bell's read history pages newest first per person; task and brand deletes cascade through these.
CREATE INDEX "Notification_userId_workspaceId_createdAt_id_idx" ON "Notification"("userId", "workspaceId", "createdAt" DESC, "id" DESC);
CREATE INDEX "Notification_taskId_idx" ON "Notification"("taskId");
CREATE INDEX "Notification_brandId_workspaceId_idx" ON "Notification"("brandId", "workspaceId");

-- A user delete sets these to NULL; without plain indexes each one scans Task.
CREATE INDEX "Task_ownerId_idx" ON "Task"("ownerId");
CREATE INDEX "Task_reviewerId_idx" ON "Task"("reviewerId");
CREATE INDEX "Task_blockedOnId_idx" ON "Task"("blockedOnId");
CREATE INDEX "Task_createdById_idx" ON "Task"("createdById");
