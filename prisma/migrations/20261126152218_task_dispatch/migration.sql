-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "notifiedAt" TIMESTAMP(3),
ADD COLUMN     "telegramMessageId" TEXT;

-- CreateIndex
CREATE INDEX "Task_leaderId_assigneeId_idx" ON "Task"("leaderId", "assigneeId");
