-- CreateTable
CREATE TABLE "BusinessConnection" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "leaderId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "userChatId" TEXT NOT NULL,
    "canReply" BOOLEAN NOT NULL DEFAULT false,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessConnection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BusinessConnection_connectionId_key" ON "BusinessConnection"("connectionId");

-- CreateIndex
CREATE INDEX "BusinessConnection_leaderId_idx" ON "BusinessConnection"("leaderId");

-- AddForeignKey
ALTER TABLE "BusinessConnection" ADD CONSTRAINT "BusinessConnection_leaderId_fkey" FOREIGN KEY ("leaderId") REFERENCES "Leader"("id") ON DELETE CASCADE ON UPDATE CASCADE;
