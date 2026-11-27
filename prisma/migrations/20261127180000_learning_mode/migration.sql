-- AlterTable
ALTER TABLE "Leader" ADD COLUMN     "learningMode" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "trustedScopes" TEXT[] DEFAULT ARRAY[]::TEXT[];
