-- CreateEnum
CREATE TYPE "OnboardingAnswer" AS ENUM ('YES', 'NO', 'UNSURE');

-- CreateEnum
CREATE TYPE "OnboardingStep" AS ENUM ('PREPARE', 'CONNECT', 'RESULT');

-- CreateTable
CREATE TABLE "ConnectionOnboarding" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "step" "OnboardingStep" NOT NULL DEFAULT 'PREPARE',
    "professionalAccount" "OnboardingAnswer",
    "businessPortfolio" "OnboardingAnswer",
    "instagramInPortfolio" "OnboardingAnswer",
    "lastOutcome" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConnectionOnboarding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ConnectionOnboarding_organizationId_key" ON "ConnectionOnboarding"("organizationId");

-- AddForeignKey
ALTER TABLE "ConnectionOnboarding" ADD CONSTRAINT "ConnectionOnboarding_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
