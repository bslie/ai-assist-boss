import { describe, expect, it } from "vitest";
import { createActivityTracker } from "@/core/worker-activity";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup(delayMs = 20) {
  const log: [string, string | null][] = [];
  const run = createActivityTracker(async (leaderId, label) => void log.push([leaderId, label]), delayMs);
  return { log, run };
}

describe("worker activity", () => {
  it("быстрая задача ничего не публикует", async () => {
    const { log, run } = setup();
    await expect(run("L1", "Проверяю почту", async () => 42)).resolves.toBe(42);
    await sleep(40);
    expect(log).toEqual([]);
  });

  it("долгая задача показывается, а по окончании сбрасывается", async () => {
    const { log, run } = setup();
    await run("L1", "Проверяю почту", () => sleep(60));
    expect(log).toEqual([["L1", "Проверяю почту"], ["L1", null]]);
  });

  it("сбой задачи тоже сбрасывает фразу и не глотается", async () => {
    const { log, run } = setup();
    await expect(run("L1", "Проверяю почту", async () => { await sleep(40); throw new Error("boom"); })).rejects.toThrow("boom");
    expect(log.at(-1)).toEqual(["L1", null]);
  });

  it("параллельные задачи: показывается свежая, пусто — когда все закончились", async () => {
    const { log, run } = setup();
    await Promise.all([run("L1", "Проверяю почту", () => sleep(120)), (async () => { await sleep(40); await run("L1", "Собираю протокол", () => sleep(30)); })()]);
    expect(log.map((x) => x[1])).toEqual(["Проверяю почту", "Собираю протокол", "Проверяю почту", null]);
  });

  it("руководители не видят чужих задач", async () => {
    const { log, run } = setup();
    await Promise.all([run("L1", "Проверяю почту", () => sleep(60)), run("L2", "Собираю протокол", () => sleep(60))]);
    expect(log.filter((x) => x[0] === "L1").map((x) => x[1])).toEqual(["Проверяю почту", null]);
    expect(log.filter((x) => x[0] === "L2").map((x) => x[1])).toEqual(["Собираю протокол", null]);
  });
});
