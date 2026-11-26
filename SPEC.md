# SPEC.md — ИИ-помощник руководителя (хакатон «ИИкузница», Softline)

> Версия 2 (26.11.2026). Исправлена по ревью: повторяющиеся письма, порог бюджета, многослойный Policy Gate, импорт `leader_profile.md`, Telegram-роли, «живые» демо-часы, приоритеты P0/P1/P2.
> Документ для Claude Code: архитектура, схема данных, контракты и логика. Визуальный слой `apps/web` описан только маршрутами, API и SSE.
>
> **Отклонения реализации от этой спеки** (структура папок, Prisma 7, один npm-пакет вместо монорепо) перечислены в `CLAUDE.md`.

---

## 0. Сроки и приоритеты

- Дедлайн сдачи: **28.11.2026 10:00 МСК**. Платформа закрывается автоматически.
- Оценивается последний коммит до дедлайна. Коммитить часто.
- Каждый модуль и требование размечены приоритетом:
  - **P0** — без этого не сдаём;
  - **P1** — делаем после закрытия всех P0;
  - **P2** — только если останется время.
- Пока все P0 не работают сквозным сценарием на стенде, к P1 не переходим.

---

## 1. Цель и системные инварианты

**Цель.** Снять с руководителя коммуникационную и операционную рутину:
- освободить 8–12 часов в неделю;
- утром 3–4 открытые задачи вместо 10–12;
- поручения выполняются с первого раза, без многократных возвратов.

### Жёсткие инварианты (не нарушать)

1. **Policy Gate вне LLM.** LLM никогда напрямую не вызывает инструменты с побочными эффектами: отправку писем, создание или перенос встреч, постановку задач, согласования. Любой такой вызов проходит через детерминированный `PolicyGate` (раздел 4.1).
2. **Защищённые категории — всегда с подтверждением.** Кадры, письма руководству и обязательства клиентам нельзя перевести в авто ни правилом, ни словами, ни режимом тени. Деньги — тоже, кроме сумм **не выше** `budgetAutoLimit` (по умолчанию `0`, то есть всегда спрашивать).
3. **Fail closed.** Если категорию определить не удалось, уверенность классификатора ниже порога или сработал хотя бы один детерминированный сигнал риска, действие уходит на подтверждение.
4. **Демо-время через `clock.now()`.** Время идёт, но со смещением относительно реального (раздел 4.7). Прямой `new Date()` в бизнес-логике запрещён.
5. **Изоляция данных.** Все запросы к БД, векторной памяти и коннекторам фильтруются по `leaderId`. Второй руководитель подключается **без правки кода**: импортом `leader_profile.md` или мастером в вебе.
6. **Переключаемость LLM.** Работа с моделями идёт только через адаптер `packages/core/llm` (Vercel AI SDK). Облачные модели меняются на российские или локальные (GigaChat, YandexGPT, vLLM, Ollama) через OpenAI-совместимый эндпоинт изменением env.
7. **Этика.** Во всех исходящих коммуникациях — встречи, сообщения сотрудникам — агент представляется как «ИИ-помощник <Имя руководителя>».
8. **Учёт стоимости.** Каждый вызов LLM, STT, TTS, аватара и Recall пишется в `UsageLog`. Отсюда выгружается расчёт стоимости одного запроса по шаблону организатора.

---

## 2. Стек и структура

| Слой | Технологии |
|---|---|
| Монорепо | pnpm + Turborepo |
| `apps/web` | Next.js (App Router), TypeScript, shadcn/ui (функциональные каркасы без дизайна), SSE |
| `apps/worker` | Node.js, BullMQ, grammY, собственный тик-планировщик (раздел 4.7) |
| `packages/core` | Vercel AI SDK (`ai`), `@modelcontextprotocol/sdk`, zod, движок правил, Policy Gate |
| `packages/db` | PostgreSQL 16 + pgvector, Prisma, Redis 7 |
| Почта и календарь | Microsoft Graph (`@azure/msal-node`, `@microsoft/microsoft-graph-client`); запасной путь — IMAP/SMTP (`imapflow`, `nodemailer`, `mailparser`); `.ics` — `node-ical`, `rrule`; CalDAV — `tsdav` (P2) |
| Встречи и аватар | Recall.ai (Zoom, Output Media → `/avatar/[token]`), Yandex SpeechKit или ElevenLabs (STT/TTS), сервис потокового аватара (HeyGen или Tavus) |
| Инфраструктура | docker-compose: `web`, `worker`, `postgres`, `redis`, `caddy` (HTTPS) |

```text
/
├── apps/
│   ├── web/                  # Next.js: API, вебхуки, SSE, страницы, /avatar/[token]
│   └── worker/               # BullMQ, тик-планировщик, Telegram-бот, опрос почты, запуск ботов встреч
├── packages/
│   ├── core/
│   │   ├── policy-gate/      # Сигналы риска + правила + права инструментов → allow / approve / deny
│   │   ├── email-triage/     # Группировка повторов, LLM-классификация, маршрутизация
│   │   ├── task-lifecycle/   # Поручения, переносы, автоприёмка, эскалации
│   │   ├── meeting-engine/   # Вопросы по прошлому протоколу, генерация протокола, рассылка
│   │   ├── learning/         # Правила из правок, правила словами
│   │   ├── profile/          # Импорт leader_profile.md → структурированный профиль
│   │   ├── connectors/       # MailConnector (Graph | IMAP), CalendarConnector, MCP-реестр
│   │   ├── llm/              # Адаптер моделей, кэш, учёт стоимости
│   │   └── clock.ts          # Демо-время со смещением
│   └── db/                   # Prisma schema, миграции, seed
├── data/
│   ├── tz_dataset/           # inbox.csv, calendar.ics, org_structure.csv, tasks.csv, leader_profile.md
│   ├── transcripts/          # 5 пар «транскрипт + протокол»
│   └── profiles/             # leader2_profile.md — второй руководитель для демо
├── scripts/
│   └── send-dataset-emails.ts # Отправка писем датасета в реальный тестовый ящик
├── tests/
│   ├── eval-inbox.test.ts
│   └── fixtures/llm-cache.json
├── docker-compose.yml
├── SPEC.md
└── CLAUDE.md
```

---

## 3. Схема данных (`packages/db/prisma/schema.prisma`)

Токены внешних сервисов хранятся зашифрованными (AES-256-GCM, ключ из `ENCRYPTION_KEY`).

Актуальная схема лежит в `prisma/schema.prisma` (Prisma 7) и является источником истины; ниже — её смысловое описание.

```prisma
generator client {
  provider        = "prisma-client-js"
  previewFeatures = ["postgresqlExtensions"]
}

datasource db {
  provider   = "postgresql"
  url        = env("DATABASE_URL")
  extensions = [vector]
}

enum ToolPermission { AUTO APPROVE DENY }

enum EmailCategory {
  HR                // кадры
  MANAGEMENT        // руководство
  MONEY             // деньги и бюджеты
  CLIENT_COMMITMENT // обязательства клиентам
  INVITATION        // приглашения
  REPORT            // отчёты
  STATUS            // статусы
  SALES             // продажи / КП
  ACCESS            // доступы
  CLIENT_SUPPORT    // клиенты (типовые обращения, жалобы)
  NEWSLETTER        // рассылки
  CALENDAR          // календарь
}

enum EmailAction {
  ASK_LEADER // спросить_руководителя
  DIGEST     // в_сводку
  DELEGATE   // делегировать
  IGNORE     // игнорировать
  AUTO       // авто
}

enum DecisionStatus { PENDING APPROVED EDITED_APPROVED DELEGATED REJECTED SNOOZED }

enum TaskStatus {
  NEW
  ACCEPTED
  IN_PROGRESS
  REVIEW            // сдано исполнителем, проверяет ИИ
  RETURNED          // ИИ вернул на доработку
  READY_FOR_LEADER  // проверено ИИ, ждёт «Принять»
  DONE
  ESCALATED
}

enum ChatRole { LEADER EMPLOYEE }

model Leader {
  id                 String   @id @default(cuid())
  slug               String   @unique            // "ivan-petrov"
  name               String
  role               String
  email              String   @unique
  budgetAutoLimit    Float    @default(0)        // ₽; 0 = деньги всегда с подтверждением
  quietHoursStart    String   @default("20:00")
  quietHoursEnd      String   @default("08:00")
  protectedBlocks    String[] @default(["Стратегия", "1:1"])
  quarterGoals       Json                        // string[]
  stylePrompt        String   @db.Text           // манера из «Сделано круто»
  savedMinutesConfig Json                        // раздел 7.3, с обоснованием
  profileMarkdown    String   @db.Text           // исходный leader_profile.md
  profileVersion     Int      @default(1)
  shadowMode         Boolean  @default(false)    // P2
  createdAt          DateTime @default(now())

  employees  Employee[]
  bindings   TelegramBinding[]
  connectors Connector[]
  rules      Rule[]
  routines   Routine[]
  emails     EmailItem[]
  tasks      Task[]
  decisions  Decision[]
  meetings   Meeting[]
  memories   Memory[]
  activity   ActivityLog[]
  usage      UsageLog[]
}

model Employee {
  id                 String   @id @default(cuid())
  leaderId           String
  leader             Leader   @relation(fields: [leaderId], references: [id], onDelete: Cascade)
  externalId         String?  // p02… из org_structure.csv
  name               String
  email              String
  position           String
  relationType       String   // SUBORDINATE | MANAGER | PEER
  responsibilityArea String?  // "продажи, КП" | "сервис, жалобы" | "доступы, ИТ" …
  inviteToken        String   @unique @default(cuid()) // t.me/<bot>?start=<inviteToken>
  tasks              Task[]
  bindings           TelegramBinding[]

  @@unique([leaderId, email])
}

// Один Telegram-чат может играть несколько ролей (демо: 3–4 телефона на 9 ролей)
model TelegramBinding {
  id         String    @id @default(cuid())
  chatId     String
  role       ChatRole
  leaderId   String
  leader     Leader    @relation(fields: [leaderId], references: [id], onDelete: Cascade)
  employeeId String?
  employee   Employee? @relation(fields: [employeeId], references: [id], onDelete: Cascade)
  isActive   Boolean   @default(false) // активный контекст чата; переключение командой /role
  createdAt  DateTime  @default(now())

  @@unique([chatId, leaderId, employeeId])
  @@index([chatId])
}

model Connector {
  id              String   @id @default(cuid())
  leaderId        String
  leader          Leader   @relation(fields: [leaderId], references: [id], onDelete: Cascade)
  name            String   // "Microsoft 365" | "Yandex Mail" | "Custom MCP"
  type            String   // BUILTIN_GRAPH | BUILTIN_IMAP | REMOTE_MCP
  mcpUrl          String?
  encryptedConfig String   @db.Text
  toolPermissions Json     // Record<toolName, ToolPermission>; новые инструменты = APPROVE
  isActive        Boolean  @default(true)
  createdAt       DateTime @default(now())
}

model Rule {
  id                String      @id @default(cuid())
  leaderId          String
  leader            Leader      @relation(fields: [leaderId], references: [id], onDelete: Cascade)
  name              String
  description       String      // человекочитаемо, показывается в UI и Telegram
  condition         Json        // { category?, senderEmail?, relationType?, maxAmount?, keywords? }
  action            EmailAction
  delegateToArea    String?     // ключ поиска по Employee.responsibilityArea
  notifyImmediately Boolean     @default(false)
  expiresAt         DateTime?   // «только на неделю»
  isSystemLocked    Boolean     @default(false) // защищённые категории: нельзя ослабить
  source            String      // PROFILE_IMPORT | CHAT | EDIT_LEARNING | MANUAL
  priority          Int         @default(100)
  createdAt         DateTime    @default(now())
}

model Routine {
  id                String    @id @default(cuid())
  leaderId          String
  leader            Leader    @relation(fields: [leaderId], references: [id], onDelete: Cascade)
  code              String    // MORNING_DIGEST | WEEKLY_REPORT | DEADLINE_GUARD | CUSTOM
  title             String
  cronExpression    String    // в демо-времени: "30 8 * * 1-5", "0 17 * * 5"
  promptInstruction String    @db.Text
  isActive          Boolean   @default(true)
  lastRunAt         DateTime? // в демо-времени
}

model EmailItem {
  id                String        @id @default(cuid())
  leaderId          String
  leader            Leader        @relation(fields: [leaderId], references: [id], onDelete: Cascade)
  externalId        String?       // m001… или id сообщения из почтового ящика
  threadKey         String        // sha256(lower(senderEmail) | normalizedSubject | normalizedBody)
  occurrence        Int           @default(1) // 1 — первое письмо, 2+ — повторы
  senderName        String
  senderEmail       String
  senderRole        String?
  subject           String
  body              String        @db.Text
  receivedAt        DateTime
  category          EmailCategory?
  confidence        Float?
  riskSignals       String[]      // сработавшие детерминированные сигналы
  extracted         Json?         // { amount?, client?, deadline?, summary }
  action            EmailAction?
  expectedAction    EmailAction?  // эталон из датасета, только для eval
  decisionId        String?       // повторы ссылаются на ту же карточку
  taskId            String?
  isReadByLeader    Boolean       @default(false)
  createdAt         DateTime      @default(now())

  @@unique([leaderId, externalId])
  @@index([leaderId, threadKey])
}

model Task {
  id                 String     @id @default(cuid())
  externalId         String?    // t001…
  leaderId           String
  leader             Leader     @relation(fields: [leaderId], references: [id], onDelete: Cascade)
  assigneeId         String?
  assignee           Employee?  @relation(fields: [assigneeId], references: [id])
  title              String
  description        String     @db.Text
  acceptanceCriteria String     @db.Text
  isTypical          Boolean    @default(false) // типовую ИИ закрывает сам после проверки
  isClientCommitment Boolean    @default(false)
  sourceType         String     // EMAIL | MEETING | CHAT | DATASET
  sourceRefId        String?
  dueAt              DateTime
  status             TaskStatus @default(NEW)
  csvStatus          String?    // статус из tasks.csv как есть
  rescheduleCount    Int        @default(0)
  returnCount        Int        @default(0) // метрика «с первого раза»
  lastSubmission     String?    @db.Text
  aiReviewComment    String?    @db.Text
  createdAt          DateTime   @default(now())
  updatedAt          DateTime   @updatedAt
}

model Decision {
  id                String         @id @default(cuid())
  leaderId          String
  leader            Leader         @relation(fields: [leaderId], references: [id], onDelete: Cascade)
  type              String         // EMAIL_REPLY | BUDGET_APPROVAL | MEETING_PROTOCOL | TASK_ACCEPT | TASK_RESCHEDULE | CALENDAR_INVITE | RULE_CHANGE | MEMORY_SAVE | TOOL_CALL
  title             String
  contextSummary    String         @db.Text
  gateReasons       String[]       // почему не автоматически
  aiRecommendation  String
  proposedPayload   Json           // { tool, args } — выполнится после «Утвердить»
  draftText         String?        @db.Text
  editedText        String?        @db.Text
  reminderCount     Int            @default(0) // сколько повторов письма привязано
  status            DecisionStatus @default(PENDING)
  telegramMessageId String?
  createdAt         DateTime       @default(now())
  resolvedAt        DateTime?
}

model Meeting {
  id                 String   @id @default(cuid())
  externalId         String?
  leaderId           String
  leader             Leader   @relation(fields: [leaderId], references: [id], onDelete: Cascade)
  title              String
  category           String   // OPERATIONAL | MONEY | CLIENT | PARTNER | MANAGEMENT | ONE_ON_ONE
  startAt            DateTime
  endAt              DateTime
  meetingUrl         String?
  participationMode  String   @default("LEADER") // LEADER | AVATAR | ASYNC_STATUS
  avatarToken        String   @unique @default(cuid()) // для публичной страницы аватара
  recallBotId        String?
  previousMeetingId  String?
  agendaQuestions    Json?
  transcript         String?  @db.Text
  protocolMarkdown   String?  @db.Text
  protocolReadyAt    DateTime? // метрика «время от конца встречи до протокола»
  isProtocolApproved Boolean  @default(false)
  createdAt          DateTime @default(now())
}

model Memory {
  id         String   @id @default(cuid())
  leaderId   String
  leader     Leader   @relation(fields: [leaderId], references: [id], onDelete: Cascade)
  sourceType String   // EDIT_LEARNING | VOICE_NOTE | EXPLICIT
  ruleText   String
  scope      String   @default("GLOBAL") // GLOBAL | EMAIL | MEETING | TASK
  isActive   Boolean  @default(true)
  createdAt  DateTime @default(now())
}

model ActivityLog {
  id           String   @id @default(cuid())
  leaderId     String
  leader       Leader   @relation(fields: [leaderId], references: [id], onDelete: Cascade)
  pipeline     String   // EMAIL | MEETING | TASK | CALENDAR | ROUTINE | GATE
  action       String
  reason       String   // ответ на «почему ты так сделал?»
  savedMinutes Int      @default(0)
  metadata     Json?
  createdAt    DateTime @default(now())
}

model UsageLog {
  id               String   @id @default(cuid())
  leaderId         String
  leader           Leader   @relation(fields: [leaderId], references: [id], onDelete: Cascade)
  pipeline         String   // EMAIL_TRIAGE | PROTOCOL_GEN | TASK_REVIEW | PROFILE_IMPORT | CHAT | AVATAR_SESSION
  provider         String
  model            String
  promptTokens     Int      @default(0)
  completionTokens Int      @default(0)
  audioSeconds     Float    @default(0)
  cached           Boolean  @default(false)
  costRub          Float    @default(0)
  createdAt        DateTime @default(now())
}
```

---

## 4. Модули ядра (`packages/core`)

### 4.1. Policy Gate — P0

Единая точка перехвата всех мутирующих вызовов, встроенных и MCP.

**`evaluate(leaderId, toolName, args, context) → { verdict: ALLOW | APPROVE | DENY, reasons: string[] }`**

Шаги выполняются по порядку. Первый сработавший `DENY` или `APPROVE` фиксируется, но причины собираются по всем шагам.

1. **Детерминированные сигналы риска.** Не зависят от LLM, работают по тексту, адресатам и оргструктуре:

   Регулярки применяются к `lower(subject + body)`. Роли берутся из оргструктуры профиля, а не из кода.

   | Сигнал | Условие | Тип |
   |---|---|---|
   | `MANAGER_PARTY` | отправитель или получатель — `relationType = MANAGER` | жёсткий |
   | `HR_PARTY` | отправитель — HR-партнёр | жёсткий |
   | `FINANCE_PARTY` | отправитель — финансовый контроль | жёсткий |
   | `HR_TERMS` | `отпуск\|оффер\|найм\|увольн\|больничн\|зарплат\|кандидат` | жёсткий |
   | `COMMITMENT_TERMS` | внешний домен **и** `срок\|гарантир\|подтвердите\|запуск\|sla` | жёсткий |
   | `MONEY_APPROVAL` | `₽\|руб\|тыс\|млн\|\d+\s?%\|бюджет\|скидк\|закупк\|оплат` **и** `согласу(й\|ешь\|йте)\|нужно согласование\|прошу[^.]{0,30}(подтвердить\|согласовать\|утвердить)` | жёсткий |
   | `EXTERNAL_INVITATION` | внешний домен **и** `приглаша\|выступить\|спикер` | жёсткий |
   | `MONEY_TERMS` | только денежная часть `MONEY_APPROVAL`, без просьбы согласовать | мягкий |

   Как сигналы влияют на результат:
   - **Жёсткие** → всегда `APPROVE`. Они же на этапе разбора почты принудительно ставят `ASK_LEADER`, даже если LLM выбрала другую категорию (раздел 4.2).
   - **Мягкий `MONEY_TERMS`** → `APPROVE` только для действий, которые отвечают наружу, что-то согласуют или берут обязательство. На внутреннее делегирование, сводку и архив он не влияет: в датасете «бюджет согласован» есть в запросе КП (эталон — делегировать), а проценты — в отчётах (эталон — в сводку).
   - Исключение для денег ниже порога — шаг 3.

   Проверено на 17 уникальных тредах датасета: жёсткие сигналы срабатывают на всех 8 тредах с эталоном «спросить руководителя» и ни на одном из 9 остальных. Значит, защищённые письма уходят руководителю, даже если LLM ошибётся с категорией. Этот прогон должен быть отдельным детерминированным тестом без LLM (`tests/risk-signals.test.ts`).

2. **Защищённые категории.** `context.category ∈ {HR, MANAGEMENT, CLIENT_COMMITMENT}` → `APPROVE`. Если уверенность классификатора ниже `0.7`, тоже `APPROVE`.

3. **Деньги.**
   - Сумма извлечена и `amount ≤ leader.budgetAutoLimit` (при `budgetAutoLimit > 0`) → разрешено при условии, что нет других сигналов, кроме `MONEY_TERMS` и `FINANCE_PARTY`.
   - Сумма не извлечена или превышает порог → `APPROVE`.

4. **Защищённое время.** Календарная операция пересекается со слотом, в названии которого есть строка из `leader.protectedBlocks` → `APPROVE`.

5. **Права инструмента** из `Connector.toolPermissions`: `DENY` → заблокировать, `APPROVE` → карточка `Decision`, `AUTO` → выполнить.

6. **Режим тени (P2).** При `leader.shadowMode = true` любой `ALLOW` превращается в `APPROVE` с пометкой «режим тени». Совпадения решений руководителя с рекомендацией считаются по категориям.

Каждый вердикт пишется в `ActivityLog` (`pipeline = GATE`) с причинами. `ALLOW` начисляет `savedMinutes`.

### 4.2. Разбор почты — P0

Источник писем — `MailConnector` (Graph или IMAP) либо загрузка датасета.

1. **Группировка повторов.** `threadKey = sha256(lower(senderEmail) | normalize(subject) | normalize(body))`. Нормализация: нижний регистр, схлопывание пробелов, удаление `Re:` и `Fwd:`.
   - Каждая строка сохраняется как отдельный `EmailItem`, повторы не выбрасываются.
   - Первое письмо треда (`occurrence = 1`) классифицируется и маршрутизируется.
   - Повтор наследует категорию и действие первого письма. Если у треда есть `PENDING Decision`, повтор к нему привязывается: `reminderCount += 1`, карточка в Telegram обновляется («напоминание №N»), новая не создаётся. Если тред уже решён, повтор попадает в сводку.
   - В датасете 80 строк и **17 уникальных тредов**. LLM вызывается 17 раз.

2. **Классификация** (`generateObject` + zod, `temperature 0`, кэш по `threadKey`): категория из 12, `confidence`, сущности (`amount` в ₽, `client`, `deadline`, `isUrgent`), суть в одно предложение.

3. **Маршрутизация.** Таблица по умолчанию; правила профиля и пользователя могут её дополнять, но не ослаблять защищённые категории:

   | Категория | Действие | Что происходит |
   |---|---|---|
   | HR, MANAGEMENT, MONEY, CLIENT_COMMITMENT, INVITATION | `ASK_LEADER` | Черновик ответа в стиле руководителя с учётом `Memory` → `Decision` |
   | REPORT, STATUS | `DIGEST` | Не отвечать, включить в сводку; риски выделить |
   | SALES, ACCESS, CLIENT_SUPPORT | `DELEGATE` | Исполнитель по `responsibilityArea` (КП → директор по продажам, жалоба → сервис, доступы → ИТ) → `Task` + уведомление в сводке |
   | NEWSLETTER | `IGNORE` | Архивировать |
   | CALENDAR | `AUTO` | Подтвердить или перенести внутреннюю встречу, если не задеты защищённые блоки; иначе `ASK_LEADER` |

4. **Принудительная эскалация.** Если на письме сработал любой жёсткий сигнал (раздел 4.1), действие = `ASK_LEADER` независимо от категории LLM. Это защищает от ошибки классификатора.
5. Все мутирующие действия идут через Policy Gate.

### 4.3. Цикл задачи — P0 (постановка), P1 (контроль и автоприёмка)

1. **Постановка (P0).** Из письма, протокола или команды в чате. LLM обязательно формулирует `acceptanceCriteria` (измеримый результат) и `dueAt`; если срок не назван — запрашивает у руководителя.
2. **Назначение (P0).** Бот пишет исполнителю: «Здравствуйте, я ИИ-помощник <Имя>. Новая задача: … Срок: … Критерий готовности: …». Кнопки: `[Принял] [Уточнить] [Не успею]`. Если исполнитель ещё не запускал бота, задача ждёт, а руководителю в сводку уходит ссылка-приглашение `t.me/<bot>?start=<inviteToken>`.
3. **Перенос (P1).** `[Не успею]` → новая дата и причина. Если задача не клиентская, сдвиг не больше 2 рабочих дней и `rescheduleCount = 0`, бот переносит сам и пишет в сводку. Иначе — `Decision` руководителю.
4. **Контроль (P1).** За 24 ч до срока — чек-ин исполнителю. При просрочке — напоминание; через 24 ч просрочки — `ESCALATED` и карточка руководителю.
5. **Автоприёмка (P1).** `[Сдать результат]` → текст, ссылка или файл → LLM сверяет с `acceptanceCriteria` по чек-листу.
   - Не соответствует: `RETURNED`, `returnCount += 1`, бот сам отвечает исполнителю списком недочётов.
   - Соответствует: при `isTypical = true` → `DONE`; иначе → `READY_FOR_LEADER` и одна карточка `[Принять]`.
6. **Просрочка для задач из датасета:** задача просрочена, если `dueAt < clock.now()` **или** `csvStatus = "просрочена"`.

### 4.4. Обучение на правках и правила словами

1. **Обучение на правках (P0).** Руководитель жмёт `[Править]` и присылает текст (голос — P2).
   - Сохраняется `editedText`, выполняется целевое действие.
   - Фоново вызывается `extractRuleFromEdit(draftText, editedText, context)`.
   - Если найдено устойчивое отличие, бот пишет: «Заметил правку: <правило>. Запомнить?» `[Да, запомнить] [Только этот раз]`.
   - «Да» создаёт `Memory`, и правило подмешивается в следующие черновики того же `scope`.
2. **Правила словами (P1).** «Письма от Орлова присылай сразу» → LLM строит diff `Rule` → бот показывает его человекочитаемо `[Сохранить] [Только на неделю] [Отмена]`. Попытка ослабить системное правило (`isSystemLocked`) отклоняется с объяснением.

### 4.5. Встречи, аватар и протоколы

1. **Протокол из транскрипта (P0).**
   - Вход: транскрипт от Recall (вебхук завершения) или файл из `data/transcripts/` (резервное демо).
   - Генерация few-shot по 5 эталонным протоколам. Формат:
     - `## Информация о встрече` — дата, ссылка, участники;
     - `## Заметки о встрече` — тематические блоки и решения;
     - `## Поручения` — таблица «Задача | Исполнитель | Срок | Критерий готовности».
   - Сохраняется `protocolReadyAt` (метрика «время до протокола»).
   - Карточка `Decision` (`MEETING_PROTOCOL`). После `[Утвердить]`: рассылка участникам через `MailConnector`, создание `Task` и отправка исполнителям, создание следующей встречи в календаре (P1: подбор слота; P2: `findMeetingTimes`).
2. **Вопросы по прошлому протоколу (P0).** Перед встречей формируются `agendaQuestions` по незакрытым поручениям прошлого протокола той же серии встреч.
3. **Аватар (P0 минимум, ведётся параллельно с первого часа).**
   - Если `participationMode = AVATAR`, воркер за 1 мин до начала создаёт бота Recall для `meetingUrl` с `output_media.camera` = `${APP_URL}/avatar/${avatarToken}`.
   - Сценарий: представиться ИИ-помощником руководителя → зачитать `agendaQuestions` → зафиксировать ответы → подвести итог.
   - Минимум P0: страница с образом руководителя и речью TTS по событиям SSE `avatar.speak`.
   - P1: потоковый аватар с синхронизацией губ.
   - Запасной вариант: статичное изображение + звук.
4. **Досье перед 1:1 и встречей с партнёром (P2).** За 15 мин до события: открытые задачи, просрочки, последние письма участника.

### 4.6. Импорт профиля руководителя — P0

`importProfile(markdown) → ProfileDraft` (LLM + zod):
- цели квартала;
- «никогда без подтверждения» → `Rule` с `isSystemLocked = true`;
- «можно без подтверждения» → `Rule`;
- карта делегирования → `delegateToArea`;
- каналы и ритм → `Routine` (утренний план, итог недели);
- стиль → `stylePrompt`;
- `budgetAutoLimit`, если указан.

Порядок: черновик → diff-превью в вебе → подтверждение → запись с `profileVersion += 1`. Сидер создаёт обоих руководителей через этот же импорт: из `data/tz_dataset/leader_profile.md` и `data/profiles/leader2_profile.md`.

Проверка организаторов: «скопировать `leader_profile.md`, поменять цели и правила — агент работает без изменения кода». Это ровно этот путь.

### 4.7. Демо-время — P0

- `clock.now() = realNow() + offsetMs`.
- `offsetMs` считается при первом запуске так, чтобы «сейчас» = `APP_DEMO_START` (по умолчанию `2026-12-07T08:30:00+03:00`), и хранится в Redis, общий для `web` и `worker`.
- `POST /api/demo/clock` с `{ advanceMinutes }` перематывает время, `{ reset: true }` сбрасывает.
- `APP_CLOCK_MODE=real` отключает смещение.
- **Планировщик.** Cron-повторы BullMQ работают в реальном времени, поэтому рутины запускает собственный тик: раз в минуту воркер берёт `clock.now()` и через `cron-parser` проверяет, какие `Routine` и проверки сроков должны были сработать после `lastRunAt`, и ставит их в очередь BullMQ.

### 4.8. Коннекторы и MCP

- **`MailConnector` (P0):** реализации `GraphMail` и `ImapMail` с общим интерфейсом `listNew()`, `send()`, `archive()`. Активная выбирается по `Connector` руководителя.
- **`CalendarConnector`:** P0 — чтение `calendar.ics` и запись событий через Graph; P2 — CalDAV.
- **Удалённый MCP (P2):** `POST /api/connectors` с `{ mcpUrl }` → `list_tools` → инструменты сохраняются с правом `APPROVE` → матрица прав в UI. Все вызовы идут через Policy Gate.

---

## 5. Воркер (`apps/worker`)

1. **Telegram-бот (grammY) — P0.**
   - Один бот для всех ролей. Входящие маршрутизируются через `TelegramBinding` по `chatId`.
   - Если у чата несколько ролей, используется активная; команда `/role` переключает её.
   - `/start <inviteToken>` создаёт привязку сотрудника, `/start <leaderSlug>:<secret>` — руководителя.
   - Callback-кнопки: `decision:approve|edit|delegate|snooze:{id}`, `task:accept|clarify|reschedule|submit:{id}`, `memory:save|skip:{id}`, `rule:save|week|cancel:{id}`.
   - Голосовые (P2): `.ogg` → STT → текст в диалог или в правку карточки.
2. **Рутины (тик-планировщик, демо-время):**
   - Пн–Пт 08:30 — **утренний план (P0):** 3–4 приоритета (цели квартала + сроки + встречи дня), число решений в очереди, что сделано автоматически, сэкономленные часы.
   - Пт 17:00 — **итог недели (P1):** часы (`SUM(savedMinutes)/60`), письма авто vs с подтверждением, открытые задачи утром было → стало, возвраты задач, среднее время до протокола.
   - Каждые 30 мин демо-времени — проверка сроков (P1).
   - Каждые 2 мин реального времени — новые письма и предстоящие встречи с `AVATAR` (P0).
3. **Антиспам (P1).** Срочное сразу, остальное копится в сводку. В тихие часы — только защищённые категории с `notifyImmediately`.

---

## 6. API для фронтенда (`apps/web`)

| Маршрут | Метод | Назначение | P |
|---|---|---|---|
| `/api/stream?leaderId=` | GET (SSE) | `decision.created`, `decision.updated`, `email.processed`, `task.updated`, `metrics.updated`, `avatar.speak` | P0 |
| `/api/dashboard/today` | GET | `{ priorities, decisions, metrics: { savedHours, autoEmailsPct, unreadBefore, unreadAfter, openTasksMorning, firstTimeRightPct, avgProtocolMinutes } }` | P0 |
| `/api/decisions/[id]/resolve` | POST | `{ action: APPROVE \| EDITED_APPROVED \| DELEGATE \| REJECTED \| SNOOZE, editedText?, delegateToId? }` | P0 |
| `/api/leaders` | GET / POST | Список профилей, создание через мастер | P0 |
| `/api/leaders/import` | POST | `{ markdown }` → черновик профиля и diff; `{ confirm: true, draftId }` → сохранить | P0 |
| `/api/rules` | GET / POST / PATCH | Правила, порог бюджета, защищённые блоки; системные правила нельзя ослабить | P0 |
| `/api/demo/simulate` | POST | `{ scenario: INGEST_DATASET \| TRIGGER_MORNING \| TRIGGER_EMAIL_BATCH \| RUN_MEETING_TRANSCRIPT \| TRIGGER_WEEKLY, transcriptName? }` | P0 |
| `/api/demo/clock` | POST | `{ advanceMinutes }` или `{ reset: true }` | P0 |
| `/api/eval/inbox` | GET | Последний отчёт прогона `eval-inbox` | P0 |
| `/avatar/[token]` | Page | Публичная страница для камеры Recall: SSE `avatar.speak`, TTS, видео аватара | P0 |
| `/api/chat` | POST | Стриминговый чат: статусы, поручения, правила словами | P1 |
| `/api/tasks` | GET / POST | Реестр поручений | P1 |
| `/api/connectors` | GET / POST | Подключения; `POST { mcpUrl }` → `list_tools` | P2 |
| `/api/connectors/[id]/permissions` | PATCH | `AUTO / APPROVE / DENY` для инструмента | P2 |

Страницы (каркасы без дизайна): P0 — «Сегодня», «Правила», «Профили»; P1 — «Чат», «Задачи», «Рутины»; P2 — «Подключения».

---

## 7. Датасет, оценка и метрики

### 7.1. Сидер (`packages/db/prisma/seed.ts`) — P0

1. Руководитель 1 — импорт `data/tz_dataset/leader_profile.md` (раздел 4.6); сотрудники из `org_structure.csv` с `relationType` и `responsibilityArea`.
2. Руководитель 2 — импорт `data/profiles/leader2_profile.md`: другие цели, правила и `budgetAutoLimit`, свои сотрудники.
3. `calendar.ics` — 50 встреч 7–18.12 с категориями. Ежедневные планёрки по умолчанию `ASYNC_STATUS` или `AVATAR` по правилам профиля.
4. `tasks.csv` — 12 задач; `csvStatus` сохраняется как есть, просрочка по правилу 4.3.6.
5. 5 пар «транскрипт + протокол» — эталоны для few-shot и резервного демо.
6. `inbox.csv` — через пайплайн 4.2 (с `expectedAction` для eval).
7. Одно дополнительное письмо на небольшую сумму (ниже `budgetAutoLimit` руководителя 2) — для демонстрации порога. Помечено как добавленное командой, в eval не входит.

### 7.2. Тест качества (`tests/eval-inbox.test.ts`) — P0

LLM вызывается с `temperature 0` через кэш `tests/fixtures/llm-cache.json`: при наличии ответа в кэше — без сети, флаг `--refresh` обновляет кэш.

Ассерты:
1. 80 строк → 17 тредов; каждая строка получила действие.
2. Точность по `expected_action` на **всех 80 строках** ≥ 95%.
3. **Безопасность:** ни одна из 40 строк с эталоном `спросить_руководителя` (36 — кадры, руководство, деньги, обязательства клиентам; 4 — приглашения) не выполнена автоматически. Ожидается 0.
4. Ни один повтор не создал новую карточку `Decision`: повторы письма Павловой (6 строк) дают одну карточку с `reminderCount = 5`.
5. Вызовов LLM на классификацию — 17.

Отдельно `tests/risk-signals.test.ts` (без LLM, детерминированный): жёсткие сигналы срабатывают на всех 40 строках с эталоном `спросить_руководителя` и ни на одной из остальных 40.

Отчёт сохраняется в JSON и отдаётся через `/api/eval/inbox` для дашборда.

### 7.3. Экономия времени (`savedMinutesConfig`, по умолчанию)

Значения хранятся в профиле, а не в коде. На питче показываем их вместе с обоснованием.

| Действие | Минут | Обоснование |
|---|---|---|
| Рассылка отписана / архивирована | 1 | Открыть, понять, удалить |
| Отчёт или статус в сводку | 3 | Прочитать письмо целиком против строки в сводке |
| Делегирование с постановкой задачи | 8 | Прочитать, решить кому, написать поручение со сроком |
| Встреча подтверждена или перенесена | 5 | Переписка о времени |
| Повтор письма привязан к карточке | 2 | Повторное открытие и поиск контекста |
| Черновик ответа, утверждённый без правок | 6 | Написание ответа |
| Протокол встречи | 30 | Разбор заметок, оформление, рассылка |
| Встреча закрыта аватаром или асинхронным статусом | длительность встречи | Время присутствия |
| Возврат на доработку без руководителя | 10 | Проверка результата и обратная связь |

### 7.4. Метрики на дашборде

- Часы, освобождённые за неделю.
- Доля писем без участия руководителя (по эталону потолок около 50%; показываем честно).
- Непрочитанные письма: было → стало.
- Открытые задачи утром: было → стало.
- Задачи «с первого раза»: доля задач с `returnCount = 0` и `rescheduleCount = 0`.
- Среднее время от конца встречи до протокола.
- Число выученных правил из правок.
- Стоимость одного запроса по пайплайнам (из `UsageLog`).

---

## 8. Реальная интеграция почты — P0

- `scripts/send-dataset-emails.ts` отправляет письма датасета в тестовый ящик руководителя (Outlook через Graph, либо Яндекс Почта). По умолчанию — 17 уникальных; флаг `--all` — все 80; флаг `--speed` сжимает интервалы между письмами.
- Воркер забирает новые письма через `MailConnector`, разбор идёт тем же пайплайном.
- Ответы и рассылка протоколов уходят реальными письмами.
- Это и есть демонстрация «реальной интеграции с почтой и мессенджером» из требований.

---

## 9. План работ: параллельные треки

Аватар — самый рискованный кусок. Он идёт **отдельным треком с первого часа**, а не в конце.

| Трек | Содержание | P0 готово к |
|---|---|---|
| **A. Ядро** | Монорепо, Prisma, clock, сидер, импорт профиля → Policy Gate, разбор почты, eval → протоколы, задачи, обучение на правках | 27.11, 14:00 |
| **B. Telegram и воркер** | grammY, привязки и роли, карточки решений, утренний план, тик-планировщик, MailConnector, отправка датасета в ящик | 27.11, 18:00 |
| **C. Встречи и аватар** | Регистрация Recall и Zoom (сразу), страница `/avatar/[token]`, TTS, сценарий вопросов, вебхук транскрипта → протокол | 27.11, 20:00 |
| **D. Веб и стенд** | VPS, домен, HTTPS, docker-compose, деплой; страницы «Сегодня», «Правила», «Профили»; SSE | 27.11, 22:00 |

Контрольные точки:
- **27.11, 10:30** — Q&A с заказчиком: уточнить порог бюджета, Outlook или заглушка, глубину аватара, определение «с первого раза».
- **27.11, 22:00** — все P0 работают сквозным сценарием на стенде.
- **28.11, 06:00** — заморозка функциональности, только исправления.
- **28.11, 07:00–08:30** — запись демовидео (≤ 3 мин, один дубль), заполнение формы, расчёт стоимости.
- **28.11, 09:30** — сдача. Проверить все ссылки в режиме инкогнито.

### Сквозной сценарий демовидео

1. Утренний план 08:30 в Telegram → утвердить решение, одно поправить → «запомнить как правило?».
2. Новые письма в реальном ящике → делегирование, сводка, повтор письма прикрепился к карточке.
3. Аватар на встрече в Zoom задаёт вопросы по прошлому протоколу → протокол в Telegram → утверждение → письмо и задачи исполнителям.
4. Дашборд: метрики и результат eval.
5. Импорт второго профиля → тот же сценарий работает с другими правилами.

---

## 10. CLAUDE.md

Правила для агента лежат в `CLAUDE.md` в корне проекта.
