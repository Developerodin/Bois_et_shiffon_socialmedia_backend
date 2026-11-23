-- tasksFromReport reads every earlier task of a report's findings, newest first.
CREATE INDEX "Task_brandId_findingKind_findingId_createdAt_idx" ON "Task"("brandId", "findingKind", "findingId", "createdAt");
