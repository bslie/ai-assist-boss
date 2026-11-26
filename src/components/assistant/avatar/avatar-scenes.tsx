import type { CSSProperties, ReactNode } from "react";
import type { SceneId } from "./avatar-bus";
import "./avatar-scenes.css";

// Реквизит сценок. Координаты в px относительно квадрата персонажа 128x128 (центр 64,64).
// back рисуется за персонажем, front перед ним. Всё чисто декоративное и без событий.
const v = (o: Record<string, string | number>) => o as CSSProperties;

const CONFETTI_COLORS = ["#FF6B6B", "#FFD166", "#06D6A0", "#4CC9F0", "#C77DFF", "#FF9F1C"];
const CONFETTI = Array.from({ length: 24 }, (_, i) => ({
  x: ((i * 53) % 300) - 86,
  delay: (i % 8) * 0.38,
  dur: 2.4 + (i % 5) * 0.35,
  color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
}));

function Friend({
  c1,
  c2,
  left,
  top,
  delay,
  fromX,
  hat,
}: {
  c1: string;
  c2: string;
  left: number;
  top: number;
  delay: number;
  fromX: number;
  hat?: boolean;
}) {
  return (
    <div className="avp-friend" style={v({ left, top, "--d": `${delay}s`, "--fx": `${fromX}px` })}>
      <div className="avp-friend-in">
        <div className="avp-friend-bounce">
          <svg width="58" height="72" viewBox="0 0 100 124">
            <path
              d="M50 8 C50 8 84 44 88 72 C92 100 74 116 50 116 C26 116 8 100 12 72 C16 44 50 8 50 8Z"
              fill={c1}
              stroke={c2}
              strokeWidth="4"
              strokeLinejoin="round"
            />
            <path d="M30 70 C28 58 34 48 42 42" stroke="#fff" strokeWidth="5" strokeLinecap="round" fill="none" opacity=".5" />
            <ellipse cx="37" cy="78" rx="5.5" ry="7.5" fill="#2B2233" />
            <ellipse cx="63" cy="78" rx="5.5" ry="7.5" fill="#2B2233" />
            <circle cx="35.2" cy="75" r="2" fill="#fff" />
            <circle cx="61.2" cy="75" r="2" fill="#fff" />
            <ellipse cx="50" cy="94" rx="6" ry="5" fill="#7A2C3C" />
            {hat && <path d="M50 -4 L34 30 Q50 36 66 30 Z" fill="#FF6B6B" />}
          </svg>
        </div>
      </div>
    </div>
  );
}

function Balloon({ left, top, color, delay }: { left: number; top: number; color: string; delay: number }) {
  return (
    <svg className="avp-balloon" style={v({ left, top, animationDelay: `${delay}s` })} width="34" height="76" viewBox="0 0 34 76">
      <ellipse cx="17" cy="20" rx="14" ry="18" fill={color} />
      <ellipse cx="11" cy="13" rx="3.5" ry="5.5" fill="#fff" opacity=".45" />
      <path d="M17 38 L14 44 L20 44 Z" fill={color} />
      <path d="M17 44 C10 54 24 62 17 74" stroke="#9AA0B2" strokeWidth="1.5" fill="none" />
    </svg>
  );
}

function Mug({ left, top, size = 40 }: { left: number; top: number; size?: number }) {
  return (
    <svg className="avp-mug" style={{ left, top }} width={size} height={size} viewBox="0 0 40 40">
      <path d="M8 12 H28 V28 C28 33 24 36 18 36 C12 36 8 33 8 28 Z" fill="#fff" stroke="#D6D9E3" strokeWidth="1.5" />
      <path d="M28 16 C36 16 36 28 28 28" stroke="#fff" strokeWidth="4" fill="none" />
      <ellipse cx="18" cy="13" rx="9.5" ry="2.6" fill="#6B3F26" />
      <path d="M12 22 Q18 26 24 22" stroke="#F28F6B" strokeWidth="2.2" strokeLinecap="round" fill="none" />
    </svg>
  );
}

function Steam({ left, top }: { left: number; top: number }) {
  return (
    <svg className="avp-steam" style={{ left, top }} width="30" height="34" viewBox="0 0 30 34">
      <path d="M8 32 C2 24 14 20 8 12 C5 8 8 4 8 2" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" fill="none" />
      <path d="M16 32 C10 24 22 20 16 12" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" fill="none" />
      <path d="M24 32 C18 24 30 20 24 12 C21 8 24 4 24 2" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" fill="none" />
    </svg>
  );
}

function Ball({ color, delay }: { color: string; delay: number }) {
  return (
    <div className="avp-ball-x" style={v({ "--bd": `${delay}s` })}>
      <div className="avp-ball-y" style={v({ "--bd": `${delay}s` })}>
        <svg width="20" height="20" viewBox="0 0 20 20">
          <circle cx="10" cy="10" r="9" fill={color} />
          <circle cx="7" cy="6.5" r="2.6" fill="#fff" opacity=".6" />
        </svg>
      </div>
    </div>
  );
}

const SCENES: Record<SceneId, { back: ReactNode; front: ReactNode }> = {
  // ---- 1. Мини-тусовка с друзьями ----
  party: {
    back: (
      <>
        {/* диско-шар */}
        <svg style={{ left: 42, top: -170 }} width="44" height="110" viewBox="0 0 44 110">
          <line x1="22" y1="0" x2="22" y2="62" stroke="#9AA0B2" strokeWidth="2" />
          <circle cx="22" cy="80" r="22" fill="#C9CEDB" />
          <path d="M0 80 H44 M22 58 V102 M5 68 Q22 76 39 68 M5 92 Q22 84 39 92" stroke="#8D93A3" strokeWidth="1.2" fill="none" />
          <circle className="avp-twinkle" cx="14" cy="72" r="3" fill="#fff" />
          <circle className="avp-twinkle" style={{ animationDelay: ".4s" }} cx="30" cy="86" r="2.6" fill="#fff" />
          <circle className="avp-twinkle" style={{ animationDelay: ".8s" }} cx="26" cy="68" r="2" fill="#FFE27A" />
        </svg>
        <Balloon left={-40} top={-20} color="#FF6B6B" delay={0} />
        <Balloon left={140} top={-34} color="#4CC9F0" delay={0.7} />
        {CONFETTI.map((c, i) => (
          <i
            key={i}
            className="avp-conf"
            style={{ left: c.x, top: -120, background: c.color, animationDelay: `-${c.delay}s`, animationDuration: `${c.dur}s` }}
          />
        ))}
        {["♪", "♫", "♪"].map((n, i) => (
          <span key={i} className="avp-note" style={{ left: 24 + i * 38, top: -10, animationDelay: `${i * 0.9}s` }}>
            {n}
          </span>
        ))}
      </>
    ),
    front: (
      <>
        <Friend c1="#9CC0FF" c2="#6C95F0" left={-116} top={34} delay={0.1} fromX={-620} hat />
        <Friend c1="#9BE8B0" c2="#55C27A" left={188} top={30} delay={0.5} fromX={620} />
        <Friend c1="#D3B4FF" c2="#9B6CF5" left={-52} top={74} delay={0.9} fromX={-620} />
      </>
    ),
  },

  // ---- 2. Уснул ----
  sleep: {
    back: (
      <svg style={{ left: -6, top: 94 }} width="140" height="40" viewBox="0 0 140 40">
        <rect x="4" y="4" width="132" height="30" rx="15" fill="#E9EEFF" stroke="#C9D3F5" strokeWidth="2" />
        <path d="M22 20 Q70 32 118 20" stroke="#C9D3F5" strokeWidth="2" fill="none" />
      </svg>
    ),
    front: (
      <>
        <svg style={{ left: 100, top: -64 }} width="46" height="46" viewBox="0 0 46 46">
          <path d="M30 4 A20 20 0 1 0 42 32 A16 16 0 1 1 30 4Z" fill="#FFE9A8" />
        </svg>
        {[
          [60, -52, 0],
          [90, -22, 0.6],
          [4, -40, 1.1],
        ].map(([x, y, d], i) => (
          <svg key={i} className="avp-twinkle" style={{ left: x, top: y, animationDelay: `${d}s` }} width="12" height="12" viewBox="0 0 12 12">
            <path d="M6 0 L7.5 4.5 L12 6 L7.5 7.5 L6 12 L4.5 7.5 L0 6 L4.5 4.5Z" fill="#FFE9A8" />
          </svg>
        ))}
      </>
    ),
  },

  // ---- 3. Изучает материал на странице ----
  study: {
    back: null,
    front: (
      <>
        <svg style={{ left: 8, top: 82 }} width="112" height="56" viewBox="0 0 112 56">
          <path d="M4 14 L56 22 L108 14 L108 50 L56 56 L4 50Z" fill="#7C8BFF" />
          <path d="M8 8 Q32 4 56 14 L56 50 Q32 42 8 46Z" fill="#fff" stroke="#D6D9E3" strokeWidth="1.2" />
          <path d="M104 8 Q80 4 56 14 L56 50 Q80 42 104 46Z" fill="#fff" stroke="#D6D9E3" strokeWidth="1.2" />
          <g stroke="#B7BDD0" strokeWidth="1.6" strokeLinecap="round">
            <path d="M14 18 Q30 16 48 24 M14 26 Q30 24 48 32 M14 34 Q30 32 48 40" />
            <path d="M96 18 Q80 16 64 24 M96 26 Q80 24 64 32 M96 34 Q80 32 64 40" />
          </g>
          <g className="avp-flip">
            <path d="M104 8 Q80 4 56 14 L56 50 Q80 42 104 46Z" fill="#F4F6FF" stroke="#D6D9E3" strokeWidth="1.2" />
          </g>
        </svg>
        <svg className="avp-bulb" style={{ left: 96, top: -34 }} width="34" height="42" viewBox="0 0 34 42">
          <path d="M17 4 C9 4 5 10 5 16 C5 22 10 24 11 30 H23 C24 24 29 22 29 16 C29 10 25 4 17 4Z" fill="#FFE27A" stroke="#F2B25C" strokeWidth="1.5" />
          <rect x="11" y="31" width="12" height="6" rx="2" fill="#B7BDD0" />
          <path d="M17 -2 V-6 M3 6 L0 3 M31 6 L34 3 M0 18 H-4 M34 18 H38" stroke="#FFE27A" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </>
    ),
  },

  // ---- 4. Программирует на ноутбуке ----
  code: {
    back: null,
    front: (
      <>
        <svg style={{ left: 6, top: 74 }} width="116" height="68" viewBox="0 0 116 68">
          <path d="M22 4 H94 L100 46 H16 Z" fill="#171B26" stroke="#8D93A3" strokeWidth="2" strokeLinejoin="round" />
          <g>
            <rect className="avp-code-line" style={{ animationDelay: "0s" }} x="26" y="12" width="34" height="3.4" rx="1.7" fill="#F2B25C" />
            <rect className="avp-code-line" style={{ animationDelay: ".5s" }} x="32" y="19" width="42" height="3.4" rx="1.7" fill="#7BD88F" />
            <rect className="avp-code-line" style={{ animationDelay: "1s" }} x="32" y="26" width="28" height="3.4" rx="1.7" fill="#7DB5FF" />
            <rect className="avp-code-line" style={{ animationDelay: "1.5s" }} x="26" y="33" width="46" height="3.4" rx="1.7" fill="#FF8E85" />
            <rect className="avp-cursor" x="76" y="32.4" width="4" height="5.4" fill="#fff" />
          </g>
          <path d="M6 48 H110 L104 62 H12 Z" fill="#C9CDD8" stroke="#9AA0B2" strokeWidth="1.5" strokeLinejoin="round" />
          <rect x="44" y="52" width="28" height="6" rx="3" fill="#B2B7C6" />
        </svg>
        <Mug left={100} top={98} size={30} />
        <div className="avp-bug" style={{ left: 66, top: -30 }}>
          <span className="avp-bug-a">!?</span>
          <span className="avp-bug-b">✓</span>
        </div>
      </>
    ),
  },

  // ---- 5. Кофе-пауза ----
  coffee: {
    back: null,
    front: (
      <>
        <svg style={{ left: 54, top: 124 }} width="64" height="14" viewBox="0 0 64 14">
          <ellipse cx="32" cy="7" rx="30" ry="6" fill="#fff" stroke="#D6D9E3" strokeWidth="1.5" />
        </svg>
        <Mug left={60} top={92} size={48} />
        <Steam left={64} top={58} />
        <svg style={{ left: 8, top: 112 }} width="46" height="22" viewBox="0 0 46 22">
          <path d="M3 18 C3 6 14 2 23 2 C32 2 43 6 43 18 C36 12 10 12 3 18Z" fill="#E8A857" stroke="#C98532" strokeWidth="1.5" />
          <path d="M14 7 L16 14 M23 4 V13 M32 7 L30 14" stroke="#C98532" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </>
    ),
  },

  // ---- 6. Жонглирует ----
  juggle: {
    back: null,
    front: (
      <div className="avp-juggle" style={{ left: 14, top: 98 }}>
        <Ball color="#FF6B6B" delay={0} />
        <Ball color="#4CC9F0" delay={-0.4} />
        <Ball color="#FFD166" delay={-0.8} />
      </div>
    ),
  },

  // ---- 7. Зарядка с гантелями ----
  workout: {
    back: null,
    front: (
      <>
        {[
          [-6, 8, -20],
          [116, 4, 20],
          [-12, 40, -34],
        ].map(([x, y, r], i) => (
          <svg
            key={i}
            className="avp-sweat"
            style={v({ left: x, top: y, "--r": `${r}px`, animationDelay: `${i * 0.35}s` })}
            width="12"
            height="16"
            viewBox="0 0 12 16"
          >
            <path d="M6 0 C6 0 12 7 12 10.5 C12 13.8 9.3 16 6 16 C2.7 16 0 13.8 0 10.5 C0 7 6 0 6 0Z" fill="#7DD3FF" />
          </svg>
        ))}
      </>
    ),
  },

  // ---- 8. Гоняется за бабочкой: бабочка летает отдельным слоем, реквизит не нужен ----
  butterfly: { back: null, front: null },

  // ---- 9. Фокус: кролик из шляпы ----
  magic: {
    // кролик обрезан по верхнему краю шляпы: выпрыгивает из неё, а не торчит снизу
    back: (
      <div style={{ left: 34, top: 10, width: 60, height: 92, overflow: "hidden" }}>
        <svg className="avp-rabbit" style={{ position: "absolute", left: 10, top: 36 }} width="40" height="56" viewBox="0 0 40 56">
        <ellipse cx="13" cy="12" rx="5" ry="12" fill="#fff" stroke="#D6D9E3" strokeWidth="1.5" />
        <ellipse cx="27" cy="12" rx="5" ry="12" fill="#fff" stroke="#D6D9E3" strokeWidth="1.5" />
        <ellipse cx="13" cy="13" rx="2" ry="8" fill="#FFB3C1" />
        <ellipse cx="27" cy="13" rx="2" ry="8" fill="#FFB3C1" />
        <ellipse cx="20" cy="38" rx="15" ry="14" fill="#fff" stroke="#D6D9E3" strokeWidth="1.5" />
        <circle cx="14" cy="36" r="2" fill="#2B2233" />
        <circle cx="26" cy="36" r="2" fill="#2B2233" />
        <ellipse cx="20" cy="42" rx="2.4" ry="1.8" fill="#FF8FA3" />
        </svg>
      </div>
    ),
    front: (
      <>
        <svg style={{ left: 34, top: 92 }} width="60" height="48" viewBox="0 0 60 48">
          <ellipse cx="30" cy="40" rx="29" ry="7" fill="#1C1C26" />
          <path d="M12 40 V10 C12 5 18 3 30 3 C42 3 48 5 48 10 V40 Z" fill="#23232F" />
          <rect x="12" y="28" width="36" height="7" fill="#E5484D" />
          <ellipse cx="30" cy="10" rx="18" ry="4" fill="#15151D" />
        </svg>
        <div className="avp-wand" style={{ left: 112, top: 24 }}>
          <svg width="40" height="40" viewBox="0 0 40 40">
            <path d="M4 38 L26 14" stroke="#2B2233" strokeWidth="3.5" strokeLinecap="round" />
            <path d="M4 38 L9 33" stroke="#fff" strokeWidth="3.5" strokeLinecap="round" />
            <path d="M30 4 L32 10 L38 12 L32 14 L30 20 L28 14 L22 12 L28 10Z" fill="#FFE27A" />
          </svg>
        </div>
        {[
          [20, 40, 0],
          [96, 60, 0.25],
          [60, 20, 0.5],
          [108, 96, 0.75],
          [10, 80, 1],
        ].map(([x, y, d], i) => (
          <svg key={i} className="avp-burst" style={{ left: x, top: y, animationDelay: `${d}s` }} width="14" height="14" viewBox="0 0 12 12">
            <path d="M6 0 L7.5 4.5 L12 6 L7.5 7.5 L6 12 L4.5 7.5 L0 6 L4.5 4.5Z" fill="#FFE27A" />
          </svg>
        ))}
      </>
    ),
  },
};

export function renderSceneProps(id: SceneId): { back: ReactNode; front: ReactNode } {
  return SCENES[id];
}
