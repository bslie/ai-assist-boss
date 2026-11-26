"use client";

import { useState } from "react";
import { demoDecisions, type Tone } from "@/lib/demo-data";
import { Button } from "@/components/ui/button";

const TAG: Record<Tone, string> = {
  coral: "bg-coral text-[#2a0c08]",
  amber: "bg-amber text-[#1b1305]",
  sage: "bg-sage text-[#0b1e10]",
  dim: "bg-dim text-[#12110f]",
};

type Action = "APPROVE" | "EDITED_APPROVED" | "DELEGATE" | "SNOOZE";

/** Стопка карточек решений. Действия позже уходят в POST /api/decisions/[id]/resolve. */
export function DecisionStack() {
  const [i, setI] = useState(0);
  const cur = demoDecisions[i];
  const more = i < demoDecisions.length - 1;

  const resolve = (action: Action) => {
    void action;
    setI((v) => v + 1);
  };

  if (!cur) {
    return (
      <div className="flex flex-col gap-3 rounded-[22px] border border-dashed border-line-strong p-7">
        <div className="font-serif text-[28px] font-medium leading-tight">Очередь пуста. Спасибо, дальше я сама.</div>
        <div className="text-dim">Следующее письмо с защищённой темой я принесу сюда сразу.</div>
        <div>
          <Button variant="outline" className="h-11 rounded-full px-5" onClick={() => setI(0)}>
            Показать снова
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="relative pb-5">
      {more && (
        <>
          <div className="absolute inset-x-5 bottom-0 h-10 rounded-b-[22px] border border-line bg-sunken" />
          <div className="absolute inset-x-2.5 bottom-2.5 h-10 rounded-b-[22px] border border-line bg-[#211f1b]" />
        </>
      )}
      <article className="relative flex flex-col gap-[18px] rounded-[22px] border border-[#3d3931] bg-raised p-7">
        <div className="flex flex-wrap items-center gap-2.5">
          <span className={`rounded-full px-3 py-1 text-xs font-semibold ${TAG[cur.tone]}`}>{cur.tag}</span>
          <span className="text-[13px] text-dim">
            {cur.from} · {cur.when}
          </span>
          <span className="ml-auto text-[13px] text-dim">
            Решение {i + 1} из {demoDecisions.length}
          </span>
        </div>
        <h2 className="font-serif text-[28px] font-medium leading-tight tracking-tight">{cur.title}</h2>
        <p className="text-soft">{cur.summary}</p>
        <blockquote className="rounded-[14px] border border-line bg-ink px-[18px] py-4">
          <div className="mb-1.5 text-xs text-dim">Что я предлагаю</div>
          <div className="font-serif text-[17px] leading-normal">{cur.draft}</div>
        </blockquote>
        <div className="flex flex-wrap gap-2.5">
          <Button className="h-12 rounded-full px-6 font-semibold" onClick={() => resolve("APPROVE")}>Утвердить</Button>
          <Button variant="outline" className="h-12 rounded-full px-5" onClick={() => resolve("EDITED_APPROVED")}>Поправить</Button>
          <Button variant="outline" className="h-12 rounded-full px-5" onClick={() => resolve("DELEGATE")}>Передать</Button>
          <Button variant="ghost" className="h-12 rounded-full px-5 text-dim" onClick={() => resolve("SNOOZE")}>Не сейчас</Button>
        </div>
      </article>
    </div>
  );
}
