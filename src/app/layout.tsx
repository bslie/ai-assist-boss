import type { Metadata } from "next";
import { Fraunces, Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ variable: "--font-inter", subsets: ["latin", "cyrillic"] });
const fraunces = Fraunces({ variable: "--font-fraunces", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "ИИ-помощник руководителя",
  description: "Разбирает почту, ведёт поручения и встречи; защищённые решения отдаёт руководителю.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ru" suppressHydrationWarning className={`${inter.variable} ${fraunces.variable} h-full antialiased`}>
      <head>
        {/* Если вступительные анимации главной уже были в этой сессии вкладки, помечаем <html> до первой отрисовки. */}
        <script dangerouslySetInnerHTML={{ __html: `try{if(sessionStorage.getItem("intro-seen"))document.documentElement.dataset.introDone="1"}catch(e){}` }} />
      </head>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
