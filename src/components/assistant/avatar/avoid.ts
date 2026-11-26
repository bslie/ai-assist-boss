// Поиск мест, где персонаж никому не мешает: считаем, сколько интерфейса он закроет в точке.
export type Vec = { x: number; y: number };
export type Box = { l: number; t: number; r: number; b: number };

// Всё, что человек читает или нажимает. Крупные контейнеры не берём: иначе свободных мест не останется.
const AVOID_SELECTOR =
  "a[href], button, input, textarea, select, label, h1, h2, h3, h4, p, li, [role='button'], [role='tab'], [role='switch'], [data-avatar-avoid]";
const IGNORE_SELECTOR = ".avatar-layer, .avatar-goo, [data-avatar-ignore]";

export function collectAvoid(): Box[] {
  const out: Box[] = [];
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const nodes = document.querySelectorAll<HTMLElement>(AVOID_SELECTOR);
  for (let i = 0; i < nodes.length && out.length < 700; i++) {
    const el = nodes[i];
    if (el.closest(IGNORE_SELECTOR)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 6 || r.height < 6) continue;
    if (r.right < 0 || r.bottom < 0 || r.left > vw || r.top > vh) continue;
    out.push({ l: r.left, t: r.top, r: r.right, b: r.bottom });
  }
  return out;
}

/** Площадь пересечения квадрата персонажа с элементами интерфейса. */
export function overlapAt(x: number, y: number, half: number, boxes: Box[]): number {
  const l = x - half;
  const r = x + half;
  const t = y - half;
  const b = y + half;
  let area = 0;
  for (const k of boxes) {
    const w = Math.min(r, k.r) - Math.max(l, k.l);
    if (w <= 0) continue;
    const h = Math.min(b, k.b) - Math.max(t, k.t);
    if (h > 0) area += w * h;
  }
  return area;
}

/** Ближайшая к desired точка, где закрывается минимум интерфейса. */
export function findSafeSpot(
  desired: Vec,
  boxes: Box[],
  half: number,
  clampFn: (p: Vec) => Vec,
  maxRadius = 300,
): Vec {
  const score = (p: Vec): number =>
    overlapAt(p.x, p.y, half, boxes) + Math.hypot(p.x - desired.x, p.y - desired.y) * 0.2;

  let best = clampFn(desired);
  let bestScore = score(best);
  if (overlapAt(best.x, best.y, half, boxes) === 0) return best;

  for (let rad = 36; rad <= maxRadius; rad += 36) {
    const steps = Math.max(8, Math.round(rad / 14));
    for (let i = 0; i < steps; i++) {
      const a = (Math.PI * 2 * i) / steps + rad * 0.01;
      const cand = clampFn({ x: desired.x + Math.cos(a) * rad, y: desired.y + Math.sin(a) * rad });
      const sc = score(cand);
      if (sc < bestScore) {
        best = cand;
        bestScore = sc;
      }
    }
  }
  return best;
}
