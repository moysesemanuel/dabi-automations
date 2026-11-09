-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "deletionCanceledAt" TIMESTAMP(3),
ADD COLUMN     "deletionRequestedAt" TIMESTAMP(3),
ADD COLUMN     "deletionRequestedById" TEXT,
ADD COLUMN     "deletionScheduledFor" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "SocialAccount" ADD COLUMN     "disconnectedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "SocialCredential" ADD COLUMN     "metaUserId" TEXT;

-- CreateIndex
CREATE INDEX "SocialCredential_metaUserId_idx" ON "SocialCredential"("metaUserId");
