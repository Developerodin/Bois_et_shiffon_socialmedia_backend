-- CreateTable
CREATE TABLE "FxRate" (
    "currency" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "perEur" DECIMAL(18,6) NOT NULL,

    CONSTRAINT "FxRate_pkey" PRIMARY KEY ("currency","day")
);
