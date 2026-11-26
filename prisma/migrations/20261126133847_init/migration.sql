-- CreateEnum
CREATE TYPE "ToolPermission" AS ENUM ('AUTO', 'APPROVE', 'DENY');

-- CreateEnum
CREATE TYPE "EmailCategory" AS ENUM ('HR', 'MANAGEMENT', 'MONEY', 'CLIENT_COMMITMENT', 'INVITATION', 'REPORT', 'STATUS', 'SALES', 'ACCESS', 'CLIENT_SUPPORT', 'NEWSLETTER', 'CALENDAR');

-- CreateEnum
CREATE TYPE "EmailAction" AS ENUM ('ASK_LEADER', 'DIGEST', 'DELEGATE', 'IGNORE', 'AUTO');

-- CreateEnum
CREATE TYPE "DecisionStatus" AS ENUM ('PENDING', 'APPROVED', 'EDITED_APPROVED', 'DELEGATED', 'REJECTED', 'SNOOZED');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('NEW', 'ACCEPTED', 'IN_PROGRESS', 'REVIEW', 'RETURNED', 'READY_FOR_LEADER', 'DONE', 'ESCALATED');

-- CreateEnum
CREATE TYPE "ChatRole" AS ENUM ('LEADER', 'EMPLOYEE');

-- CreateTable
CREATE TABLE "Leader" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "budgetAutoLimit" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "quietHoursStart" TEXT NOT NULL DEFAULT '20:00',
    "quietHoursEnd" TEXT NOT NULL DEFAULT '08:00',
    "protectedBlocks" TEXT[] DEFAULT ARRAY['Стратегия', '1:1']::TEXT[],
    "quarterGoals" JSONB NOT NULL,
    "stylePrompt" TEXT NOT NULL,
    "savedMinutesConfig" JSONB NOT NULL,
    "profileMarkdown" TEXT NOT NULL,
    "profileVersion" INTEGER NOT NULL DEFAULT 1,
    "shadowMode" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Leader_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Employee" (
    "id" TEXT NOT NULL,
    "leaderId" TEXT NOT NULL,
    "externalId" TEXT,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "position" TEXT NOT NULL,
    "relationType" TEXT NOT NULL,
    "responsibilityArea" TEXT,
    "inviteToken" TEXT NOT NULL,

    CONSTRAINT "Employee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelegramBinding" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "role" "ChatRole" NOT NULL,
    "leaderId" TEXT NOT NULL,
    "employeeId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TelegramBinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Connector" (
    "id" TEXT NOT NULL,
    "leaderId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "mcpUrl" TEXT,
    "encryptedConfig" TEXT NOT NULL,
    "toolPermissions" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Connector_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Rule" (
    "id" TEXT NOT NULL,
    "leaderId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "condition" JSONB NOT NULL,
    "action" "EmailAction" NOT NULL,
    "delegateToArea" TEXT,
    "notifyImmediately" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3),
    "isSystemLocked" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Routine" (
    "id" TEXT NOT NULL,
    "leaderId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "cronExpression" TEXT NOT NULL,
    "promptInstruction" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" TIMESTAMP(3),

    CONSTRAINT "Routine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailItem" (
    "id" TEXT NOT NULL,
    "leaderId" TEXT NOT NULL,
    "externalId" TEXT,
    "threadKey" TEXT NOT NULL,
    "occurrence" INTEGER NOT NULL DEFAULT 1,
    "senderName" TEXT NOT NULL,
    "senderEmail" TEXT NOT NULL,
    "senderRole" TEXT,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "category" "EmailCategory",
    "confidence" DOUBLE PRECISION,
    "riskSignals" TEXT[],
    "extracted" JSONB,
    "action" "EmailAction",
    "expectedAction" "EmailAction",
    "decisionId" TEXT,
    "taskId" TEXT,
    "isReadByLeader" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "externalId" TEXT,
    "leaderId" TEXT NOT NULL,
    "assigneeId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "acceptanceCriteria" TEXT NOT NULL,
    "isTypical" BOOLEAN NOT NULL DEFAULT false,
    "isClientCommitment" BOOLEAN NOT NULL DEFAULT false,
    "sourceType" TEXT NOT NULL,
    "sourceRefId" TEXT,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "status" "TaskStatus" NOT NULL DEFAULT 'NEW',
    "csvStatus" TEXT,
    "rescheduleCount" INTEGER NOT NULL DEFAULT 0,
    "returnCount" INTEGER NOT NULL DEFAULT 0,
    "lastSubmission" TEXT,
    "aiReviewComment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Decision" (
    "id" TEXT NOT NULL,
    "leaderId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "contextSummary" TEXT NOT NULL,
    "gateReasons" TEXT[],
    "aiRecommendation" TEXT NOT NULL,
    "proposedPayload" JSONB NOT NULL,
    "draftText" TEXT,
    "editedText" TEXT,
    "reminderCount" INTEGER NOT NULL DEFAULT 0,
    "status" "DecisionStatus" NOT NULL DEFAULT 'PENDING',
    "telegramMessageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "Decision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Meeting" (
    "id" TEXT NOT NULL,
    "externalId" TEXT,
    "leaderId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "meetingUrl" TEXT,
    "participationMode" TEXT NOT NULL DEFAULT 'LEADER',
    "avatarToken" TEXT NOT NULL,
    "recallBotId" TEXT,
    "previousMeetingId" TEXT,
    "agendaQuestions" JSONB,
    "transcript" TEXT,
    "protocolMarkdown" TEXT,
    "protocolReadyAt" TIMESTAMP(3),
    "isProtocolApproved" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Meeting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Memory" (
    "id" TEXT NOT NULL,
    "leaderId" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "ruleText" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'GLOBAL',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Memory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityLog" (
    "id" TEXT NOT NULL,
    "leaderId" TEXT NOT NULL,
    "pipeline" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "savedMinutes" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivityLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageLog" (
    "id" TEXT NOT NULL,
    "leaderId" TEXT NOT NULL,
    "pipeline" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL DEFAULT 0,
    "audioSeconds" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "cached" BOOLEAN NOT NULL DEFAULT false,
    "costRub" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsageLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Leader_slug_key" ON "Leader"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Leader_email_key" ON "Leader"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_inviteToken_key" ON "Employee"("inviteToken");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_leaderId_email_key" ON "Employee"("leaderId", "email");

-- CreateIndex
CREATE INDEX "TelegramBinding_chatId_idx" ON "TelegramBinding"("chatId");

-- CreateIndex
CREATE UNIQUE INDEX "TelegramBinding_chatId_leaderId_employeeId_key" ON "TelegramBinding"("chatId", "leaderId", "employeeId");

-- CreateIndex
CREATE INDEX "EmailItem_leaderId_threadKey_idx" ON "EmailItem"("leaderId", "threadKey");

-- CreateIndex
CREATE UNIQUE INDEX "EmailItem_leaderId_externalId_key" ON "EmailItem"("leaderId", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "Meeting_avatarToken_key" ON "Meeting"("avatarToken");

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_leaderId_fkey" FOREIGN KEY ("leaderId") REFERENCES "Leader"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelegramBinding" ADD CONSTRAINT "TelegramBinding_leaderId_fkey" FOREIGN KEY ("leaderId") REFERENCES "Leader"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelegramBinding" ADD CONSTRAINT "TelegramBinding_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Connector" ADD CONSTRAINT "Connector_leaderId_fkey" FOREIGN KEY ("leaderId") REFERENCES "Leader"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Rule" ADD CONSTRAINT "Rule_leaderId_fkey" FOREIGN KEY ("leaderId") REFERENCES "Leader"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Routine" ADD CONSTRAINT "Routine_leaderId_fkey" FOREIGN KEY ("leaderId") REFERENCES "Leader"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailItem" ADD CONSTRAINT "EmailItem_leaderId_fkey" FOREIGN KEY ("leaderId") REFERENCES "Leader"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_leaderId_fkey" FOREIGN KEY ("leaderId") REFERENCES "Leader"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Decision" ADD CONSTRAINT "Decision_leaderId_fkey" FOREIGN KEY ("leaderId") REFERENCES "Leader"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Meeting" ADD CONSTRAINT "Meeting_leaderId_fkey" FOREIGN KEY ("leaderId") REFERENCES "Leader"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Memory" ADD CONSTRAINT "Memory_leaderId_fkey" FOREIGN KEY ("leaderId") REFERENCES "Leader"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_leaderId_fkey" FOREIGN KEY ("leaderId") REFERENCES "Leader"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageLog" ADD CONSTRAINT "UsageLog_leaderId_fkey" FOREIGN KEY ("leaderId") REFERENCES "Leader"("id") ON DELETE CASCADE ON UPDATE CASCADE;
