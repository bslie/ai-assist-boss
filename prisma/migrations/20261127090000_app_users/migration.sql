-- CreateEnum
CREATE TYPE "AppRole" AS ENUM ('ADMIN', 'LEADER');

-- CreateTable
CREATE TABLE "AppUser" (
    "id" TEXT NOT NULL,
    "login" TEXT NOT NULL,
    "passwordHash" TEXT,
    "telegramId" TEXT,
    "displayName" TEXT NOT NULL,
    "role" "AppRole" NOT NULL DEFAULT 'LEADER',
    "leaderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppUser_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AppUser_login_key" ON "AppUser"("login");

-- CreateIndex
CREATE UNIQUE INDEX "AppUser_telegramId_key" ON "AppUser"("telegramId");

-- AddForeignKey
ALTER TABLE "AppUser" ADD CONSTRAINT "AppUser_leaderId_fkey" FOREIGN KEY ("leaderId") REFERENCES "Leader"("id") ON DELETE SET NULL ON UPDATE CASCADE;
