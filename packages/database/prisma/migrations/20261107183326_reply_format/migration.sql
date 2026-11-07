-- CreateEnum
CREATE TYPE "ReplyFormat" AS ENUM ('TEXT', 'BUTTON');

-- AlterTable
ALTER TABLE "Automation" ADD COLUMN     "buttonTitle" TEXT,
ADD COLUMN     "replyFormat" "ReplyFormat" NOT NULL DEFAULT 'TEXT';
