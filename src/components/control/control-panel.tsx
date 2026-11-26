"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Activity, Clock, LayoutDashboard, LogOut, Play, UserPlus, Users as UsersIcon, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Section = "overview" | "users" | "demo";
type Check = { name: string; ok: boolean; detail: string };
type Summary = {
  viewer: { login: string; displayName: string };
  health: Check[];
  counts: { leaders: number; appUsers: number; pendingDecisions: number; openTasks: number };
};
type AppUserRow = {
  id: string;
  login: string;
  displayName: string;
  role: "ADMIN" | "LEADER";
  leaderName: string | null;
  telegramId: string | null;
  hasPassword: boolean;
};
type Leader = { id: string; name: string };

const NAV: { id: Section; label: string; icon: LucideIcon }[] = [
  { id: "overview", label: "Обзор", icon: LayoutDashboard },
  { id: "users", label: "Пользователи", icon: UsersIcon },
  { id: "demo", label: "Демо-стенд", icon: Play },
];

const INPUT = "h-10 rounded-lg border border-border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** Запрос к API: при ошибке возвращает текст из ответа, а не падает. */
async function api<T>(url: string, init?: RequestInit): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const res = await fetch(url, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
    const data = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) return { ok: false, error: data.error ?? `Ошибка ${res.status}` };
    return { ok: true, data };
  } catch {
    return { ok: false, error: "Нет связи с сервером" };
  }
}

export function ControlPanel({ viewer, leaders }: { viewer: { displayName: string; login: string }; leaders: Leader[] }) {
  const router = useRouter();
  const [section, setSection] = useState<Section>("overview");

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
    router.refresh();
  }

  return (
    <div className="flex min-h-screen flex-1 flex-col bg-background md:flex-row">
      <aside className="flex shrink-0 flex-row items-center gap-1 overflow-x-auto border-b border-border bg-raised p-3 md:w-56 md:flex-col md:items-stretch md:border-b-0 md:border-r md:p-4" aria-label="Разделы панели">
        <div className="hidden px-2 pb-4 font-serif text-lg font-medium md:block">Управление</div>
        {NAV.map((n) => {
          const Icon = n.icon;
          const active = section === n.id;
          return (
            <button
              key={n.id}
              type="button"
              onClick={() => setSection(n.id)}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex h-10 shrink-0 items-center gap-2.5 rounded-lg px-3 text-left text-sm transition-colors",
                active ? "bg-background font-medium text-foreground shadow-sm" : "text-dim hover:bg-background/60 hover:text-foreground",
              )}
            >
              <Icon className="size-4" aria-hidden="true" />
              {n.label}
            </button>
          );
        })}
        <div className="ml-auto flex items-center gap-2 text-sm md:ml-0 md:mt-auto md:flex-col md:items-stretch md:border-t md:border-border md:pt-4">
          <div className="hidden px-2 md:block">
            <div className="font-medium">{viewer.displayName}</div>
            <div className="text-xs text-dim">{viewer.login}</div>
          </div>
          <Button variant="ghost" onClick={logout} className="justify-start gap-2">
            <LogOut className="size-4" aria-hidden="true" /> Выйти
          </Button>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col gap-6 p-4 sm:p-8 lg:p-10">
        {section === "overview" ? <Overview /> : null}
        {section === "users" ? <Users /> : null}
        {section === "demo" ? <Demo leaders={leaders} /> : null}
      </main>
    </div>
  );
}

function Overview() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await api<Summary>("/api/control/summary");
    if (r.ok) {
      setSummary(r.data);
      setError(null);
    } else setError(r.error);
  }, []);

  useEffect(() => {
    let alive = true;
    api<Summary>("/api/control/summary").then((r) => {
      if (!alive) return;
      if (r.ok) setSummary(r.data);
      else setError(r.error);
    });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <section className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="font-serif text-3xl font-normal">Обзор</h1>
        <Button variant="outline" size="sm" onClick={load}>Обновить</Button>
      </div>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      {summary ? (
        <>
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            <Stat label="Руководители" value={summary.counts.leaders} />
            <Stat label="Учётные записи" value={summary.counts.appUsers} />
            <Stat label="Решения в очереди" value={summary.counts.pendingDecisions} />
            <Stat label="Открытые задачи" value={summary.counts.openTasks} />
          </div>
          <div className="flex flex-col rounded-xl border border-border bg-raised">
            <div className="flex items-center gap-2 border-b border-border px-5 py-3 text-sm font-medium">
              <Activity className="size-4" aria-hidden="true" /> Состояние системы
            </div>
            <ul className="divide-y divide-border">
              {summary.health.map((h) => (
                <li key={h.name} className="flex items-center justify-between gap-4 px-5 py-3 text-sm">
                  <span className="flex items-center gap-3">
                    <span className={cn("size-2.5 rounded-full", h.ok ? "bg-emerald-500" : "bg-destructive")} aria-hidden="true" />
                    {h.name}
                  </span>
                  <span className="truncate text-dim">{h.detail}</span>
                </li>
              ))}
            </ul>
          </div>
        </>
      ) : !error ? (
        <p className="text-dim">Загружаю…</p>
      ) : null}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border bg-raised p-5">
      <span className="text-sm text-dim">{label}</span>
      <span className="font-serif text-3xl tabular-nums">{value}</span>
    </div>
  );
}

const EMPTY_FORM = { login: "", displayName: "", role: "LEADER" as "ADMIN" | "LEADER", leaderId: "", password: "", telegramId: "" };

function Users() {
  const [users, setUsers] = useState<AppUserRow[] | null>(null);
  const [leaders, setLeaders] = useState<Leader[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);

  const load = useCallback(async () => {
    const r = await api<{ users: AppUserRow[] }>("/api/control/users");
    if (r.ok) setUsers(r.data.users);
    else setError(r.error);
  }, []);

  useEffect(() => {
    let alive = true;
    api<{ users: AppUserRow[] }>("/api/control/users").then((r) => {
      if (!alive) return;
      if (r.ok) setUsers(r.data.users);
      else setError(r.error);
    });
    api<{ leaders?: Leader[] }>("/api/leaders").then((r) => {
      if (alive && r.ok) setLeaders(r.data.leaders ?? []);
    });
    return () => {
      alive = false;
    };
  }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    const r = await api<{ user: AppUserRow }>("/api/control/users", {
      method: "POST",
      body: JSON.stringify({
        login: form.login,
        displayName: form.displayName,
        role: form.role,
        leaderId: form.leaderId || null,
        password: form.password || undefined,
        telegramId: form.telegramId || undefined,
      }),
    });
    if (!r.ok) return setError(r.error);
    setNotice(`Учётная запись «${r.data.user.login}» создана`);
    setForm(EMPTY_FORM);
    load();
  }

  return (
    <section className="flex flex-col gap-6">
      <h1 className="font-serif text-3xl font-normal">Пользователи</h1>

      <div className="rounded-xl border border-border bg-raised">
        <div className="border-b border-border px-5 py-3 text-sm font-medium">Учётные записи</div>
        {users === null ? (
          <p className="px-5 py-4 text-sm text-dim">Загружаю…</p>
        ) : users.length === 0 ? (
          <p className="px-5 py-4 text-sm text-dim">Записей пока нет.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-dim">
                <tr className="border-b border-border">
                  <th className="px-5 py-2.5 font-normal">Логин</th>
                  <th className="px-5 py-2.5 font-normal">Имя</th>
                  <th className="px-5 py-2.5 font-normal">Роль</th>
                  <th className="px-5 py-2.5 font-normal">Руководитель</th>
                  <th className="px-5 py-2.5 font-normal">Способы входа</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} className="border-b border-border last:border-0">
                    <td className="px-5 py-2.5 font-mono text-[13px]">{u.login}</td>
                    <td className="px-5 py-2.5">{u.displayName}</td>
                    <td className="px-5 py-2.5">{u.role === "ADMIN" ? "Администратор" : "Руководитель"}</td>
                    <td className="px-5 py-2.5 text-dim">{u.leaderName ?? "—"}</td>
                    <td className="px-5 py-2.5 text-dim">
                      {[u.hasPassword ? "пароль" : null, u.telegramId ? `Telegram ${u.telegramId}` : null].filter(Boolean).join(", ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <form onSubmit={create} className="flex flex-col gap-4 rounded-xl border border-border bg-raised p-5" aria-label="Новая учётная запись">
        <div className="flex items-center gap-2 text-sm font-medium">
          <UserPlus className="size-4" aria-hidden="true" /> Новая учётная запись
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-dim">Логин</span>
            <input className={INPUT} required minLength={3} value={form.login} onChange={(e) => setForm({ ...form, login: e.target.value })} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-dim">Имя</span>
            <input className={INPUT} required value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-dim">Роль</span>
            <select className={INPUT} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as "ADMIN" | "LEADER" })}>
              <option value="LEADER">Руководитель</option>
              <option value="ADMIN">Администратор</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-dim">Руководитель {form.role === "LEADER" ? "(обязательно)" : "(необязательно)"}</span>
            <select className={INPUT} value={form.leaderId} onChange={(e) => setForm({ ...form, leaderId: e.target.value })}>
              <option value="">—</option>
              {leaders.map((l) => (
                <option key={l.id} value={l.id}>{l.name}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-dim">Пароль (от 8 символов)</span>
            <input className={INPUT} type="password" autoComplete="new-password" minLength={8} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-dim">Telegram ID (цифры)</span>
            <input className={INPUT} inputMode="numeric" value={form.telegramId} onChange={(e) => setForm({ ...form, telegramId: e.target.value })} />
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={!form.login || !form.displayName || (!form.password && !form.telegramId)}>Создать</Button>
          <span className="text-xs text-dim">Нужен пароль, Telegram ID или оба.</span>
          {notice ? <span className="text-sm text-dim">{notice}</span> : null}
          {error ? <span role="alert" className="text-sm text-destructive">{error}</span> : null}
        </div>
      </form>
    </section>
  );
}

const SCENARIOS: { id: string; label: string }[] = [
  { id: "INGEST_DATASET", label: "Загрузить датасет" },
  { id: "TRIGGER_MORNING", label: "Утренний план" },
  { id: "TRIGGER_EMAIL_BATCH", label: "Разбор писем" },
  { id: "RUN_MEETING_TRANSCRIPT", label: "Протокол встречи" },
  { id: "TRIGGER_WEEKLY", label: "Итог недели" },
];

function Demo({ leaders }: { leaders: Leader[] }) {
  const [now, setNow] = useState<string | null>(null);
  const [leaderId, setLeaderId] = useState(leaders[0]?.id ?? "");
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const note = (line: string) => setLog((l) => [`${new Date().toLocaleTimeString("ru-RU")}  ${line}`, ...l].slice(0, 30));

  const loadClock = useCallback(async () => {
    const r = await api<{ now: string; mode: string }>("/api/demo/clock");
    if (r.ok) setNow(`${new Date(r.data.now).toLocaleString("ru-RU")} (${r.data.mode})`);
  }, []);

  useEffect(() => {
    let alive = true;
    api<{ now: string; mode: string }>("/api/demo/clock").then((r) => {
      if (alive && r.ok) setNow(`${new Date(r.data.now).toLocaleString("ru-RU")} (${r.data.mode})`);
    });
    return () => {
      alive = false;
    };
  }, []);

  async function moveClock(body: { advanceMinutes: number } | { reset: true }, label: string) {
    setBusy(true);
    const r = await api<unknown>("/api/demo/clock", { method: "POST", body: JSON.stringify(body) });
    setBusy(false);
    note(r.ok ? `Часы: ${label}` : `Часы: ошибка — ${r.error}`);
    if (r.ok) loadClock();
  }

  async function runScenario(scenario: string, label: string) {
    if (!leaderId) return note("Выберите руководителя");
    setBusy(true);
    note(`Запуск: ${label}…`);
    const r = await api<unknown>(`/api/demo/simulate?leaderId=${encodeURIComponent(leaderId)}`, {
      method: "POST",
      body: JSON.stringify({ scenario }),
    });
    setBusy(false);
    note(r.ok ? `Готово: ${label}` : `Ошибка «${label}»: ${r.error}`);
  }

  return (
    <section className="flex flex-col gap-6">
      <h1 className="font-serif text-3xl font-normal">Демо-стенд</h1>

      <div className="flex flex-col gap-4 rounded-xl border border-border bg-raised p-5">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Clock className="size-4" aria-hidden="true" /> Демо-часы
        </div>
        <p className="text-sm text-dim">Сейчас: {now ?? "…"}</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={busy} onClick={() => moveClock({ advanceMinutes: 30 }, "+30 мин")}>+30 мин</Button>
          <Button variant="outline" disabled={busy} onClick={() => moveClock({ advanceMinutes: 60 * 24 }, "+1 день")}>+1 день</Button>
          <Button variant="outline" disabled={busy} onClick={() => moveClock({ reset: true }, "сброс")}>Сбросить</Button>
        </div>
      </div>

      <div className="flex flex-col gap-4 rounded-xl border border-border bg-raised p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="text-sm font-medium">Сценарии</div>
          <select aria-label="Руководитель" className={INPUT} value={leaderId} onChange={(e) => setLeaderId(e.target.value)}>
            {leaders.map((l) => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </select>
        </div>
        <p className="text-xs text-dim">Часть сценариев обращается к языковой модели и тратит её бюджет.</p>
        <div className="flex flex-wrap gap-2">
          {SCENARIOS.map((s) => (
            <Button key={s.id} variant="outline" disabled={busy} onClick={() => runScenario(s.id, s.label)}>
              {s.label}
            </Button>
          ))}
        </div>
      </div>

      <div className="rounded-xl border border-border bg-raised p-5">
        <div className="mb-2 text-sm font-medium">Журнал действий</div>
        {log.length === 0 ? (
          <p className="text-sm text-dim">Пока пусто.</p>
        ) : (
          <ul className="flex flex-col gap-1 font-mono text-xs text-dim">
            {log.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
