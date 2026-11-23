-- CreateTable
CREATE TABLE "PostMetric" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "publicationAttemptId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "readAt" TIMESTAMP(3) NOT NULL,
    "reach" INTEGER,
    "views" INTEGER,
    "likes" INTEGER,
    "comments" INTEGER,
    "shares" INTEGER,
    "saves" INTEGER,
    "interactions" INTEGER,

    CONSTRAINT "PostMetric_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PostMetric_brandId_idx" ON "PostMetric"("brandId");

-- CreateIndex
CREATE UNIQUE INDEX "PostMetric_publicationAttemptId_day_key" ON "PostMetric"("publicationAttemptId", "day");

-- CreateIndex
CREATE INDEX "PublicationAttempt_brandId_status_publishedAt_idx" ON "PublicationAttempt"("brandId", "status", "publishedAt");

-- AddForeignKey
ALTER TABLE "PostMetric" ADD CONSTRAINT "PostMetric_publicationAttemptId_fkey" FOREIGN KEY ("publicationAttemptId") REFERENCES "PublicationAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostMetric" ADD CONSTRAINT "PostMetric_brandId_workspaceId_fkey" FOREIGN KEY ("brandId", "workspaceId") REFERENCES "Brand"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

