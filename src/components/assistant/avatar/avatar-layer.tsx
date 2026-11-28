"use client";

import { useEffect, useRef, useState } from "react";
import { AvatarArt, type Accessory, type Mood, type Pose } from "./avatar-art";
import { AVATAR_EVENT, SCENE_IDS, avatarCommand, type AvatarCommand, type SceneId } from "./avatar-bus";
import { renderSceneProps } from "./avatar-scenes";
import { collectAvoid, findSafeSpot, overlapAt, type Vec } from "./avoid";
import { DemoMenu } from "./demo-menu";

const SIZE = 128; // px, квадрат
const HALF = SIZE * 0.34; // видимая половина тела: по ней считаем, что он закрывает
const MARGIN = 28;
const IDLE_AFTER_MS = 5 * 60_000; // столько тишины, и считаем, что человек отошёл
const STATUS_MIN_MS = 2_500; // фраза воркера висит не меньше, чтобы её успели прочитать
const STATUS_MAX_MS = 3 * 60_000; // воркер мог упасть, не сняв фразу: сами её убираем
const GAP_MS: [number, number] = [20_000, 45_000]; // пауза между сценками
const STORAGE_KEY = "avatar:enabled";

// Формы тела: [растяжение по X, по Y]. Масштаб считается от «пола» (низ капли).
const SHAPES = {
  normal: [1, 1],
  puddle: [1.6, 0.36],
  tall: [0.86, 1.2],
  squish: [1.3, 0.78],
  small: [0.55, 0.55],
} as const;
type ShapeName = keyof typeof SHAPES;

type View = { scene: SceneId | null; leaving: boolean; acc: Accessory; pose: Pose; live: boolean };
const NO_VIEW: View = { scene: null, leaving: false, acc: "none", pose: "none", live: false };

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}
function rand(a: number, b: number): number {
  return a + Math.random() * (b - a);
}

// Центр персонажа удерживаем внутри окна.
function clampPos(p: Vec): Vec {
  const half = SIZE / 2 + 6;
  return {
    x: clamp(p.x, half, window.innerWidth - half),
    y: clamp(p.y, half, window.innerHeight - half),
  };
}

function homePos(): Vec {
  return { x: window.innerWidth - SIZE / 2 - MARGIN, y: window.innerHeight - SIZE / 2 - MARGIN };
}

function inside(p: Vec | null, r: DOMRect): boolean {
  return !!p && p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;
}

// Слой поверх интерфейса. Главные правила:
//  1. Пока пользователь работает, персонаж неподвижен (только редкое моргание).
//  2. Он никогда не перехватывает клики и фокус, обходит текст и кнопки, прячется за модалками.
//  3. Если человек отошёл (IDLE_AFTER_MS без мыши, клавиатуры, кликов и прокрутки), он играет сценки
//     с реквизитом. Любое действие пользователя мгновенно сворачивает сценку.
export function AvatarLayer({ leaderId, demo = false, isAdmin = false }: { leaderId?: string; /** Демо-стенд: клик по маскоту открывает меню управления демо. */ demo?: boolean; /** Администратор: в меню есть демо-часы (они общие для всех). */ isAdmin?: boolean }) {
  const [mounted, setMounted] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // Чем сейчас занят воркер: пока фраза есть, маскот сидит с ноутбуком и подписывает, что делает.
  const [status, setStatus] = useState<string | null>(null);
  const isWorking = status !== null;
  const working = useRef(false);
  const [enabled, setEnabled] = useState(true);
  const [mood, setMood] = useState<Mood>("idle");
  const [view, setView] = useState<View>(NO_VIEW);
  const [bubble, setBubble] = useState<{ text: string; left: boolean; below: boolean } | null>(null);

  const boxRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const shapeRef = useRef<HTMLDivElement>(null);
  const gooRef = useRef<HTMLDivElement>(null);
  const bfRef = useRef<HTMLDivElement>(null);

  // Включение/выключение и первый показ.
  useEffect(() => {
    const raf = window.requestAnimationFrame(() => {
      let on = true;
      try {
        on = window.localStorage.getItem(STORAGE_KEY) !== "0";
      } catch {
        /* localStorage может быть недоступен */
      }
      setEnabled(on);
      setMounted(true);
    });
    const onCmd = (e: Event) => {
      const c = (e as CustomEvent<AvatarCommand>).detail;
      if (c.type !== "enable") return;
      setEnabled(c.on);
      try {
        window.localStorage.setItem(STORAGE_KEY, c.on ? "1" : "0");
      } catch {
        /* ignore */
      }
    };
    window.addEventListener(AVATAR_EVENT, onCmd);
    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener(AVATAR_EVENT, onCmd);
    };
  }, []);

  // Фраза воркера: событие worker.activity по SSE плюс разовый запрос, чтобы увидеть задачу, начатую до открытия страницы.
  useEffect(() => {
    if (!mounted || !enabled || !leaderId) return;
    let shownAt = 0;
    let hideTimer = 0;
    let maxTimer = 0;
    const apply = (label: string | null) => {
      window.clearTimeout(hideTimer);
      if (label) {
        if (!shownAt) shownAt = Date.now();
        setStatus(label);
        window.clearTimeout(maxTimer);
        maxTimer = window.setTimeout(() => {
          shownAt = 0;
          setStatus(null);
        }, STATUS_MAX_MS);
        return;
      }
      hideTimer = window.setTimeout(() => {
        shownAt = 0;
        window.clearTimeout(maxTimer);
        setStatus(null);
      }, Math.max(0, STATUS_MIN_MS - (Date.now() - shownAt)));
    };
    const q = encodeURIComponent(leaderId);
    fetch(`/api/worker/status?leaderId=${q}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { label?: string | null } | null) => {
        if (j?.label) apply(j.label);
      })
      .catch(() => {});
    const es = new EventSource(`/api/stream?leaderId=${q}`);
    es.addEventListener("worker.activity", (e) => {
      try {
        const d = JSON.parse((e as MessageEvent<string>).data) as { label?: unknown };
        apply(typeof d.label === "string" && d.label ? d.label : null);
      } catch {
        /* битое событие индикатору не нужно */
      }
    });
    return () => {
      es.close();
      window.clearTimeout(hideTimer);
      window.clearTimeout(maxTimer);
    };
  }, [mounted, enabled, leaderId]);

  // Воркер начал работу: маскот возвращается на стоянку (сценки в простое на это время не играют).
  useEffect(() => {
    working.current = isWorking;
    if (isWorking) avatarCommand({ type: "home" });
  }, [isWorking]);

  // Контроллер: физика, сценки, реакции на активность. Вся изменяемая кухня живёт в замыкании.
  useEffect(() => {
    if (!mounted || !enabled) return;
    const box = boxRef.current;
    const body = bodyRef.current;
    const shapeEl = shapeRef.current;
    const goo = gooRef.current;
    const bfEl = bfRef.current;
    if (!box || !body || !shapeEl || !goo || !bfEl) return;

    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    let reduced = mq.matches;
    const onMq = () => {
      reduced = mq.matches;
    };
    mq.addEventListener("change", onMq);

    const timers: number[] = [];
    const later = (fn: () => void, ms: number): number => {
      const id = window.setTimeout(fn, ms);
      timers.push(id);
      return id;
    };

    // ----- состояние -----
    const s = { x: 0, y: 0, vx: 0, vy: 0, tx: 0, ty: 0, settled: true, lx: 0, ly: 0 };
    const sh = { sx: 1, sy: 1, rot: 0, vsx: 0, vsy: 0, vrot: 0, tsx: 1, tsy: 1, trot: 0 };
    let onArrive: (() => void) | null = null;
    let bump = 0;
    let cursor: Vec | null = null;
    let atHome = true;
    let transient: number | null = null;
    let curMood: Mood = "idle";
    let lastActive = performance.now();
    let stayUntil = 0;
    let nextScene = 0;
    let lastScene: SceneId | null = null;
    let sceneTok = 0;
    let sceneBusy = false;
    let gaze: Vec | null = null;
    let floating = false; // парение разрешено только внутри сценки
    let opacity = 0; // плавно проявляется при появлении
    let restOpacity = 1; // если свободного места нет и она что-то прикрывает, остаётся полупрозрачной
    let gooEl: HTMLElement | null = null;
    let gooOrigin: Vec = { x: 0, y: 0 };
    let spreadTimer: number | null = null;
    let spreadToken = 0;
    const bf = { mode: "off" as "off" | "fly" | "land" | "leave", t: 0, x: 0, y: 0 };

    // ----- настроение и форма -----
    const applyMood = (m: Mood) => {
      curMood = m;
      setMood(m);
    };
    const flash = (m: Mood, ms: number) => {
      if (transient !== null) window.clearTimeout(transient);
      applyMood(m);
      transient = window.setTimeout(() => {
        transient = null;
        applyMood("idle");
      }, ms);
    };
    const patchView = (p: Partial<View>) => setView((v) => ({ ...v, ...p }));
    const setShape = (name: ShapeName) => {
      sh.tsx = SHAPES[name][0];
      sh.tsy = SHAPES[name][1];
    };
    const stay = (ms: number) => {
      stayUntil = performance.now() + ms;
    };

    // ----- движение -----
    const safe = (desired: Vec, radius: number): Vec => findSafeSpot(desired, collectAvoid(), HALF, clampPos, radius);
    const flyTo = (target: Vec, then?: () => void) => {
      const t = clampPos(target);
      s.tx = t.x;
      s.ty = t.y;
      s.settled = false;
      onArrive = then ?? null;
    };
    // Стоянка: место рядом с углом, где закрывается минимум интерфейса.
    const park = (instant = false) => {
      atHome = true;
      const p = clampPos(safe(homePos(), 280));
      restOpacity = overlapAt(p.x, p.y, HALF, collectAvoid()) > 300 ? 0.55 : 1;
      if (instant) {
        s.x = s.tx = p.x;
        s.y = s.ty = p.y;
        s.vx = s.vy = 0;
        s.settled = true;
      } else {
        flyTo(p);
      }
    };
    const say = (text: string) => {
      setBubble({ text, left: s.x > window.innerWidth / 2, below: s.y < 130 });
      const talkMs = clamp(text.length * 55, 900, 6000);
      flash("talk", talkMs);
      later(() => setBubble((b) => (b && b.text === text ? null : b)), talkMs + 2500);
    };

    // ----- «растекание» подсветкой по элементу -----
    const placeGoo = (r: DOMRect) => {
      goo.style.left = `${r.left}px`;
      goo.style.top = `${r.top}px`;
      goo.style.width = `${r.width}px`;
      goo.style.height = `${r.height}px`;
    };
    const startGoo = (el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      goo.style.display = "block";
      goo.style.borderRadius = window.getComputedStyle(el).borderRadius || "12px";
      placeGoo(r);
      const ox = clamp(s.x - r.left, 0, r.width);
      const oy = clamp(s.y - r.top, 0, r.height);
      gooOrigin = { x: ox, y: oy };
      const maxR = Math.hypot(r.width, r.height) * 1.1 + 40;
      goo.style.transition = "none";
      goo.style.clipPath = `circle(0px at ${ox}px ${oy}px)`;
      void goo.offsetWidth;
      goo.style.transition = reduced ? "none" : "clip-path .7s cubic-bezier(.3,.7,.2,1)";
      goo.style.clipPath = `circle(${maxR}px at ${ox}px ${oy}px)`;
      gooEl = el;
    };
    const endSpread = () => {
      spreadToken++;
      if (spreadTimer !== null) {
        window.clearTimeout(spreadTimer);
        spreadTimer = null;
      }
      if (!gooEl) return;
      gooEl = null;
      goo.style.transition = reduced ? "none" : "clip-path .4s ease-in";
      goo.style.clipPath = `circle(0px at ${gooOrigin.x}px ${gooOrigin.y}px)`;
      later(() => {
        if (!gooEl) goo.style.display = "none";
      }, 460);
      setShape("normal");
      bump = 1;
      stay(2500);
    };
    const perchFor = (el: HTMLElement): Vec => {
      const r = el.getBoundingClientRect();
      const d: Vec = { x: r.right - SIZE * 0.35, y: r.top - SIZE * 0.42 };
      return d.y < HALF + 8 ? { x: d.x, y: r.bottom + SIZE * 0.42 } : d;
    };
    const spreadOver = (el: HTMLElement, text?: string, hold = 2400) => {
      endSpread();
      const tok = ++spreadToken;
      atHome = false;
      flyTo(safe(perchFor(el), 160), () => {
        if (tok !== spreadToken) return;
        setShape("puddle");
        later(() => {
          if (tok !== spreadToken) return;
          startGoo(el);
          setShape("small");
        }, 240);
        if (text) say(text);
        const talk = text ? clamp(text.length * 55, 900, 6000) + 1000 : 0;
        spreadTimer = window.setTimeout(() => {
          spreadTimer = null;
          endSpread();
        }, 240 + Math.max(hold, talk));
        stay(hold + talk + 3500);
      });
    };

    // Осознанная команда приложения: подойти к элементу (с подсветкой или без).
    const goToAnchor = (id: string, text?: string, spread?: boolean) => {
      const el = document.querySelector<HTMLElement>(`[data-avatar-anchor="${CSS.escape(id)}"]`);
      if (!el) {
        if (text) say(text);
        return;
      }
      const go = () => {
        if (spread) {
          spreadOver(el, text);
          return;
        }
        const r = el.getBoundingClientRect();
        let x = r.left - SIZE * 0.55;
        if (x < HALF + 8) x = r.right + SIZE * 0.55;
        atHome = false;
        flyTo(safe({ x, y: r.top + r.height / 2 }, 140), () => {
          flash("happy", 1400);
          bump = 1;
          if (text) say(text);
          stay(6000);
        });
      };
      const r0 = el.getBoundingClientRect();
      if (r0.bottom < 0 || r0.top > window.innerHeight) {
        el.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" });
        later(go, 500);
      } else {
        go();
      }
    };

    // ----- сценки -----
    const wait = (ms: number, tok: number) =>
      new Promise<boolean>((res) => {
        later(() => res(tok === sceneTok), ms);
      });
    const flyAwait = (target: Vec, tok: number) =>
      new Promise<boolean>((res) => {
        let done = false;
        const fin = () => {
          if (done) return;
          done = true;
          res(tok === sceneTok);
        };
        flyTo(target, fin);
        later(fin, 6000);
      });
    const until = (ms: number) => performance.now() + ms;

    const pickText = (): HTMLElement | null => {
      const nodes = Array.from(document.querySelectorAll<HTMLElement>("p, h1, h2, h3, li, [data-avatar-anchor]"));
      const ok = nodes.filter((el) => {
        if (el.closest(".avatar-layer, .avatar-goo")) return false;
        const r = el.getBoundingClientRect();
        return (
          r.width > 180 && r.height > 18 && r.height < 260 && r.top > 70 && r.bottom < window.innerHeight - 40 &&
          r.left >= 0 && r.right <= window.innerWidth && !inside(cursor, r)
        );
      });
      return ok.length ? ok[Math.floor(Math.random() * ok.length)] : null;
    };

    const scenes: Record<SceneId, (tok: number) => Promise<void>> = {
      // привёл друзей, мини-тусовка у нижнего края экрана
      party: async (tok) => {
        const stage = { x: window.innerWidth * 0.5, y: window.innerHeight - SIZE / 2 - 70 };
        if (!(await flyAwait(stage, tok))) return;
        floating = false;
        patchView({ scene: "party", acc: "partyhat", pose: "none", live: true, leaving: false });
        applyMood("happy");
        const end = until(rand(24_000, 36_000));
        while (performance.now() < end) {
          s.vy = -460;
          if (!(await wait(760, tok))) return;
          bump = 0.9;
        }
      },

      // уснул прямо на стоянке: лужица, подушка, колпак
      sleep: async (tok) => {
        patchView({ scene: "sleep", acc: "nightcap", pose: "none", live: false, leaving: false });
        applyMood("sleepy");
        setShape("puddle");
        if (!(await wait(rand(30_000, 55_000), tok))) return;
        setShape("tall");
        s.vy = -300;
        patchView({ acc: "none", scene: null });
        applyMood("happy");
        await wait(800, tok);
      },

      // изучает абзац на странице: идёт к тексту, подсвечивает его, читает глазами строки
      study: async (tok) => {
        const el = pickText();
        if (!el) return;
        atHome = false;
        if (!(await flyAwait(safe(perchFor(el), 160), tok))) return;
        startGoo(el);
        patchView({ scene: "study", acc: "glasses", pose: "none", live: true, leaving: false });
        applyMood("idle");
        const end = until(rand(16_000, 24_000));
        let line = 0;
        while (performance.now() < end) {
          gaze = { x: -5, y: -2 + (line % 4) * 1.6 };
          if (!(await wait(550, tok))) return;
          gaze = { x: 5, y: -2 + (line % 4) * 1.6 };
          if (!(await wait(550, tok))) return;
          line++;
        }
        flash("happy", 1200);
        await wait(1400, tok);
      },

      // программирует: ноутбук, наушники, периодически «баг» и «починила»
      code: async (tok) => {
        patchView({ scene: "code", acc: "headphones", pose: "type", live: true, leaving: false });
        applyMood("idle");
        const end = until(rand(24_000, 38_000));
        while (performance.now() < end) {
          gaze = { x: rand(-3, 3), y: 4 };
          if (!(await wait(900, tok))) return;
        }
      },

      // кофе-пауза: кружка, пар, глоток
      coffee: async (tok) => {
        patchView({ scene: "coffee", acc: "none", pose: "none", live: true, leaving: false });
        applyMood("idle");
        const end = until(rand(20_000, 30_000));
        while (performance.now() < end) {
          if (!(await wait(3600, tok))) return;
          flash("happy", 1500); // на глотке жмурится от удовольствия
          if (!(await wait(2400, tok))) return;
        }
      },

      // жонглирует тремя шариками
      juggle: async (tok) => {
        patchView({ scene: "juggle", acc: "none", pose: "juggle", live: true, leaving: false });
        applyMood("idle");
        const end = until(rand(18_000, 26_000));
        while (performance.now() < end) {
          gaze = { x: -4, y: -3 };
          if (!(await wait(600, tok))) return;
          gaze = { x: 4, y: -3 };
          if (!(await wait(600, tok))) return;
        }
        flash("happy", 1200);
        await wait(1300, tok);
      },

      // зарядка: гантели, повязка, пот, тело приседает в ритм
      workout: async (tok) => {
        patchView({ scene: "workout", acc: "sweatband", pose: "lift", live: true, leaving: false });
        applyMood("idle");
        const end = until(rand(16_000, 22_000));
        while (performance.now() < end) {
          setShape("squish");
          if (!(await wait(800, tok))) return;
          setShape("tall");
          if (!(await wait(800, tok))) return;
        }
        setShape("normal");
        flash("happy", 1200);
        await wait(1300, tok);
      },

      // гоняется за бабочкой по экрану, потом бабочка садится ей на макушку
      butterfly: async (tok) => {
        bf.mode = "fly";
        bf.t = 0;
        bf.x = window.innerWidth + 40;
        bf.y = window.innerHeight * 0.3;
        bfEl.style.display = "block";
        atHome = false;
        patchView({ scene: "butterfly", acc: "none", pose: "none", live: true, leaving: false });
        applyMood("happy");
        const end = until(rand(11_000, 15_000));
        while (performance.now() < end) {
          flyTo({ x: bf.x - 30, y: bf.y + 70 });
          if (!(await wait(450, tok))) return;
        }
        bf.mode = "land";
        flyTo({ x: s.x, y: s.y });
        applyMood("idle");
        gaze = { x: 0, y: -5 };
        if (!(await wait(5000, tok))) return;
        bf.mode = "leave";
        gaze = null;
        applyMood("happy");
        await wait(2200, tok);
      },

      // фокус: волшебная палочка, кролик из шляпы
      magic: async (tok) => {
        patchView({ scene: "magic", acc: "bowtie", pose: "wand", live: true, leaving: false });
        applyMood("happy");
        const end = until(rand(20_000, 30_000));
        while (performance.now() < end) {
          if (!(await wait(3500, tok))) return;
        }
      },
    };

    // Свернуть сценку и тихо вернуться на стоянку. Вызывается и при естественном завершении.
    const endScene = () => {
      const tok = ++sceneTok;
      sceneBusy = false;
      floating = false;
      gaze = null;
      bf.mode = "off";
      bfEl.style.display = "none";
      endSpread();
      setShape("normal");
      const k = Math.round(sh.rot / 360);
      sh.rot -= 360 * k;
      sh.trot -= 360 * k;
      if (transient !== null) {
        window.clearTimeout(transient);
        transient = null;
      }
      applyMood("idle");
      patchView({ leaving: true, acc: "none", pose: "none", live: false });
      later(() => {
        if (tok === sceneTok) setView(NO_VIEW);
      }, 320);
      park();
      nextScene = performance.now() + rand(GAP_MS[0], GAP_MS[1]);
    };

    const startScene = (id: SceneId) => {
      if (sceneBusy) endScene();
      const tok = ++sceneTok;
      sceneBusy = true;
      lastScene = id;
      restOpacity = 1;
      floating = true;
      scenes[id](tok)
        .catch(() => undefined)
        .finally(() => {
          if (sceneTok === tok) endScene();
        });
    };

    const pickScene = (): SceneId => {
      const pool = SCENE_IDS.filter((id) => id !== lastScene);
      return pool[Math.floor(Math.random() * pool.length)];
    };

    // ----- активность пользователя: любое действие сворачивает сценку -----
    const onActive = () => {
      lastActive = performance.now();
      if (sceneBusy) endScene();
    };
    const onMove = (e: PointerEvent) => {
      // синтетические движения без смещения (перестройка раскладки) за активность не считаем
      if (cursor && Math.hypot(e.clientX - cursor.x, e.clientY - cursor.y) < 3) return;
      cursor = { x: e.clientX, y: e.clientY };
      onActive();
      if (gooEl && inside(cursor, gooEl.getBoundingClientRect())) endSpread();
    };
    const onResize = () => {
      if (sceneBusy) endScene();
      else if (atHome) park(true);
    };
    const onCommand = (e: Event) => {
      const cmd = (e as CustomEvent<AvatarCommand>).detail;
      if (cmd.type === "enable") return;
      if (cmd.type === "play") {
        startScene(cmd.scene);
        return;
      }
      if (sceneBusy) endScene();
      if (cmd.type === "goto") goToAnchor(cmd.anchor, cmd.say, cmd.spread);
      else if (cmd.type === "say") say(cmd.text);
      else if (cmd.type === "wave") {
        flash("happy", 1400);
        bump = 1;
      } else if (cmd.type === "home") {
        endSpread();
        park();
      }
    };

    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerdown", onActive, { passive: true });
    window.addEventListener("wheel", onActive, { passive: true });
    window.addEventListener("touchstart", onActive, { passive: true });
    document.addEventListener("keydown", onActive, true);
    document.addEventListener("input", onActive, true);
    window.addEventListener("resize", onResize);
    window.addEventListener(AVATAR_EVENT, onCommand);

    // ----- физика и отрисовка -----
    const K = 58; // жёсткость полёта
    const C = 2 * Math.sqrt(K) * 0.6; // лёгкий перелёт
    const KS = 170; // жёсткость формы
    const CS = 2 * Math.sqrt(KS) * 0.32; // форма пружинит заметно
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;

      if (reduced) {
        s.x = s.tx;
        s.y = s.ty;
        s.vx = 0;
        s.vy = 0;
        sh.sx = sh.tsx;
        sh.sy = sh.tsy;
        sh.rot = sh.trot;
      } else {
        s.vx += ((s.tx - s.x) * K - s.vx * C) * dt;
        s.vy += ((s.ty - s.y) * K - s.vy * C) * dt;
        s.x += s.vx * dt;
        s.y += s.vy * dt;
        sh.vsx += ((sh.tsx - sh.sx) * KS - sh.vsx * CS) * dt;
        sh.vsy += ((sh.tsy - sh.sy) * KS - sh.vsy * CS) * dt;
        sh.vrot += ((sh.trot - sh.rot) * 60 - sh.vrot * 11) * dt;
        sh.sx += sh.vsx * dt;
        sh.sy += sh.vsy * dt;
        sh.rot += sh.vrot * dt;
      }

      const speed = Math.hypot(s.vx, s.vy);
      const dist = Math.hypot(s.tx - s.x, s.ty - s.y);
      if (!s.settled && dist < 4 && speed < 14) {
        s.settled = true;
        const cb = onArrive;
        onArrive = null;
        cb?.();
      }

      // курсор рядом и сценки нет: просто бледнеем (двигаться не двигаемся)
      let nearCursor = false;
      if (cursor && !sceneBusy) nearCursor = Math.hypot(cursor.x - s.x, cursor.y - s.y) < 120;
      opacity += ((nearCursor ? 0.35 : restOpacity) - opacity) * Math.min(1, dt * 6);
      box.style.opacity = opacity.toFixed(2);

      // позиция; парение только внутри сценки
      const t = now / 1000;
      const fx = floating && !reduced ? Math.sin(t * 0.8) * 3 : 0;
      const fy = floating && !reduced ? Math.sin(t * 1.3) * 4 : 0;
      box.style.transform = `translate3d(${(s.x - SIZE / 2 + fx).toFixed(1)}px, ${(s.y - SIZE / 2 + fy).toFixed(1)}px, 0)`;

      // желе: вытягивание вдоль скорости, наклон, «пружинка» от реакций
      bump *= Math.exp(-dt * 7);
      const stretch = Math.min(speed / 2400, 0.26);
      const angle = (Math.atan2(s.vy, s.vx) * 180) / Math.PI;
      const lean = clamp(s.vx / 32, -14, 14);
      const pop = bump * Math.sin(now / 55) * 0.08 + bump * 0.06;
      const sx = 1 + stretch - pop;
      const sy = 1 - stretch * 0.75 + pop;
      body.style.transform = `rotate(${lean.toFixed(1)}deg) rotate(${angle.toFixed(1)}deg) scale(${sx.toFixed(3)}, ${sy.toFixed(3)}) rotate(${(-angle).toFixed(1)}deg) rotate(${sh.rot.toFixed(1)}deg)`;
      shapeEl.style.transform = `scale(${sh.sx.toFixed(3)}, ${sh.sy.toFixed(3)})`;

      if (gooEl) placeGoo(gooEl.getBoundingClientRect());

      // бабочка
      if (bf.mode !== "off") {
        bf.t += dt;
        let tx: number;
        let ty: number;
        let rate = 4;
        if (bf.mode === "fly") {
          const cx = window.innerWidth * 0.5;
          const cy = window.innerHeight * 0.5;
          const ax = Math.min(380, window.innerWidth * 0.32);
          const ay = Math.min(170, window.innerHeight * 0.22);
          tx = cx + ax * Math.cos(bf.t * 0.9);
          ty = cy + ay * Math.sin(bf.t * 1.5);
        } else if (bf.mode === "land") {
          tx = s.x + 4;
          ty = s.y - 56;
          rate = 6;
        } else {
          tx = window.innerWidth + 120;
          ty = -80;
          rate = 1.6;
        }
        bf.x += (tx - bf.x) * Math.min(1, dt * rate);
        bf.y += (ty - bf.y) * Math.min(1, dt * rate);
        bfEl.style.transform = `translate3d(${(bf.x - 18).toFixed(1)}px, ${(bf.y - 15).toFixed(1)}px, 0)`;
      }

      // взгляд: только по сценке (за курсором не следим, чтобы не отвлекать)
      let gx = 0;
      let gy = 0;
      if (curMood === "sleepy") {
        gx = 0;
        gy = 0;
      } else if (bf.mode === "fly") {
        const dx = bf.x - s.x;
        const dy = bf.y - s.y;
        const d = Math.hypot(dx, dy) || 1;
        gx = (dx / d) * 5;
        gy = (dy / d) * 5;
      } else if (gaze) {
        gx = gaze.x;
        gy = gaze.y;
      }
      const ease = Math.min(1, dt * 10);
      s.lx += (gx - s.lx) * ease;
      s.ly += (gy - s.ly) * ease;
      box.style.setProperty("--lx", s.lx.toFixed(2));
      box.style.setProperty("--ly", s.ly.toFixed(2));

      raf = window.requestAnimationFrame(tick);
    };

    // старт: сразу встаёт на стоянку и тихо проявляется, без полётов
    park(true);
    box.style.transform = `translate3d(${s.x - SIZE / 2}px, ${s.y - SIZE / 2}px, 0)`;
    box.style.opacity = "0";
    raf = window.requestAnimationFrame(tick);

    // ----- «жизнь»: модалки, возврат после команд, запуск сценок в простое -----
    const life = window.setInterval(() => {
      const now = performance.now();
      const modal = !!document.querySelector("dialog[open], [role='dialog'], [aria-modal='true']");
      box.style.visibility = modal ? "hidden" : "visible";
      if (modal) {
        if (sceneBusy) endScene();
        return;
      }
      if (document.hidden) return;

      // вернуться на стоянку после осознанной команды приложения
      if (!sceneBusy && !atHome && s.settled && now > stayUntil) park();

      // человек отошёл: время для сценки
      if (!reduced && !sceneBusy && !working.current && atHome && now - lastActive > IDLE_AFTER_MS && now > nextScene) {
        startScene(pickScene());
      }
    }, 500);

    return () => {
      window.cancelAnimationFrame(raf);
      window.clearInterval(life);
      timers.forEach((id) => window.clearTimeout(id));
      if (transient !== null) window.clearTimeout(transient);
      if (spreadTimer !== null) window.clearTimeout(spreadTimer);
      sceneTok++;
      mq.removeEventListener("change", onMq);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerdown", onActive);
      window.removeEventListener("wheel", onActive);
      window.removeEventListener("touchstart", onActive);
      document.removeEventListener("keydown", onActive, true);
      document.removeEventListener("input", onActive, true);
      window.removeEventListener("resize", onResize);
      window.removeEventListener(AVATAR_EVENT, onCommand);
    };
  }, [mounted, enabled]);

  if (!mounted || !enabled) return null;

  // Пока воркер занят, маскот сидит с ноутбуком и наушниками (как в сценке «code»); сценки простоя его не трогают.
  const workLook = !view.scene && isWorking;
  const props = view.scene ? renderSceneProps(view.scene) : workLook ? renderSceneProps("code") : null;
  const stageCls = view.leaving ? "avp-stage avp-leaving" : "avp-stage";

  return (
    <>
      {/* Экранным дикторам: маскот скрыт от них, а чем занят помощник, сообщаем здесь. */}
      <div role="status" className="sr-only">
        {status ?? ""}
      </div>
      <div
        ref={gooRef}
        className="avatar-goo"
        aria-hidden="true"
        style={{ position: "fixed", display: "none", zIndex: 29, pointerEvents: "none" }}
      />
      <div ref={bfRef} className="avatar-butterfly" aria-hidden="true">
        <svg width="36" height="30" viewBox="0 0 36 30">
          <g className="avb-l">
            <path d="M18 14 C12 2 2 2 3 12 C4 20 12 20 18 16Z" fill="#7C8BFF" />
            <path d="M18 16 C12 22 8 28 12 28 C16 28 18 22 18 16Z" fill="#C77DFF" />
          </g>
          <g className="avb-r">
            <path d="M18 14 C24 2 34 2 33 12 C32 20 24 20 18 16Z" fill="#7C8BFF" />
            <path d="M18 16 C24 22 28 28 24 28 C20 28 18 22 18 16Z" fill="#C77DFF" />
          </g>
          <rect x="17" y="9" width="2" height="14" rx="1" fill="#3A3F52" />
        </svg>
      </div>
      <div
        ref={boxRef}
        className="avatar-layer"
        aria-hidden="true"
        style={{
          position: "fixed",
          left: 0,
          top: 0,
          width: SIZE,
          height: SIZE,
          zIndex: 30,
          pointerEvents: "none",
          willChange: "transform, opacity",
        }}
      >
        {props && <div className={stageCls}>{props.back}</div>}
        {bubble && (
          <div
            role="presentation"
            className="avatar-bubble"
            style={{
              position: "absolute",
              [bubble.below ? "top" : "bottom"]: "100%",
              [bubble.left ? "right" : "left"]: 0,
              width: "max-content",
              maxWidth: 260,
              margin: "2px 0",
              padding: "8px 12px",
              borderRadius: 14,
              background: "#fff",
              color: "#1f2533",
              fontSize: 13,
              lineHeight: 1.35,
              boxShadow: "0 4px 18px rgba(0,0,0,.25)",
            }}
          >
            {bubble.text}
          </div>
        )}
        {status && (
          <div
            role="presentation"
            className="avatar-status"
            style={{
              position: "absolute",
              top: "50%",
              right: "100%",
              transform: "translateY(-50%)",
              marginRight: 4,
              display: "flex",
              alignItems: "center",
              gap: 8,
              width: "max-content",
              maxWidth: 240,
              padding: "7px 12px",
              borderRadius: 999,
              background: "rgba(255,255,255,.94)",
              color: "#1f2533",
              fontSize: 12.5,
              lineHeight: 1.2,
              boxShadow: "0 4px 18px rgba(0,0,0,.25)",
            }}
          >
            <span className="avatar-status-dot" />
            {status}
          </div>
        )}
        <div
          ref={bodyRef}
          data-demo-trigger={demo ? "" : undefined}
          onClick={demo ? () => setMenuOpen((o) => !o) : undefined}
          style={{ width: "100%", height: "100%", ...(demo ? { pointerEvents: "auto" as const, cursor: "pointer" } : {}) }}
        >
          <div ref={shapeRef} style={{ width: "100%", height: "100%", transformOrigin: "50% 88%" }}>
            <AvatarArt mood={mood} live={view.live || workLook} acc={workLook ? "headphones" : view.acc} pose={workLook ? "type" : view.pose} />
          </div>
        </div>
        {props && <div className={stageCls}>{props.front}</div>}
      </div>
      {demo && menuOpen && leaderId && <DemoMenu leaderId={leaderId} isAdmin={isAdmin} onClose={() => setMenuOpen(false)} />}
    </>
  );
}
