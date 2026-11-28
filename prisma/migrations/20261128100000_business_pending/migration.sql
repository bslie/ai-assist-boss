-- CreateTable
CREATE TABLE "BusinessPending" (
    "id" TEXT NOT NULL,
    "leaderId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "fromUserId" TEXT NOT NULL,
    "fromName" TEXT,
    "text" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BusinessPending_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BusinessPending_connectionId_chatId_messageId_key" ON "BusinessPending"("connectionId", "chatId", "messageId");

-- CreateIndex
CREATE INDEX "BusinessPending_status_dueAt_idx" ON "BusinessPending"("status", "dueAt");

-- CreateIndex
CREATE INDEX "BusinessPending_connectionId_chatId_status_idx" ON "BusinessPending"("connectionId", "chatId", "status");

-- AddForeignKey
ALTER TABLE "BusinessPending" ADD CONSTRAINT "BusinessPending_leaderId_fkey" FOREIGN KEY ("leaderId") REFERENCES "Leader"("id") ON DELETE CASCADE ON UPDATE CASCADE;
