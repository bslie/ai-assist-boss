import "./avatar.css";

export type Mood = "idle" | "talk" | "happy" | "sleepy";
export type Accessory = "none" | "glasses" | "headphones" | "nightcap" | "partyhat" | "sweatband" | "bowtie";
export type Pose = "none" | "type" | "lift" | "juggle" | "wand";

// Дух-капля: светящийся мягкий персонаж без ног.
// Выражение лица — data-mood, поза рук — data-pose, аксессуар рисуется прямо в SVG.
// Без live=true персонаж статичен (кроме редкого моргания); взгляд задаётся CSS-переменными --lx/--ly.
export function AvatarArt({
  mood,
  live,
  acc,
  pose,
}: {
  mood: Mood;
  live: boolean;
  acc: Accessory;
  pose: Pose;
}) {
  const EYE = "#2B2233";
  const ARM = "#FFB369";

  return (
    <svg
      className="av-root"
      data-mood={mood}
      data-live={live ? "1" : "0"}
      data-pose={pose}
      viewBox="0 0 200 200"
      width="100%"
      height="100%"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <radialGradient id="av-halo-g" cx="50%" cy="55%" r="50%">
          <stop offset="0%" stopColor="#FFC87A" stopOpacity=".55" />
          <stop offset="100%" stopColor="#FFC87A" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="av-body-g" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#FFE2B0" />
          <stop offset="55%" stopColor="#FFB86B" />
          <stop offset="100%" stopColor="#F28F6B" />
        </linearGradient>
        <linearGradient id="av-hat-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#7C8BFF" />
          <stop offset="100%" stopColor="#C77DFF" />
        </linearGradient>
      </defs>

      <circle className="av-halo" cx="100" cy="112" r="92" fill="url(#av-halo-g)" />

      {/* ручки; в них спрятаны гантели для зарядки */}
      <g className="av-arm av-arm-l">
        <ellipse cx="40" cy="124" rx="9" ry="14" fill={ARM} />
        <g className="av-db">
          <rect x="29" y="141" width="22" height="3.5" rx="1.5" fill="#6B7080" />
          <rect x="25" y="134" width="7" height="18" rx="2.5" fill="#3A3F52" />
          <rect x="48" y="134" width="7" height="18" rx="2.5" fill="#3A3F52" />
        </g>
      </g>
      <g className="av-arm av-arm-r">
        <ellipse cx="160" cy="124" rx="9" ry="14" fill={ARM} />
        <g className="av-db">
          <rect x="149" y="141" width="22" height="3.5" rx="1.5" fill="#6B7080" />
          <rect x="145" y="134" width="7" height="18" rx="2.5" fill="#3A3F52" />
          <rect x="168" y="134" width="7" height="18" rx="2.5" fill="#3A3F52" />
        </g>
      </g>

      {/* тело-капля */}
      <path
        d="M100 24 C100 24 150 74 156 112 C162 154 134 180 100 180 C66 180 38 154 44 112 C50 74 100 24 100 24 Z"
        fill="url(#av-body-g)"
        stroke="url(#av-body-g)"
        strokeWidth="6"
        strokeLinejoin="round"
      />
      <path d="M66 112 C64 94 74 78 86 66" stroke="#fff" strokeWidth="6" strokeLinecap="round" fill="none" opacity=".55" />
      <circle cx="74" cy="132" r="2.5" fill="#fff" opacity=".4" />

      {/* лицо */}
      <g className="av-look">
        <circle cx="68" cy="130" r="7" fill="#FF8E85" opacity=".45" />
        <circle cx="132" cy="130" r="7" fill="#FF8E85" opacity=".45" />

        <g className="av-eyes">
          <g className="av-eyeballs">
            <ellipse cx="82" cy="112" rx="8" ry="11" fill={EYE} />
            <ellipse cx="118" cy="112" rx="8" ry="11" fill={EYE} />
            <circle cx="79.5" cy="107.5" r="3.2" fill="#fff" />
            <circle cx="115.5" cy="107.5" r="3.2" fill="#fff" />
            <circle cx="85" cy="116" r="1.4" fill="#fff" opacity=".7" />
            <circle cx="121" cy="116" r="1.4" fill="#fff" opacity=".7" />
          </g>
        </g>
        <g className="av-eyes-happy">
          <path d="M73 115 Q82 102 91 115" stroke={EYE} strokeWidth="4.5" strokeLinecap="round" fill="none" />
          <path d="M109 115 Q118 102 127 115" stroke={EYE} strokeWidth="4.5" strokeLinecap="round" fill="none" />
        </g>
        <g className="av-eyes-sleepy">
          <path d="M73 112 Q82 120 91 112" stroke={EYE} strokeWidth="4" strokeLinecap="round" fill="none" />
          <path d="M109 112 Q118 120 127 112" stroke={EYE} strokeWidth="4" strokeLinecap="round" fill="none" />
        </g>

        <path className="av-mouth-closed" d="M92 132 Q100 140 108 132" stroke={EYE} strokeWidth="3.5" strokeLinecap="round" fill="none" />
        <ellipse className="av-mouth-open" cx="100" cy="135" rx="7" ry="6" fill="#7A2C3C" />

        {acc === "glasses" && (
          <g fill="rgba(255,255,255,.14)" stroke="#3B3350" strokeWidth="3.2" strokeLinecap="round">
            <circle cx="82" cy="112" r="14" />
            <circle cx="118" cy="112" r="14" />
            <path d="M96 109 Q100 106 104 109" fill="none" />
            <path d="M68 108 L56 102 M132 108 L144 102" fill="none" />
          </g>
        )}
      </g>

      {/* аксессуары поверх тела */}
      {acc === "headphones" && (
        <g>
          <path d="M42 112 C40 56 74 36 100 36 C126 36 160 56 158 112" stroke="#3A3F52" strokeWidth="7" strokeLinecap="round" fill="none" />
          <rect x="33" y="96" width="17" height="34" rx="8" fill="#3A3F52" />
          <rect x="150" y="96" width="17" height="34" rx="8" fill="#3A3F52" />
          <rect x="37" y="104" width="6" height="18" rx="3" fill="#F2B25C" />
          <rect x="157" y="104" width="6" height="18" rx="3" fill="#F2B25C" />
        </g>
      )}
      {acc === "nightcap" && (
        <g>
          <path d="M60 78 C66 42 92 20 118 24 C140 28 158 52 164 86 Q150 70 132 66 Q96 64 60 78Z" fill="#6C7BFF" />
          <path d="M56 78 Q104 62 168 86 L166 98 Q108 76 58 92Z" fill="#E8ECFF" />
          <circle cx="166" cy="98" r="9" fill="#fff" />
        </g>
      )}
      {acc === "partyhat" && (
        <g>
          <path d="M100 -8 L76 56 Q100 66 124 56 Z" fill="url(#av-hat-g)" />
          <circle cx="93" cy="30" r="3" fill="#FFE27A" />
          <circle cx="104" cy="44" r="3" fill="#FF8E85" />
          <circle cx="94" cy="50" r="2.4" fill="#fff" />
          <circle cx="100" cy="-10" r="7" fill="#FFE27A" />
        </g>
      )}
      {acc === "sweatband" && (
        <path d="M62 92 Q100 76 138 92" stroke="#FF6B6B" strokeWidth="10" strokeLinecap="round" fill="none" />
      )}
      {acc === "bowtie" && (
        <g>
          <path d="M100 152 L80 142 L80 162 Z" fill="#E5484D" />
          <path d="M100 152 L120 142 L120 162 Z" fill="#E5484D" />
          <circle cx="100" cy="152" r="5" fill="#B83237" />
        </g>
      )}

      <text className="av-z" x="150" y="60" fontSize="26" fontWeight="700" fill="#FFE2B0">
        z
      </text>
      <text className="av-z av-z2" x="166" y="40" fontSize="18" fontWeight="700" fill="#FFE2B0">
        z
      </text>
    </svg>
  );
}
