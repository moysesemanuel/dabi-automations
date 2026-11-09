-- CreateEnum
CREATE TYPE "DeletionKind" AS ENUM ('ACCOUNT_DISCONNECT', 'ACCOUNT_DELETE', 'ORG_DELETE', 'USER_DELETE', 'SUBJECT_ERASE', 'META_CALLBACK');

-- CreateEnum
CREATE TYPE "DeletionStatus" AS ENUM ('REQUESTED', 'IN_PROGRESS', 'COMPLETED', 'PARTIAL', 'FAILED', 'REJECTED', 'NEEDS_REVIEW', 'CANCELED');

-- CreateTable
CREATE TABLE "IdempotencyTombstone" (
    "id" TEXT NOT NULL,
    "commentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IdempotencyTombstone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeletionRequest" (
    "id" TEXT NOT NULL,
    "kind" "DeletionKind" NOT NULL,
    "status" "DeletionStatus" NOT NULL DEFAULT 'REQUESTED',
    "confirmationCode" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "organizationId" TEXT,
    "requestedById" TEXT,
    "subjectHmac" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "scheduledFor" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "summary" JSONB,
    "error" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeletionRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyTombstone_commentId_key" ON "IdempotencyTombstone"("commentId");

-- CreateIndex
CREATE INDEX "IdempotencyTombstone_expiresAt_idx" ON "IdempotencyTombstone"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "DeletionRequest_confirmationCode_key" ON "DeletionRequest"("confirmationCode");

-- CreateIndex
CREATE UNIQUE INDEX "DeletionRequest_idempotencyKey_key" ON "DeletionRequest"("idempotencyKey");

-- CreateIndex
CREATE INDEX "DeletionRequest_status_requestedAt_idx" ON "DeletionRequest"("status", "requestedAt");

-- CreateIndex
CREATE INDEX "DeletionRequest_organizationId_idx" ON "DeletionRequest"("organizationId");
