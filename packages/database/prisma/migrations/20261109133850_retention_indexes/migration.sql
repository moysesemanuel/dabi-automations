-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "AutomationEvent_receivedAt_idx" ON "AutomationEvent"("receivedAt");

-- CreateIndex
CREATE INDEX "Invitation_expiresAt_idx" ON "Invitation"("expiresAt");

-- CreateIndex
CREATE INDEX "MessageDelivery_status_updatedAt_idx" ON "MessageDelivery"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "PublicReply_status_updatedAt_idx" ON "PublicReply"("status", "updatedAt");
