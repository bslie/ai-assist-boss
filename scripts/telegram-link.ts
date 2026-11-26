/**
 * Ссылки для привязки Telegram.
 *   npm run tg:link -- <slug>          ссылка для руководителя (нужны TELEGRAM_BOT_USERNAME и TELEGRAM_BIND_KEY)
 *   npm run tg:link -- --employees <slug>   ссылки-приглашения сотрудников руководителя
 */
import "dotenv/config";
import { leaderBindSecret } from "@/core/telegram/bindings";
import { db } from "@/db/client";

async function main() {
  const args = process.argv.slice(2);
  const employees = args[0] === "--employees";
  const slug = employees ? args[1] : args[0];
  const bot = process.env.TELEGRAM_BOT_USERNAME;
  if (!slug) throw new Error("Укажите slug руководителя, например: npm run tg:link -- ivan-petrov");
  if (!bot) throw new Error("Задайте TELEGRAM_BOT_USERNAME в .env (имя бота без @)");

  const leader = await db.leader.findUnique({ where: { slug } });
  if (!leader) throw new Error(`Руководитель ${slug} не найден`);

  if (employees) {
    const people = await db.employee.findMany({ where: { leaderId: leader.id }, orderBy: { name: "asc" } });
    for (const p of people) console.log(`${p.name} (${p.position}): https://t.me/${bot}?start=${p.inviteToken}`);
  } else {
    console.log(`https://t.me/${bot}?start=${slug}:${leaderBindSecret(slug)}`);
  }
}

main()
  .catch((e) => {
    console.error((e as Error).message);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
