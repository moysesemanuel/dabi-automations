-- CreateEnum
CREATE TYPE "WebhookSubscription" AS ENUM ('UNKNOWN', 'SUBSCRIBED', 'FAILED');

-- AlterTable
ALTER TABLE "SocialAccount" ADD COLUMN     "webhookError" TEXT,
ADD COLUMN     "webhookStatus" "WebhookSubscription" NOT NULL DEFAULT 'UNKNOWN',
ADD COLUMN     "webhookSubscribedAt" TIMESTAMP(3);
