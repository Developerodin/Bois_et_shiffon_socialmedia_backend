-- Conversations on any channel and their messages (plan 2026-11-27-crm, Task A5).
-- Quote.conversationId had no writer before this: anything in it is cleared so the new FK holds.
UPDATE "Quote" SET "conversationId" = NULL WHERE "conversationId" IS NOT NULL;

-- CreateEnum
CREATE TYPE "ConversationChannel" AS ENUM ('LOGGED', 'INSTAGRAM', 'MESSENGER');

-- CreateEnum
CREATE TYPE "MessageMedium" AS ENUM ('EMAIL', 'PHONE', 'IN_PERSON', 'WHATSAPP', 'OTHER');

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "channel" "ConversationChannel" NOT NULL,
    "connectionId" TEXT,
    "externalThreadId" TEXT,
    "customerExternalId" TEXT,
    "customerId" TEXT,
    "subject" TEXT,
    "ownerId" TEXT,
    "nextAction" TEXT,
    "nextActionDue" DATE,
    "lastMessageAt" TIMESTAMP(3) NOT NULL,
    "lastFromCustomer" BOOLEAN NOT NULL,
    "waitingSince" TIMESTAMP(3),
    "episodeAt" TIMESTAMP(3),
    "followUpTaskId" TEXT,
    "closedAt" TIMESTAMP(3),
    "summary" TEXT,
    "summaryThrough" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversationMessage" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "externalId" TEXT,
    "medium" "MessageMedium",
    "fromCustomer" BOOLEAN NOT NULL,
    "text" TEXT NOT NULL,
    "attachments" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "loggedById" TEXT,
    "deletedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversationMessage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Conversation_brandId_closedAt_lastMessageAt_id_idx" ON "Conversation"("brandId", "closedAt", "lastMessageAt" DESC, "id");

CREATE INDEX "Conversation_brandId_ownerId_idx" ON "Conversation"("brandId", "ownerId");

CREATE INDEX "Conversation_brandId_nextActionDue_idx" ON "Conversation"("brandId", "nextActionDue");

CREATE INDEX "Conversation_customerId_lastMessageAt_idx" ON "Conversation"("customerId", "lastMessageAt");

CREATE INDEX "Conversation_closedAt_waitingSince_idx" ON "Conversation"("closedAt", "waitingSince");

CREATE UNIQUE INDEX "Conversation_connectionId_externalThreadId_key" ON "Conversation"("connectionId", "externalThreadId");

CREATE INDEX "ConversationMessage_conversationId_sentAt_idx" ON "ConversationMessage"("conversationId", "sentAt");

CREATE INDEX "ConversationMessage_sentAt_idx" ON "ConversationMessage"("sentAt");

CREATE UNIQUE INDEX "ConversationMessage_conversationId_externalId_key" ON "ConversationMessage"("conversationId", "externalId");

CREATE INDEX "Quote_conversationId_idx" ON "Quote"("conversationId");

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_brandId_workspaceId_fkey" FOREIGN KEY ("brandId", "workspaceId") REFERENCES "Brand"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationMessage" ADD CONSTRAINT "ConversationMessage_brandId_workspaceId_fkey" FOREIGN KEY ("brandId", "workspaceId") REFERENCES "Brand"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationMessage" ADD CONSTRAINT "ConversationMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

