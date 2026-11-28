import type { ReactNode } from "react";
import { plural } from "@/core/dashboard";

export interface ContactGroup {
  count: number;
  /** Сколько из них привязали Telegram (остальным пишу на почту). */
  telegram: number;
}

export interface ContactsPolicyProps {
  leaderName: string;
  subordinates: ContactGroup;
  managers: ContactGroup;
  peers: ContactGroup;
  /** Поручения сотрудникам уходят без вашего «да»: режим обучения выключен или область отпущена. */
  assignAlone: boolean;
  /** Контроль сроков включён в «Рутинах». */
  guardActive: boolean;
  quietStart: string;
  quietEnd: string;
}

const people = (n: number) => `${n} ${plural(n, "человек", "человека", "человек")}`;

function Group({ title, group, children }: { title: string; group: ContactGroup; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-2xl border border-line bg-raised px-5 py-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="font-serif text-[19px] font-medium">{title}</h3>
        <span className="text-[13px] text-dim">
          {group.count === 0 ? "пока никого" : `${people(group.count)}${group.telegram > 0 ? `, в Telegram: ${group.telegram}` : ""}`}
        </span>
      </div>
      <p className="text-[15px] leading-relaxed text-soft">{children}</p>
    </div>
  );
}

/**
 * Политика общения с контактами (SPEC 1.1, п. 7): что помощник делает с подчинёнными, руководством и коллегами.
 * Только то, что код действительно делает: ничего не придумано. Менять — в чате и в «Рутинах».
 */
export function ContactsPolicy(p: ContactsPolicyProps) {
  return (
    <section aria-labelledby="contacts" className="flex flex-col gap-4">
      <div id="contacts" className="flex items-center gap-2.5 text-[13px] font-semibold text-soft">
        <span className="size-2.5 rounded-full bg-soft" />
        Как я общаюсь с коллегами
      </div>
      <p className="font-serif text-[22px] leading-snug">
        Каждое первое сообщение начинаю так: «Здравствуйте, я ИИ-помощник {p.leaderName}». Пишу на почту, а если человек подключил Telegram, то туда.
      </p>
      <div className="grid gap-3 sm:grid-cols-1">
        <Group title="Подчинённые" group={p.subordinates}>
          Ставлю поручение с критерием готовности. {p.assignAlone ? "Отправляю сама." : "Отправляю после вашего «да»."}{" "}
          {p.guardActive
            ? "За сутки до срока спрашиваю, как идёт дело, при просрочке напоминаю, через сутки сообщаю вам. Результат проверяю по критерию и возвращаю на доработку."
            : "Контроль сроков сейчас выключен в «Рутинах»: напоминать и эскалировать не буду."}{" "}
          Обязательства клиентам без вашего согласия не переношу.
        </Group>
        <Group title="Руководство" group={p.managers}>
          Сама не пишу. Любое письмо руководству и от руководства приходит к вам карточкой, ослабить это нельзя.
        </Group>
        <Group title="Коллеги" group={p.peers}>
          Отвечаю по правилам выше, а всё незнакомое и всё про деньги выше порога показываю вам. Без вашего «да» ничего не обещаю.
        </Group>
      </div>
      <p className="text-sm text-dim">
        Хотите по-другому? Скажите в «Разговоре»: «поручения отправляй без меня» или «верни поручения мне». Как часто напоминать — в «Рутинах». Мои сообщения вам в тихие часы ({p.quietStart}–{p.quietEnd}) копятся до утреннего плана, если там нет срочного.
      </p>
    </section>
  );
}
