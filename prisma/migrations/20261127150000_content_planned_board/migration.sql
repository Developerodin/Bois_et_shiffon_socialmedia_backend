-- A Pinterest Pin's planned board (chosen ahead of scheduling); its name is kept so cards never call Pinterest.

-- AlterTable
ALTER TABLE "ContentItem" ADD COLUMN     "plannedBoardId" TEXT,
ADD COLUMN     "plannedBoardName" TEXT;
