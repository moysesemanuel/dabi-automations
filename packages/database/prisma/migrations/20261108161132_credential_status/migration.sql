-- CreateEnum
CREATE TYPE "CredentialStatus" AS ENUM ('ACTIVE', 'NEEDS_RECONNECT');

-- AlterTable
ALTER TABLE "SocialCredential" ADD COLUMN     "status" "CredentialStatus" NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN     "statusChangedAt" TIMESTAMP(3),
ADD COLUMN     "statusReason" TEXT;
