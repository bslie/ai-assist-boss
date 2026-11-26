import { Suspense } from "react";
import { AvatarStage } from "./avatar-stage";

export const metadata = { title: "ИИ-помощник на встрече", robots: { index: false } };

async function Stage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ autoplay?: string }> }) {
  const { token } = await params;
  const { autoplay } = await searchParams;
  return <AvatarStage token={token} autoplay={autoplay === "1"} />;
}

export default function AvatarPage(props: { params: Promise<{ token: string }>; searchParams: Promise<{ autoplay?: string }> }) {
  // Данные запроса читаются внутри Suspense: страница не блокирует предрендер оболочки (cacheComponents).
  return (
    <Suspense fallback={null}>
      <Stage {...props} />
    </Suspense>
  );
}
