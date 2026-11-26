import { describe, expect, it } from "vitest";
import { Clock, type OffsetStore } from "@/core/clock";

const DEMO_START = new Date("2026-12-07T08:30:00+03:00");

function memoryStore(initial: number | null = null): OffsetStore & { value: number | null } {
  const s = {
    value: initial,
    async get() {
      return s.value;
    },
    async setIfAbsent(v: number) {
      if (s.value === null) s.value = v;
      return s.value;
    },
    async set(v: number) {
      s.value = v;
    },
  };
  return s;
}

function makeClock(store: OffsetStore, real: { t: number }, mode: "demo" | "real" = "demo") {
  return new Clock({
    mode,
    demoStart: DEMO_START,
    realNow: () => real.t,
    storeFactory: async () => store,
  });
}

describe("Clock", () => {
  it("первый запуск: «сейчас» равно APP_DEMO_START", async () => {
    const real = { t: Date.parse("2026-11-26T12:00:00Z") };
    const clock = makeClock(memoryStore(), real);
    await clock.init();
    expect(clock.now().getTime()).toBe(DEMO_START.getTime());
  });

  it("время идёт вместе с реальным", async () => {
    const real = { t: Date.parse("2026-11-26T12:00:00Z") };
    const clock = makeClock(memoryStore(), real);
    await clock.init();
    real.t += 90_000;
    expect(clock.now().getTime()).toBe(DEMO_START.getTime() + 90_000);
  });

  it("второй процесс использует то же смещение из хранилища", async () => {
    const store = memoryStore();
    const real = { t: Date.parse("2026-11-26T12:00:00Z") };
    const a = makeClock(store, real);
    await a.init();
    real.t += 5 * 60_000;
    const b = makeClock(store, real);
    await b.init();
    expect(b.now().getTime()).toBe(a.now().getTime());
  });

  it("advance перематывает время и виден другому процессу после sync", async () => {
    const store = memoryStore();
    const real = { t: Date.parse("2026-11-26T12:00:00Z") };
    const a = makeClock(store, real);
    const b = makeClock(store, real);
    await a.init();
    await b.init();

    await a.advance(60);
    expect(a.now().getTime()).toBe(DEMO_START.getTime() + 60 * 60_000);

    await b.sync();
    expect(b.now().getTime()).toBe(a.now().getTime());
  });

  it("reset возвращает время на старт демо", async () => {
    const real = { t: Date.parse("2026-11-26T12:00:00Z") };
    const clock = makeClock(memoryStore(), real);
    await clock.init();
    await clock.advance(24 * 60);
    real.t += 10_000;
    const now = await clock.reset();
    expect(now.getTime()).toBe(DEMO_START.getTime());
  });

  it("now() до init() в демо-режиме — ошибка, а не тихое реальное время", () => {
    const clock = makeClock(memoryStore(), { t: 0 });
    expect(() => clock.now()).toThrow(/not initialized/);
  });

  it("режим real: смещения нет, advance запрещён", async () => {
    const real = { t: Date.parse("2026-11-26T12:00:00Z") };
    const clock = makeClock(memoryStore(), real, "real");
    expect(clock.now().getTime()).toBe(real.t);
    await expect(clock.advance(10)).rejects.toThrow(/real mode/);
  });
});
