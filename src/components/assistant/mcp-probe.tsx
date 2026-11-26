"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { demoFoundTools } from "@/lib/demo-data";

/** Удалённый MCP (P2): POST /api/connectors { mcpUrl } → list_tools; все инструменты по умолчанию APPROVE. */
export function McpProbe() {
  const [url, setUrl] = useState("");
  const [found, setFound] = useState(false);

  return (
    <div className="flex flex-col gap-3.5 rounded-3xl border border-dashed border-line-strong p-[26px]">
      <div className="font-serif text-[22px] font-medium">Нужного нет в списке? Дайте адрес своего сервера, я посмотрю, что он умеет.</div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setFound(url.trim().length > 0);
        }}
        className="flex flex-wrap gap-2 rounded-full border border-line-strong bg-raised py-1.5 pl-5 pr-1.5"
      >
        <label htmlFor="mcp" className="sr-only">Адрес MCP-сервера</label>
        <input id="mcp" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" className="min-h-11 min-w-0 flex-[1_1_240px] bg-transparent outline-none placeholder:text-dim" />
        <Button type="submit" className="h-11 rounded-full bg-amber px-[22px] font-semibold text-[#1b1305] hover:bg-amber/90">Посмотреть</Button>
      </form>
      {found && (
        <div className="flex flex-col gap-2 rounded-[18px] border border-line bg-ink px-[18px] py-4">
          <div className="text-xs text-dim">Нашла {demoFoundTools.length} действия. Пока все на вашем подтверждении.</div>
          {demoFoundTools.map((t) => (
            <div key={t} className="flex flex-wrap justify-between gap-2">
              <span>{t}</span>
              <span className="text-[13px] text-amber">спрашивать</span>
            </div>
          ))}
          <div><Button className="h-11 rounded-full px-[22px] font-semibold">Подключить</Button></div>
        </div>
      )}
    </div>
  );
}
