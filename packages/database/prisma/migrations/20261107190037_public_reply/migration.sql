-- AlterTable
ALTER TABLE "Automation" ADD COLUMN     "dmEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "publicReplyEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "publicReplyMessage" TEXT;

-- CreateTable
CREATE TABLE "PublicReply" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "automationId" TEXT NOT NULL,
    "commentId" TEXT NOT NULL,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "providerResponse" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PublicReply_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PublicReply_organizationId_status_idx" ON "PublicReply"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PublicReply_commentId_key" ON "PublicReply"("commentId");

-- AddForeignKey
ALTER TABLE "PublicReply" ADD CONSTRAINT "PublicReply_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublicReply" ADD CONSTRAINT "PublicReply_automationId_fkey" FOREIGN KEY ("automationId") REFERENCES "Automation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
