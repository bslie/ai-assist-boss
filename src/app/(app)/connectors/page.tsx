import { Lock } from "lucide-react";
import { PermissionToggle } from "@/components/assistant/permission-toggle";
import { McpProbe } from "@/components/assistant/mcp-probe";
import { demoConnected, demoMore } from "@/lib/demo-data";

export default function ConnectorsPage() {
  return (
    <main className="mx-auto flex w-full max-w-[980px] flex-col gap-14 px-5 pb-24 pt-12 sm:px-10">
      <div className="flex flex-col gap-3.5">
        <h1 className="font-serif text-[clamp(34px,5vw,52px)] font-normal leading-[1.1] tracking-[-0.02em]">
          Вы сами решаете, к чему у меня есть доступ.
        </h1>
        <p className="max-w-[640px] text-dim">
          Подключайте и отключайте сервисы когда хотите. Читать я могу сразу, а любое действие во внешнем сервисе по умолчанию сначала показываю вам.
        </p>
      </div>

      <section aria-labelledby="on" className="flex flex-col gap-5">
        <h2 id="on" className="font-serif text-[26px] font-medium">Уже подключено</h2>
        {demoConnected.map((c) => (
          <article key={c.name} className="flex flex-wrap gap-6 rounded-3xl border border-line bg-sunken p-[26px]">
            <div className="flex min-w-0 flex-[1_1_240px] flex-col gap-2.5">
              <div className="flex items-center gap-3">
                <div className="flex size-11 items-center justify-center rounded-full border border-line-strong bg-raised font-serif text-xl text-amber">{c.letter}</div>
                <div>
                  <div className="font-serif text-[22px] font-medium leading-tight">{c.name}</div>
                  <div className="flex items-center gap-1.5 text-[13px] text-sage"><span className="size-[7px] rounded-full bg-sage" />{c.status}</div>
                </div>
              </div>
              <div className="text-sm text-dim">{c.sees}</div>
              <div><button type="button" className="min-h-11 text-[13px] text-dim underline">Отключить</button></div>
            </div>
            <div className="flex min-w-0 flex-[1.4_1_360px] flex-col gap-3.5">
              {c.caps.map(([label, perm]) => (
                <PermissionToggle key={label} label={label} initial={perm} />
              ))}
              <div className="flex items-center gap-2 rounded-[14px] bg-[#2a1a18] px-3.5 py-2.5 text-[13px] text-coral">
                <Lock size={14} aria-hidden="true" />
                {c.locked}
              </div>
            </div>
          </article>
        ))}
      </section>

      <section aria-labelledby="add" className="flex flex-col gap-5">
        <h2 id="add" className="font-serif text-[26px] font-medium">Подключить ещё</h2>
        <div className="flex flex-wrap gap-2.5">
          {demoMore.map((m) => (
            <button key={m.name} type="button" className="flex min-h-14 items-center gap-2.5 rounded-full border border-line-strong bg-sunken py-0 pl-2.5 pr-[22px]">
              <span className="flex size-9 items-center justify-center rounded-full bg-raised font-serif text-amber">{m.letter}</span>
              <span className="flex flex-col items-start leading-tight">
                <span className="font-medium">{m.name}</span>
                <span className="text-xs text-dim">{m.kind}</span>
              </span>
            </button>
          ))}
        </div>
        <McpProbe />
      </section>
    </main>
  );
}
