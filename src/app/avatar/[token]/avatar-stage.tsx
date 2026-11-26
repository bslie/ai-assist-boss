"use client";

/**
 * Страница-камера аватара (SPEC 4.5.3, минимум P0): образ + речь браузерным TTS.
 * Реплики идут из сценария встречи и из SSE `avatar.speak`. `?autoplay=1` — старт без клика (для камеры Recall).
 */
import { useEffect, useRef, useState } from "react";

interface Script {
  leaderName: string;
  title: string;
  lines: string[];
}

export function AvatarStage({ token, autoplay }: { token: string; autoplay: boolean }) {
  const [script, setScript] = useState<Script | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [caption, setCaption] = useState("");
  const [speaking, setSpeaking] = useState(false);
  const [started, setStarted] = useState(false);
  const say = useRef<(lines: string[]) => void>(() => {});

  // Очередь реплик: следующая начинается после окончания предыдущей и паузы для ответа участников.
  useEffect(() => {
    const queue: string[] = [];
    let busy = false;
    let alive = true;
    const pump = () => {
      if (busy || !alive) return;
      const next = queue.shift();
      if (!next) return void setSpeaking(false);
      busy = true;
      setSpeaking(true);
      setCaption(next);
      const done = () => {
        busy = false;
        setTimeout(pump, 1500);
      };
      if (typeof speechSynthesis === "undefined") return void setTimeout(done, Math.max(2500, next.length * 55));
      const u = new SpeechSynthesisUtterance(next);
      u.lang = "ru-RU";
      u.onend = done;
      u.onerror = done;
      speechSynthesis.speak(u);
    };
    say.current = (lines) => {
      queue.push(...lines);
      pump();
    };
    return () => {
      alive = false;
      if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
    };
  }, []);

  useEffect(() => {
    fetch(`/api/avatar/${token}/script`)
      .then(async (r) => (r.ok ? ((await r.json()) as Script) : Promise.reject(new Error("Встреча не найдена"))))
      .then((s) => {
        setScript(s);
        if (autoplay) {
          setStarted(true);
          say.current(s.lines);
        }
      })
      .catch((e: Error) => setError(e.message));
  }, [token, autoplay]);

  useEffect(() => {
    const es = new EventSource(`/api/avatar/${token}/stream`);
    es.addEventListener("avatar.speak", (ev) => {
      try {
        const { text } = JSON.parse((ev as MessageEvent<string>).data) as { text?: string };
        if (text) say.current([text]);
      } catch {
        /* битое событие игнорируем */
      }
    });
    return () => es.close();
  }, [token]);

  if (error) return <main style={{ padding: 24 }}>{error}</main>;
  const initials = (script?.leaderName ?? "ИП").split(" ").map((w) => w[0]).join("").slice(0, 2);

  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "#111", color: "#fff", fontFamily: "sans-serif" }}>
      <div style={{ textAlign: "center", maxWidth: 720, padding: 24 }}>
        <div
          aria-label="Образ ИИ-помощника"
          style={{
            width: 220, height: 220, borderRadius: "50%", margin: "0 auto 24px", display: "grid", placeItems: "center",
            fontSize: 72, background: "#334", boxShadow: speaking ? "0 0 0 12px rgba(120,160,255,.35)" : "none", transition: "box-shadow .3s",
          }}
        >
          {initials}
        </div>
        <h1 style={{ fontSize: 24, margin: 0 }}>ИИ-помощник {script?.leaderName ?? ""}</h1>
        <p style={{ opacity: 0.7, margin: "4px 0 24px" }}>{script?.title}</p>
        <p style={{ minHeight: 96, fontSize: 22, lineHeight: 1.4 }}>{caption}</p>
        {!started && script && (
          <button
            onClick={() => {
              setStarted(true);
              say.current(script.lines);
            }}
            style={{ fontSize: 18, padding: "10px 24px" }}
          >
            Начать
          </button>
        )}
      </div>
    </main>
  );
}
