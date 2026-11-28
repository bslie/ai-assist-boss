import { Suspense } from "react";
import { ConnectorsCatalog } from "@/components/assistant/connectors-catalog";
import { getModule } from "@/core/connectors/modules";
import { listCatalog } from "@/core/connectors/service";
import { db } from "@/db/client";
import { getCurrentLeader } from "@/lib/current-leader";

export const metadata = { title: "Подключения · ИИ-помощник руководителя" };

async function Catalog({ searchParams }: { searchParams: Promise<{ connected?: string; error?: string }> }) {
  const leader = await getCurrentLeader();
  if (!leader) return <div className="text-dim">Руководитель ещё не создан. Запустите <code>npm run db:seed</code>.</div>;
  const [items, sp] = await Promise.all([listCatalog(db, leader.id), searchParams]);
  const banner = sp.connected
    ? { ok: true, text: `${getModule(sp.connected)?.name ?? "Сервис"} подключён. Проверьте права ниже и включайте.` }
    : sp.error
      ? { ok: false, text: sp.error.slice(0, 200) }
      : null;
  return <ConnectorsCatalog leaderId={leader.id} initial={items} banner={banner} />;
}

export default function ConnectorsPage({ searchParams }: { searchParams: Promise<{ connected?: string; error?: string }> }) {
  return (
    <main className="mx-auto flex w-full max-w-[1280px] flex-1 flex-col gap-8 px-4 pb-24 pt-4 sm:px-10 sm:pt-8">
      <div className="flex flex-col gap-3">
        <h1 className="font-serif text-[clamp(30px,5vw,48px)] font-normal leading-[1.1] tracking-[-0.02em]">Подключения</h1>
        <p className="max-w-[680px] text-dim">
          К чему у меня есть доступ, решаете вы. Включайте и отключайте сервисы, когда хотите. Читать я могу сразу, а любое действие во внешнем сервисе по умолчанию сначала показываю вам.
        </p>
      </div>
      <Suspense fallback={<div className="text-dim">Загружаю каталог…</div>}>
        <Catalog searchParams={searchParams} />
      </Suspense>
    </main>
  );
}
