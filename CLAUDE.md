# Project rules
- Read SPEC.md before creating or changing modules. Respect P0/P1/P2: no P1 work until all P0 work end-to-end.
- Strict TypeScript (noImplicitAny). Zod on every external input and every LLM structured output.
- No mutation of external state (mail, calendar, Telegram to employees, tasks, approvals) except through the policy gate (`src/core/policy-gate`).
- Protected categories (HR, MANAGEMENT, CLIENT_COMMITMENT; MONEY above budgetAutoLimit) can never become AUTO. Fail closed on uncertainty.
- Use `clock.now()` from `src/core/clock.ts`, never `new Date()` in business logic.
- Every query is scoped by leaderId. No leader-specific logic in code — it lives in the profile and rules.
- All LLM calls go through `src/core/llm` (cost logging + cache). temperature 0 for classification.
- The agent always introduces itself as "ИИ-помощник <leader name>".
- UI: unstyled functional skeletons only; design is applied separately.
- Run `npm test` after changing `src/core`. `tests/eval-inbox.test.ts` and `tests/risk-signals.test.ts` must stay green.
- Commit small and often; the last commit before 28.11.2026 10:00 MSK is what gets graded.

# Deviations from SPEC.md (deliberate, for the 40-hour deadline)
- Single npm package instead of pnpm + Turborepo monorepo. Mapping of SPEC paths:
  - `packages/core/*` → `src/core/*`
  - `packages/db` → `prisma/` (schema, seed) + `src/db/` (client)
  - `apps/web` → `src/app/` (Next.js)
  - `apps/worker` → `worker/` (separate Node process, run with `tsx`, imports `@/core/*`)
- Prisma 7 (classic `schema.prisma`, `prisma-client` generator, `@prisma/adapter-pg`). Prisma 8 RC was removed.
- No pgvector: memory is looked up by `scope`, not by embeddings. Plain `postgres:17`.
- Dataset lives in `data/` (see SPEC section 2); tests read it directly.
- Learning mode (SPEC 1.1): exit by area is stored as `Leader.trustedScopes` (email categories + `TASK_ASSIGN`), not as a `Rule`. Gate step 7 only tightens; locked categories can never be trusted. `approvedByLeader` in `GateContext` lifts only step 7 (card approved, approved protocol, budget threshold, avatar chosen).
