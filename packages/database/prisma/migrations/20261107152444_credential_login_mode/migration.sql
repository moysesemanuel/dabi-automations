-- CreateEnum
CREATE TYPE "LoginMode" AS ENUM ('INSTAGRAM', 'FACEBOOK');

-- AlterTable
ALTER TABLE "SocialCredential" ADD COLUMN     "loginMode" "LoginMode" NOT NULL DEFAULT 'INSTAGRAM';
