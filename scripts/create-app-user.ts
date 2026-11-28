/**
 * Учётная запись для входа в приложение (логин+пароль и/или Telegram).
 *   APP_USER_PASSWORD=... npm run user:create -- --login admin --name "Администратор" --role ADMIN
 *   APP_USER_PASSWORD=... npm run user:create -- --login ivan --name "Иван Петров" --leader ivan-petrov
 *   npm run user:create -- --login ivan --name "Иван" --leader ivan-petrov --telegram 123456789
 *
 * Пароль берётся только из APP_USER_PASSWORD (не из аргументов, чтобы не попадал в историю shell).
 */
import "dotenv/config";
import { createEmptyLeader, leaderOwnerLogin, leaderTakenMessage } from "@/core/auth/leader-account";
import { hashPassword } from "@/core/auth/password";
import { db } from "@/db/client";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const login = arg("login");
  const displayName = arg("name");
  const role = (arg("role") ?? "LEADER").toUpperCase();
  const leaderSlug = arg("leader");
  const telegramId = arg("telegram");
  const password = process.env.APP_USER_PASSWORD;

  if (!login || !displayName) throw new Error("Нужны --login и --name");
  if (role !== "ADMIN" && role !== "LEADER") throw new Error("--role: ADMIN или LEADER");
  if (!password && !telegramId) throw new Error("Задайте APP_USER_PASSWORD или --telegram <id>");
  if (password && password.length < 8) throw new Error("Пароль короче 8 символов");
  if (telegramId && !/^\d{1,20}$/.test(telegramId)) throw new Error("--telegram: только цифры");

  let leaderId: string | null = null;
  if (leaderSlug) {
    const leader = await db.leader.findUnique({ where: { slug: leaderSlug }, select: { id: true } });
    if (!leader) throw new Error(`Руководитель со slug «${leaderSlug}» не найден`);
    leaderId = leader.id;
    if (role === "LEADER") {
      const owner = await leaderOwnerLogin(db, leader.id);
      if (owner) throw new Error(leaderTakenMessage(owner));
    }
  }
  // Руководитель без --leader получает нового пустого руководителя: чистый кабинет без чужих подключений.
  if (role === "LEADER" && !leaderId) leaderId = (await createEmptyLeader(db, { displayName, login })).id;

  const user = await db.appUser.create({
    data: {
      login,
      displayName,
      role: role as "ADMIN" | "LEADER",
      leaderId,
      telegramId: telegramId ?? null,
      passwordHash: password ? await hashPassword(password) : null,
    },
  });
  console.log(`Создана учётная запись «${user.login}» (${user.role})${leaderId ? `, руководитель ${leaderSlug ?? "новый (пустой кабинет)"}` : ""}.`);
}

main()
  .catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
