"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Activity, ArrowLeft, CheckCircle2, Clock, ClipboardList, KeyRound, LayoutDashboard, LogOut, Play, Search, Send, Users as UsersIcon, UserPlus, X, XCircle, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { OAuthApps } from "@/components/control/oauth-apps";
import { cn } from "@/lib/utils";

type Section = "overview" | "users" | "integrations" | "demo";
type Check = { name: string; ok: boolean; detail: string };
type Summary = {
  viewer: { login: string; displayName: string };
  health: Check[];
  counts: { leaders: number; appUsers: number; pendingDecisions: number; openTasks: number };
};
type AppUserRow = {
  id: string;
  leaderId: string | null;
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
  { id: "integrations", label: "Интеграции", icon: KeyRound },
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

  const initials = viewer.displayName.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();

  return (
    <div className="flex min-h-screen flex-1 flex-col bg-background md:flex-row">
      <aside className="flex shrink-0 flex-row items-center gap-1 overflow-x-auto border-b border-border bg-sunken p-3 md:sticky md:top-0 md:h-screen md:w-60 md:flex-col md:items-stretch md:border-b-0 md:border-r md:p-4" aria-label="Разделы панели">
        <div className="hidden items-center gap-2.5 px-2 pb-5 md:flex">
          <svg width="26" height="26" viewBox="0 0 32 32" fill="none" aria-hidden="true">
            <circle cx="16" cy="16" r="15" stroke="var(--amber)" strokeWidth="1.5" />
            <circle cx="16" cy="16" r="9" stroke="var(--amber)" strokeWidth="1.5" opacity="0.6" />
            <circle cx="16" cy="16" r="3.5" fill="var(--amber)" />
          </svg>
          <div className="leading-tight">
            <div className="font-serif text-base font-medium">Управление</div>
            <div className="text-[11px] text-dim">Администратор</div>
          </div>
        </div>
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
                active ? "bg-raised font-medium text-foreground shadow-sm" : "text-dim hover:bg-raised/60 hover:text-foreground",
              )}
            >
              <Icon className={cn("size-4", active && "text-amber")} aria-hidden="true" />
              {n.label}
            </button>
          );
        })}
        <Link href="/" className="flex h-10 shrink-0 items-center gap-2.5 rounded-lg px-3 text-sm text-dim transition-colors hover:bg-raised/60 hover:text-foreground md:mt-2">
          <ArrowLeft className="size-4" aria-hidden="true" /> К помощнику
        </Link>
        <div className="ml-auto flex items-center gap-2 text-sm md:ml-0 md:mt-auto md:flex-col md:items-stretch md:border-t md:border-border md:pt-4">
          <div className="hidden items-center gap-3 px-2 md:flex">
            <Avatar name={viewer.displayName} fallback={initials} />
            <div className="min-w-0">
              <div className="truncate font-medium">{viewer.displayName}</div>
              <div className="truncate text-xs text-dim">{viewer.login}</div>
            </div>
          </div>
          <Button variant="ghost" onClick={logout} className="justify-start gap-2 text-dim hover:text-foreground">
            <LogOut className="size-4" aria-hidden="true" /> Выйти
          </Button>
        </div>
      </aside>

      <main className="mx-auto flex w-full min-w-0 max-w-[1100px] flex-1 flex-col gap-6 p-4 sm:p-8 lg:p-10">
        {section === "overview" ? <Overview /> : null}
        {section === "users" ? <Users viewerLogin={viewer.login} /> : null}
        {section === "integrations" ? <OAuthApps /> : null}
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
            <Stat icon={UsersIcon} label="Руководители" value={summary.counts.leaders} />
            <Stat icon={KeyRound} label="Учётные записи" value={summary.counts.appUsers} />
            <Stat icon={ClipboardList} label="Решения в очереди" value={summary.counts.pendingDecisions} accent={summary.counts.pendingDecisions > 0} />
            <Stat icon={CheckCircle2} label="Открытые задачи" value={summary.counts.openTasks} />
          </div>
          <div className="flex flex-col overflow-hidden rounded-xl border border-border bg-raised">
            <div className="flex items-center justify-between gap-2 border-b border-border px-5 py-3.5 text-sm font-medium">
              <span className="flex items-center gap-2">
                <Activity className="size-4 text-amber" aria-hidden="true" /> Состояние системы
              </span>
              {summary.health.every((h) => h.ok) ? (
                <span className="rounded-full bg-sage/15 px-2.5 py-0.5 text-xs font-normal text-sage">Всё работает</span>
              ) : (
                <span className="rounded-full bg-coral/15 px-2.5 py-0.5 text-xs font-normal text-coral">
                  Проблем: {summary.health.filter((h) => !h.ok).length}
                </span>
              )}
            </div>
            <ul className="divide-y divide-border">
              {summary.health.map((h) => (
                <li key={h.name} className="flex items-center justify-between gap-4 px-5 py-3 text-sm">
                  <span className="flex items-center gap-3">
                    {h.ok ? <CheckCircle2 className="size-4 text-sage" aria-label="работает" /> : <XCircle className="size-4 text-coral" aria-label="сбой" />}
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

function Stat({ icon: Icon, label, value, accent }: { icon: LucideIcon; label: string; value: number; accent?: boolean }) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-raised p-5">
      <span className="flex items-center gap-2 text-sm text-dim">
        <Icon className="size-4" aria-hidden="true" /> {label}
      </span>
      <span className={cn("font-serif text-4xl tabular-nums", accent && "text-amber")}>{value}</span>
    </div>
  );
}

const AVATAR_TONES = ["bg-amber/20 text-amber", "bg-sage/20 text-sage", "bg-coral/20 text-coral", "bg-line-strong/50 text-soft"];

/** Круглый аватар с инициалами; цвет стабилен для одного имени. */
function Avatar({ name, fallback }: { name: string; fallback?: string }) {
  const initials = fallback ?? name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
  const tone = AVATAR_TONES[[...name].reduce((a, c) => a + c.charCodeAt(0), 0) % AVATAR_TONES.length];
  return (
    <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-full text-xs font-medium", tone)} aria-hidden="true">
      {initials || "?"}
    </span>
  );
}

const NEW_LEADER = "__new__";
const EMPTY_FORM = { login: "", displayName: "", role: "LEADER" as "ADMIN" | "LEADER", leaderId: NEW_LEADER, password: "", telegramId: "" };

function Users({ viewerLogin }: { viewerLogin: string }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [users, setUsers] = useState<AppUserRow[] | null>(null);
  const [leaders, setLeaders] = useState<Leader[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  // Сброс до «первого входа»: два шага, потому что подключения и история разбора удаляются без возврата.
  const [resetFor, setResetFor] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  // Удаление руководителя: тоже в два шага, вместе с ним уходят сотрудники, письма, поручения и подключения.
  const router = useRouter();
  const [deleteFor, setDeleteFor] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function deleteLeader(l: Leader) {
    setDeleting(true);
    setError(null);
    setNotice(null);
    const r = await api<{ accountsDeleted: number }>(`/api/leaders/${encodeURIComponent(l.id)}`, { method: "DELETE", body: JSON.stringify({ confirm: true }) });
    setDeleting(false);
    setDeleteFor(null);
    if (!r.ok) return setError(r.error);
    setNotice(`Руководитель «${l.name}» удалён${r.data.accountsDeleted ? `, учётных записей: ${r.data.accountsDeleted}` : ""}`);
    setLeaders((all) => all.filter((x) => x.id !== l.id));
    load();
    router.refresh();
  }

  async function resetUser(u: AppUserRow) {
    setResetting(true);
    setError(null);
    setNotice(null);
    const r = await api<{ report: { connectors: number; emails: number; decisions: number; memories: number; rules: number } }>(
      `/api/control/users/${encodeURIComponent(u.id)}/reset`,
      { method: "POST", body: JSON.stringify({ confirm: true }) },
    );
    setResetting(false);
    setResetFor(null);
    if (!r.ok) return setError(r.error);
    const x = r.data.report;
    setNotice(`«${u.displayName}» вернулся к первому входу: подключений ${x.connectors}, писем ${x.emails}, карточек ${x.decisions}, выученных правил ${x.memories + x.rules}`);
  }

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
        leaderId: form.leaderId && form.leaderId !== NEW_LEADER ? form.leaderId : null,
        newLeader: form.role === "LEADER" && form.leaderId === NEW_LEADER ? true : undefined,
        password: form.password || undefined,
        telegramId: form.telegramId || undefined,
      }),
    });
    if (!r.ok) return setError(r.error);
    setNotice(`Учётная запись «${r.data.user.login}» создана`);
    setForm(EMPTY_FORM);
    closeDrawer();
    load();
  }

  const openDrawer = () => {
    setError(null);
    setOpen(true);
    dialogRef.current?.showModal();
  };
  const closeDrawer = () => {
    setOpen(false);
    dialogRef.current?.close();
  };

  const q = query.trim().toLowerCase();
  const shown = (users ?? []).filter((u) => !q || [u.login, u.displayName, u.leaderName ?? ""].some((v) => v.toLowerCase().includes(q)));

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="font-serif text-3xl font-normal">Пользователи</h1>
          <p className="text-sm text-dim">Кто может войти в приложение и чей кабинет увидит.{users ? ` Всего: ${users.length}.` : ""}</p>
        </div>
        <Button onClick={openDrawer} className="gap-2">
          <UserPlus className="size-4" aria-hidden="true" /> Добавить
        </Button>
      </div>

      {notice ? (
        <p role="status" className="flex items-center gap-2 rounded-lg border border-sage/30 bg-sage/10 px-3 py-2 text-sm text-sage">
          <CheckCircle2 className="size-4" aria-hidden="true" /> {notice}
        </p>
      ) : null}
      {error && !open ? <p role="alert" className="text-sm text-coral">{error}</p> : null}

      <div className="overflow-hidden rounded-xl border border-border bg-raised">
        <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
          <Search className="size-4 text-dim" aria-hidden="true" />
          <input
            aria-label="Поиск пользователей"
            placeholder="Найти по имени, логину или руководителю"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-8 w-full bg-transparent text-sm outline-none placeholder:text-dim/70"
          />
        </div>
        {users === null ? (
          <p className="px-5 py-6 text-sm text-dim">Загружаю…</p>
        ) : shown.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-dim">{users.length === 0 ? "Записей пока нет. Нажмите «Добавить»." : "Ничего не найдено."}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-dim">
                <tr className="border-b border-border">
                  <th className="px-5 py-2.5 font-normal">Пользователь</th>
                  <th className="px-5 py-2.5 font-normal">Роль</th>
                  <th className="px-5 py-2.5 font-normal">Руководитель</th>
                  <th className="px-5 py-2.5 font-normal">Способы входа</th>
                  <th className="px-5 py-2.5 font-normal">Настройки</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((u) => (
                  <tr key={u.id} className="border-b border-border transition-colors last:border-0 hover:bg-background/40">
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-3">
                        <Avatar name={u.displayName} />
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 font-medium">
                            {u.displayName}
                            {u.login === viewerLogin ? <span className="rounded bg-amber/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber">Вы</span> : null}
                          </div>
                          <div className="font-mono text-xs text-dim">{u.login}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-5 py-3">
                      <span className={cn("rounded-full px-2.5 py-0.5 text-xs", u.role === "ADMIN" ? "bg-amber/15 text-amber" : "bg-sage/15 text-sage")}>
                        {u.role === "ADMIN" ? "Администратор" : "Руководитель"}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-soft">{u.leaderName ?? <span className="text-dim">—</span>}</td>
                    <td className="px-5 py-3">
                      <div className="flex flex-wrap gap-1.5">
                        {u.hasPassword ? (
                          <span className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-xs text-soft">
                            <KeyRound className="size-3" aria-hidden="true" /> Пароль
                          </span>
                        ) : null}
                        {u.telegramId ? (
                          <span className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-xs text-soft" title={`Telegram ID ${u.telegramId}`}>
                            <Send className="size-3" aria-hidden="true" /> Telegram
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-5 py-3">
                      {!u.leaderName ? (
                        <span className="text-dim">—</span>
                      ) : resetFor === u.id ? (
                        <div className="flex max-w-xs flex-col gap-2 text-xs text-soft">
                          <span>
                            Вернуть «{u.leaderName}» к первому входу? Будут удалены подключения (почта, календарь, Telegram Business), письма и карточки, выученные правила и доверие по областям; включится режим обучения. Профиль, сотрудники, поручения и встречи останутся. Это не отменить.
                          </span>
                          <div className="flex gap-2">
                            <Button variant="destructive" className="h-8 px-3" disabled={resetting} onClick={() => resetUser(u)}>Да, сбросить</Button>
                            <Button variant="outline" className="h-8 px-3" disabled={resetting} onClick={() => setResetFor(null)}>Отмена</Button>
                          </div>
                        </div>
                      ) : (
                        <Button variant="outline" className="h-8 px-3" onClick={() => setResetFor(u.id)}>Сбросить настройки</Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="overflow-hidden rounded-xl border border-border bg-raised">
        <div className="border-b border-border px-4 py-2.5 text-sm font-medium">Руководители</div>
        {leaders.length === 0 ? (
          <p className="px-5 py-4 text-sm text-dim">Руководителей пока нет.</p>
        ) : (
          <ul>
            {leaders.map((l) => {
              const accounts = (users ?? []).filter((u) => u.leaderId === l.id);
              return (
                <li key={l.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3 last:border-0">
                  <div className="min-w-0">
                    <div className="font-medium">{l.name}</div>
                    <div className="text-xs text-dim">{accounts.length ? `Учётные записи: ${accounts.map((a) => a.login).join(", ")}` : "Без учётных записей"}</div>
                  </div>
                  {deleteFor === l.id ? (
                    <div className="flex max-w-sm flex-col gap-2 text-xs text-soft">
                      <span>
                        Удалить «{l.name}» со всеми данными: сотрудники, письма, карточки, поручения, встречи, подключения и привязки Telegram.
                        {accounts.some((a) => a.role === "LEADER") ? " Учётные записи-руководители этого кабинета тоже будут удалены." : ""} Это не отменить.
                      </span>
                      <div className="flex gap-2">
                        <Button variant="destructive" className="h-8 px-3" disabled={deleting} onClick={() => deleteLeader(l)}>Да, удалить</Button>
                        <Button variant="outline" className="h-8 px-3" disabled={deleting} onClick={() => setDeleteFor(null)}>Отмена</Button>
                      </div>
                    </div>
                  ) : (
                    <Button variant="outline" className="h-8 px-3" onClick={() => setDeleteFor(l.id)}>Удалить руководителя</Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <dialog
        ref={dialogRef}
        onClose={() => setOpen(false)}
        onClick={(e) => e.target === dialogRef.current && closeDrawer()}
        aria-label="Новая учётная запись"
        className="drawer m-0 ml-auto h-dvh max-h-none w-full max-w-md border-l border-border bg-raised p-0 text-foreground backdrop:bg-black/60"
      >
      <form onSubmit={create} className="flex h-full flex-col gap-5 overflow-y-auto p-6">
        <div className="flex items-center justify-between gap-2">
          <div className="flex flex-col">
            <h2 className="font-serif text-xl">Новая учётная запись</h2>
            <span className="text-xs text-dim">Нужен пароль, Telegram ID или оба.</span>
          </div>
          <button type="button" onClick={closeDrawer} aria-label="Закрыть" className="flex size-9 items-center justify-center rounded-lg text-dim transition-colors hover:bg-background hover:text-foreground">
            <X className="size-4" />
          </button>
        </div>
        <div className="grid gap-4">
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
            <select className={INPUT} required={form.role === "LEADER"} value={form.role === "LEADER" || form.leaderId !== NEW_LEADER ? form.leaderId : ""} onChange={(e) => setForm({ ...form, leaderId: e.target.value })}>
              {form.role === "LEADER" ? <option value={NEW_LEADER}>Новый руководитель (чистый кабинет)</option> : <option value="">—</option>}
              {leaders.map((l) => {
                // Один кабинет — одна учётная запись руководителя: занятых показываем, но выбрать нельзя.
                const owner = form.role === "LEADER" ? (users ?? []).find((u) => u.role === "LEADER" && u.leaderId === l.id) : undefined;
                return (
                  <option key={l.id} value={l.id} disabled={Boolean(owner)}>{l.name}{owner ? ` (занят: ${owner.login})` : ""}</option>
                );
              })}
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
        {error && open ? <p role="alert" className="rounded-lg border border-coral/30 bg-coral/10 px-3 py-2 text-sm text-coral">{error}</p> : null}
        <div className="mt-auto flex gap-3 border-t border-border pt-4">
          <Button type="submit" disabled={!form.login || !form.displayName || (!form.password && !form.telegramId)}>Создать</Button>
          <Button type="button" variant="ghost" onClick={closeDrawer}>Отмена</Button>
        </div>
      </form>
      </dialog>
    </section>
  );
}

const SCENARIOS: { id: string; label: string }[] = [
  { id: "INGEST_DATASET", label: "Загрузить датасет" },
  { id: "TRIGGER_MORNING", label: "Утренний план" },
  { id: "TRIGGER_EMAIL_BATCH", label: "Новые письма (демо-пачка)" },
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
