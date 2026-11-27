-- AlterEnum
ALTER TYPE "EmailCategory" ADD VALUE 'SYSTEM_NOTICE';

-- AlterTable
ALTER TABLE "EmailItem" ADD COLUMN     "connectorId" TEXT,
ADD COLUMN     "readMarkedAt" TIMESTAMP(3);
