-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "seoAlertId" TEXT;

-- CreateIndex
CREATE INDEX "Notification_seoAlertId_idx" ON "Notification"("seoAlertId");

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_seoAlertId_fkey" FOREIGN KEY ("seoAlertId") REFERENCES "SeoAlert"("id") ON DELETE CASCADE ON UPDATE CASCADE;
