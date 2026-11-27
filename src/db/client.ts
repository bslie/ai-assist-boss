import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

const globalForPrisma = globalThis as unknown as { __prisma?: PrismaClient; __prismaClass?: typeof PrismaClient };

function createClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

// После `prisma generate` hot reload подгружает новый класс клиента: старый экземпляр не знает новых полей,
// поэтому пересоздаём синглтон, если класс сменился.
if (globalForPrisma.__prisma && globalForPrisma.__prismaClass !== PrismaClient) {
  void globalForPrisma.__prisma.$disconnect().catch(() => {});
  globalForPrisma.__prisma = undefined;
}
globalForPrisma.__prismaClass = PrismaClient;

/** Синглтон (переживает hot reload в `next dev`). Все запросы фильтровать по leaderId. */
export const db: PrismaClient = (globalForPrisma.__prisma ??= createClient());
