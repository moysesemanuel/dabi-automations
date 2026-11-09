-- CreateEnum
CREATE TYPE "RetentionMode" AS ENUM ('DRY_RUN', 'EXECUTE');

-- CreateEnum
CREATE TYPE "RetentionRunStatus" AS ENUM ('RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED', 'ABORTED');

-- CreateTable
CREATE TABLE "RetentionRun" (
    "id" TEXT NOT NULL,
    "mode" "RetentionMode" NOT NULL,
    "status" "RetentionRunStatus" NOT NULL DEFAULT 'RUNNING',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "leaseEpoch" INTEGER,
    "limits" JSONB,
    "counts" JSONB,
    "error" TEXT,

    CONSTRAINT "RetentionRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RetentionLease" (
    "id" TEXT NOT NULL,
    "owner" TEXT,
    "epoch" INTEGER NOT NULL DEFAULT 0,
    "leaseUntil" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RetentionLease_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RetentionRun_startedAt_idx" ON "RetentionRun"("startedAt");

-- CreateIndex
CREATE INDEX "RetentionRun_status_startedAt_idx" ON "RetentionRun"("status", "startedAt");
