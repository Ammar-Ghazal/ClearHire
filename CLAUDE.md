# ClearHire
- Job matching platform: verifies candidates' claims against evidence in their GitHub repos, then matches verified candidates to employer postings
- pnpm monorepo: `apps/api` (Fastify, Drizzle, Postgres), `apps/web` (React 19, Vite, Tailwind v4), `packages/shared` (zod schemas)
- Renamed from HireProof: any leftover `hireproof` / `hp_` should become `clearhire` / `ch_`

# Commands
- Package manager: pnpm (Node >= 22.12)
- Start Postgres (needed before dev or migrate):
`pnpm db:up`
- Dev server (API :3001, web :5173):
`pnpm dev`
- Typecheck:
`pnpm typecheck`
- Tests (vitest, only in apps/api):
`pnpm test`
- Single test:
`pnpm --filter @clearhire/api exec vitest run src/lib/crypto.test.ts`
- Check changes with `pnpm typecheck && pnpm test`

# Database
- Use Drizzle ORM for database access
- Schema lives in `apps/api/src/db/schema.ts`
- After schema changes run `pnpm db:generate`, then `pnpm db:migrate`, and commit the new files in `apps/api/drizzle/`
- Never manually modify generated migration files or `drizzle/meta/`
- Encrypt GitHub tokens with `encrypt()` from `lib/crypto.ts` before storing them

# API
- Read config only through `env` from `src/env.ts`, never `process.env`
- Relative imports use `.js` suffixes
- Validate query and body input with zod `safeParse`
- Error responses use the shape `{ error: { code, message } }`; never send internal details to the client
- Register new route plugins in `src/app.ts`
- Routes have no `/api` prefix (Vite strips it in dev)

# Shared types
- Any request or response shape used by both apps goes in `packages/shared/src/index.ts` as a zod schema plus a `z.infer` type
- The web app parses API responses with these schemas

# Frontend
- Style with Tailwind utility classes, using the existing slate palette
- Call the API through `src/api.ts` with `credentials: 'include'`

# Conventions
- Code style: single quotes, semicolons, trailing commas, 2-space indent, about 100-character lines
- No `.prettierrc` yet: don't run `pnpm format` until one matches the current style
- Cite requirement IDs (e.g. `R-3.3`) in comments when implementing a requirement; the spec is not in this repo, so ask for its text if needed
- Never read, edit or print `.env` or `.env.example`; ask the user to change values
