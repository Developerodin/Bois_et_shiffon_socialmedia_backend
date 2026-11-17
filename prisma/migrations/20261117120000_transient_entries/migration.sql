-- CreateTable
CREATE TABLE "TransientEntry" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TransientEntry_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "TransientEntry_expiresAt_idx" ON "TransientEntry"("expiresAt");
