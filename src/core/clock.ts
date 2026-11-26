/**
 * Демо-время (SPEC 4.7). `clock.now() = realNow() + offsetMs`.
 *
 * В бизнес-логике запрещён прямой `new Date()` — только `clock.now()`.
 * Смещение хранится в Redis, чтобы `web` и `worker` видели одно и то же время.
 */

const MINUTE_MS = 60_000;
const DEFAULT_DEMO_START = "2026-12-07T08:30:00+03:00";

export type ClockMode = "demo" | "real";

/** Хранилище смещения, общее для процессов. */
export interface OffsetStore {
  get(): Promise<number | null>;
  /** Записать, только если значения ещё нет. Возвращает фактическое значение. */
  setIfAbsent(value: number): Promise<number>;
  set(value: number): Promise<void>;
}

export interface ClockOptions {
  mode: ClockMode;
  demoStart: Date;
  /** Источник реального времени (в тестах подменяется). */
  realNow?: () => number;
  /** Ленивая фабрика хранилища: Redis подключается только при `init()`. */
  storeFactory?: () => Promise<OffsetStore>;
}

export class Clock {
  private offsetMs: number | null = null;
  private store: OffsetStore | null = null;
  private readonly realNow: () => number;

  constructor(private readonly opts: ClockOptions) {
    this.realNow = opts.realNow ?? Date.now;
    if (opts.mode === "real") this.offsetMs = 0;
  }

  get mode(): ClockMode {
    return this.opts.mode;
  }

  /** Текущее демо-время. До `init()` в режиме demo — ошибка (fail loud, не тихо реальное время). */
  now(): Date {
    if (this.offsetMs === null) {
      throw new Error("Clock is not initialized: call `await clock.init()` before `clock.now()`");
    }
    return new Date(this.realNow() + this.offsetMs);
  }

  /**
   * Загружает смещение из хранилища. При первом запуске считает его так,
   * чтобы «сейчас» = demoStart, и сохраняет (общее для всех процессов).
   */
  async init(): Promise<void> {
    if (this.opts.mode === "real") {
      this.offsetMs = 0;
      return;
    }
    const store = await this.getStore();
    if (!store) {
      this.offsetMs = this.computeInitialOffset();
      return;
    }
    this.offsetMs = await store.setIfAbsent(this.computeInitialOffset());
  }

  /** Подтянуть смещение, изменённое другим процессом (например, перемотка из web). */
  async sync(): Promise<void> {
    if (this.opts.mode === "real") return;
    const store = await this.getStore();
    const stored = store ? await store.get() : null;
    if (stored !== null) this.offsetMs = stored;
  }

  /** Перемотать демо-время вперёд (или назад — отрицательным значением). */
  async advance(minutes: number): Promise<Date> {
    if (this.opts.mode === "real") {
      throw new Error("Clock is in real mode: advance is disabled");
    }
    if (!Number.isFinite(minutes)) throw new Error("advance: minutes must be a finite number");
    await this.sync();
    if (this.offsetMs === null) await this.init();
    const next = (this.offsetMs ?? 0) + minutes * MINUTE_MS;
    await this.persist(next);
    return this.now();
  }

  /** Сбросить время на `demoStart`. */
  async reset(): Promise<Date> {
    if (this.opts.mode === "real") return this.now();
    await this.persist(this.computeInitialOffset());
    return this.now();
  }

  private computeInitialOffset(): number {
    return this.opts.demoStart.getTime() - this.realNow();
  }

  private async persist(offset: number): Promise<void> {
    this.offsetMs = offset;
    const store = await this.getStore();
    if (store) await store.set(offset);
  }

  private async getStore(): Promise<OffsetStore | null> {
    if (this.store) return this.store;
    if (!this.opts.storeFactory) return null;
    this.store = await this.opts.storeFactory();
    return this.store;
  }
}

export function createClockFromEnv(env: NodeJS.ProcessEnv = process.env): Clock {
  const mode: ClockMode = env.APP_CLOCK_MODE === "real" ? "real" : "demo";
  const demoStart = new Date(env.APP_DEMO_START ?? DEFAULT_DEMO_START);
  if (Number.isNaN(demoStart.getTime())) {
    throw new Error(`APP_DEMO_START is not a valid date: ${env.APP_DEMO_START}`);
  }
  return new Clock({
    mode,
    demoStart,
    storeFactory: async () => {
      const { createRedisOffsetStore } = await import("./clock-redis");
      return createRedisOffsetStore();
    },
  });
}

/** Процессный синглтон. Вызовите `await clock.init()` при старте web/worker. */
const globalForClock = globalThis as unknown as { __clock?: Clock };
export const clock: Clock = (globalForClock.__clock ??= createClockFromEnv());
