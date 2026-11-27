-- Documents on a task (server/tasks/files.ts): their own table, apart from MediaUpload, so a document never reaches the
-- story picker or the photo library.
CREATE TABLE "TaskFile" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "contentType" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskFile_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TaskFile_key_key" ON "TaskFile"("key");
CREATE INDEX "TaskFile_taskId_status_idx" ON "TaskFile"("taskId", "status");
CREATE INDEX "TaskFile_status_createdAt_idx" ON "TaskFile"("status", "createdAt");

ALTER TABLE "TaskFile" ADD CONSTRAINT "TaskFile_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;
