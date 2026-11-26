"use client";

import { useEffect, useRef, useState } from "react";
import { AvatarArt, type Accessory, type Mood, type Pose } from "@/components/assistant/avatar/avatar-art";
import { renderSceneProps } from "@/components/assistant/avatar/avatar-scenes";
import type { SceneId } from "@/components/assistant/avatar/avatar-bus";
import "./login-scene.css";

// Размер должен совпадать с квадратом, под который нарисован реквизит сценок (128x128).
const SIZE = 128;
const HALF = SIZE / 2;
const PAD = 12;

type Pt = { x: number; y: number };
type Rect = { l: number; t: number; r: number; b: number };
type Look = { mood: Mood; pose: Pose; acc: Accessory; live: boolean; scene: SceneId | null; say?: string };

// Те же сценки, что у основного аватара. ext — сколько места нужно реквизиту вокруг персонажа,
// чтобы он не залез на карточку входа. Сценки без подходящего места заменяются обычным отдыхом.
const SCENES: { id: SceneId; look: Omit<Look, "scene">; hold: [number, number]; ext: Rect; say?: string }[] = [
  { id: "party", look: { mood: "happy", pose: "none", acc: "partyhat", live: true }, hold: [9000, 13000], ext: { l: 130, r: 190, t: 190, b: 210 }, say: "Я позвала друзей!" },
  { id: "sleep", look: { mood: "sleepy", pose: "none", acc: "nightcap", live: false }, hold: [8000, 14000], ext: { l: 50, r: 70, t: 60, b: 40 }, say: "Zzz…" },
  { id: "code", look: { mood: "idle", pose: "type", acc: "headphones", live: true }, hold: [9000, 14000], ext: { l: 90, r: 150, t: 150, b: 60 }, say: "Чиню баги" },
  { id: "coffee", look: { mood: "idle", pose: "none", acc: "none", live: true }, hold: [8000, 12000], ext: { l: 70, r: 100, t: 60, b: 70 }, say: "Кофе-пауза" },
  { id: "juggle", look: { mood: "idle", pose: "juggle", acc: "none", live: true }, hold: [8000, 12000], ext: { l: 60, r: 130, t: 120, b: 50 } },
  { id: "workout", look: { mood: "idle", pose: "lift", acc: "sweatband", live: true }, hold: [8000, 11000], ext: { l: 90, r: 90, t: 70, b: 60 }, say: "Разминка!" },
  { id: "magic", look: { mood: "happy", pose: "wand", acc: "bowtie", live: true }, hold: [8000, 12000], ext: { l: 70, r: 110, t: 110, b: 70 }, say: "Фокус-покус" },
];

const IDLE_LOOKS: Look[] = [
  { mood: "idle", pose: "none", acc: "none", live: true, scene: null },
  { mood: "happy", pose: "none", acc: "none", live: true, scene: null, say: "Привет!" },
  { mood: "talk", pose: "none", acc: "glasses", live: true, scene: null, say: "Так, что тут у нас…" },
];

const WALK: Look = { mood: "idle", pose: "none", acc: "none", live: true, scene: null };

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T,>(xs: readonly T[]) => xs[Math.floor(Math.random() * xs.length)];

function cardRect(): Rect | null {
  const r = document.querySelector("[data-login-card]")?.getBoundingClientRect();
  return r ? { l: r.left, t: r.top, r: r.right, b: r.bottom } : null;
}
const grow = (r: Rect, n: number): Rect => ({ l: r.l - n, t: r.t - n, r: r.r + n, b: r.b + n });
const inside = (p: Pt, r: Rect) => p.x > r.l && p.x < r.r && p.y > r.t && p.y < r.b;

/** Отрезок пересекает прямоугольник (проверка выборкой точек: для прогулки по экрану точности хватает). */
function crosses(a: Pt, b: Pt, r: Rect): boolean {
  const n = Math.max(2, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 8));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    if (inside({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, r)) return true;
  }
  return false;
}

const clampPt = (p: Pt): Pt => ({
  x: Math.min(Math.max(p.x, HALF + 8), window.innerWidth - HALF - 8),
  y: Math.min(Math.max(p.y, HALF + 8), window.innerHeight - HALF - 8),
});

/** Центр персонажа так, чтобы он вместе с реквизитом не задел карточку. */
function pickSpot(ext: Rect): Pt | null {
  const card = cardRect();
  const keep = card ? grow(card, PAD) : null;
  for (let i = 0; i < 60; i++) {
    const p = clampPt({ x: rand(0, window.innerWidth), y: rand(0, window.innerHeight) });
    if (p.x - HALF - ext.l < 0 || p.x + HALF + ext.r > window.innerWidth) continue;
    if (p.y - HALF - ext.t < 0 || p.y + HALF + ext.b > window.innerHeight) continue;
    if (!keep) return p;
    const box: Rect = { l: p.x - HALF - ext.l, t: p.y - HALF - ext.t, r: p.x + HALF + ext.r, b: p.y + HALF + ext.b };
    if (box.r < keep.l || box.l > keep.r || box.b < keep.t || box.t > keep.b) return p;
  }
  return null;
}

/** Маршрут из a в b в обход карточки: напрямую, через один угол или через два соседних. */
function route(a: Pt, b: Pt): Pt[] {
  const card = cardRect();
  if (!card) return [b];
  const keep = grow(card, HALF + PAD);
  if (!crosses(a, b, keep)) return [b];
  const corners = [
    { x: keep.l - 4, y: keep.t - 4 },
    { x: keep.r + 4, y: keep.t - 4 },
    { x: keep.r + 4, y: keep.b + 4 },
    { x: keep.l - 4, y: keep.b + 4 },
  ].map(clampPt);
  const len = (pts: Pt[]) => pts.reduce((s, p, i) => s + Math.hypot(p.x - (i ? pts[i - 1].x : a.x), p.y - (i ? pts[i - 1].y : a.y)), 0);
  const ok = (pts: Pt[]) => pts.every((p, i) => !inside(p, keep) && !crosses(i ? pts[i - 1] : a, p, keep));
  const cands: Pt[][] = [];
  for (const c of corners) cands.push([c, b]);
  for (const c1 of corners) for (const c2 of corners) if (c1 !== c2) cands.push([c1, c2, b]);
  const good = cands.filter(ok).sort((x, y) => len(x) - len(y));
  return good[0] ?? [];
}

/** Фон с плывущими пятнами света и пылинками плюс самостоятельный персонаж. */
export function LoginScene() {
  const boxRef = useRef<HTMLDivElement>(null);
  const [look, setLook] = useState<Look>(IDLE_LOOKS[0]);
  const [walking, setWalking] = useState(false);
  const [flip, setFlip] = useState(false);

  // Взгляд следует за курсором: --lx/--ly читает .av-look внутри SVG.
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const onMove = (e: PointerEvent) => {
      const r = box.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2);
      const dy = e.clientY - (r.top + r.height / 2);
      const d = Math.hypot(dx, dy) || 1;
      const k = Math.min(1, d / 300) * 7;
      box.style.setProperty("--lx", String((dx / d) * k));
      box.style.setProperty("--ly", String((dy / d) * k));
    };
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, []);

  // Бесконечный цикл: дойти до свободного места в обход формы, поиграть сценку, идти дальше.
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const place = (p: Pt) => (box.style.transform = `translate(${p.x - HALF}px, ${p.y - HALF}px)`);
    let cur = pickSpot({ l: 0, r: 0, t: 0, b: 0 }) ?? { x: HALF + 20, y: window.innerHeight - HALF - 20 };
    box.style.transition = "none";
    place(cur);

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return;
    }

    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const later = (fn: () => void, ms: number) => {
      timer = setTimeout(() => alive && fn(), ms);
    };

    const walk = (path: Pt[], done: () => void) => {
      const [next, ...rest] = path;
      if (!next) return done();
      const ms = Math.max(900, Math.hypot(next.x - cur.x, next.y - cur.y) * rand(4.5, 7));
      setFlip(next.x < cur.x);
      box.style.transition = `transform ${ms}ms cubic-bezier(.4,.05,.4,1)`;
      place(next);
      cur = next;
      // следующий отрезок стартует, когда переход реально закончился (таймер — только страховка)
      let fired = false;
      const arrive = () => {
        if (fired || !alive) return;
        fired = true;
        clearTimeout(timer);
        box.removeEventListener("transitionend", onEnd);
        walk(rest, done);
      };
      const onEnd = (e: TransitionEvent) => {
        if (e.target === box && e.propertyName === "transform") arrive();
      };
      box.addEventListener("transitionend", onEnd);
      later(arrive, ms + 600);
    };

    const step = () => {
      const scene = Math.random() < 0.7 ? pick(SCENES) : null;
      const target = pickSpot(scene?.ext ?? { l: 0, r: 0, t: 0, b: 0 });
      if (!target) return later(step, 1500);
      const path = route(cur, target);
      setWalking(true);
      setLook(WALK);
      walk(path, () => {
        setWalking(false);
        setFlip(false);
        if (scene) {
          setLook({ ...scene.look, scene: scene.id, say: scene.say });
          later(step, rand(scene.hold[0], scene.hold[1]));
        } else {
          const l = pick(IDLE_LOOKS);
          setLook(l);
          later(step, rand(2500, 4500));
        }
      });
    };

    // при изменении окна уводим персонажа с карточки, если она «наехала»
    const onResize = () => {
      const card = cardRect();
      if (card && inside(cur, grow(card, HALF))) {
        clearTimeout(timer);
        const t = pickSpot({ l: 0, r: 0, t: 0, b: 0 });
        if (t) {
          cur = t;
          box.style.transition = "none";
          place(t);
        }
        later(step, 1200);
      }
    };
    window.addEventListener("resize", onResize);
    // карточка может вырасти уже после остановки персонажа (ошибка формы, виджет Telegram)
    // (карточка появляется после Suspense, поэтому наблюдаем за фактическим положением, а не за узлом)
    const guard = setInterval(() => {
      const c = cardRect();
      const b = box.getBoundingClientRect();
      if (c && inside({ x: b.left + HALF, y: b.top + HALF }, grow(c, HALF + 2))) onResize();
    }, 400);
    later(step, 900);
    return () => {
      alive = false;
      clearTimeout(timer);
      clearInterval(guard);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  const props = look.scene && !walking ? renderSceneProps(look.scene) : null;

  return (
    <>
      <div className="login-bg" aria-hidden="true">
        <span className="login-blob login-blob-a" />
        <span className="login-blob login-blob-b" />
        <span className="login-blob login-blob-c" />
        <span className="login-grid" />
        {Array.from({ length: 14 }, (_, i) => (
          <span
            key={i}
            className="login-dust"
            style={{
              left: `${(i * 37 + 7) % 100}%`,
              animationDuration: `${14 + ((i * 5) % 12)}s`,
              animationDelay: `-${(i * 3) % 14}s`,
              width: 3 + (i % 3),
              height: 3 + (i % 3),
            }}
          />
        ))}
      </div>

      <div ref={boxRef} className="login-mascot" style={{ width: SIZE, height: SIZE }} aria-hidden="true">
        {props ? <div className="avp-stage">{props.back}</div> : null}
        <div className="login-mascot-bob" data-walking={walking ? "1" : "0"} data-still={look.scene ? "1" : "0"} style={{ transform: flip ? "scaleX(-1)" : undefined }}>
          <AvatarArt mood={look.mood} pose={look.pose} acc={look.acc} live={look.live} />
        </div>
        {props ? <div className="avp-stage">{props.front}</div> : null}
        {look.say && !walking ? (
          <div key={look.say} className="login-mascot-say" style={{ bottom: look.scene ? "calc(100% + 40px)" : undefined }}>
            {look.say}
          </div>
        ) : null}
      </div>
    </>
  );
}
