# ClearHire local setup

About 20 minutes. At the end you have the web app on http://localhost:5173 (operator tools at `/operator`), the API on port 3001, Postgres in Docker, and "Sign in with GitHub" working.

You do **not** need Meta, Modal, Neon, Vercel or ngrok accounts for this step.

Never paste secrets (client secret, private key, `.env` contents) into a chat. They only go in your local `.env`.

---

## 1. Install the tools (once)

| Tool | Check | Install |
|---|---|---|
| Node.js 22.12 or newer | `node -v` | https://nodejs.org (LTS) or `brew install node@22` |
| pnpm | `pnpm -v` | `corepack enable` (ships with Node), then `corepack prepare pnpm@10.28.0 --activate` |
| Docker Desktop | `docker -v` | https://www.docker.com/products/docker-desktop/ — open it once so the engine is running |

## 2. Put the project in place

```bash
cd ~/Projects
unzip ~/Downloads/clearhire.zip      # or wherever you saved it
cd clearhire
cp .env.example .env
pnpm install
pnpm gen:keys
```

`pnpm gen:keys` prints two lines. Paste them into `.env`, replacing the empty `SESSION_SECRET=` and `TOKEN_ENCRYPTION_KEY=` lines.

## 3. Create the GitHub App (development)

1. Open https://github.com/settings/apps/new
2. Fill in:

   | Field | Value |
   |---|---|
   | GitHub App name | Must be unique on GitHub, e.g. `clearhire-dev-<your-username>` |
   | Homepage URL | `http://localhost:5173` |
   | Callback URL | `http://localhost:5173/api/auth/github/callback` |
   | Expire user authorization tokens | ✅ checked |
   | Request user authorization (OAuth) during installation | ✅ checked |
   | Enable Device Flow | ☐ unchecked |
   | Webhook → Active | ☐ **unchecked** for now (needs a public URL; we add it with ngrok later) |

3. Permissions:

   | Section | Permission | Access |
   |---|---|---|
   | Repository | Contents | Read-only |
   | Repository | Metadata | Read-only (set automatically) |
   | Repository | Pull requests | Read-only |
   | Account | Email addresses | Read-only |

4. "Where can this GitHub App be installed?" → **Any account** (so other people can sign in during the demo).
5. Click **Create GitHub App**. On the next page:
   - Copy **App ID** → `GITHUB_APP_ID`
   - Copy **Client ID** → `GITHUB_CLIENT_ID`
   - Click **Generate a new client secret**, copy it now (shown once) → `GITHUB_CLIENT_SECRET`
   - The app's public page is `https://github.com/apps/<slug>`; put `<slug>` in `GITHUB_APP_SLUG`
   - Scroll down, click **Generate a private key**. A `.pem` file downloads. Keep it somewhere safe outside the project; it is needed in the next step of the build (repo access), not now.

## 4. Start Postgres and create the tables

```bash
pnpm db:up          # starts Postgres 16 in Docker on port 5432
pnpm db:generate    # creates the SQL migration from the Drizzle schema (first time only)
pnpm db:migrate     # applies it
```

Commit the generated `apps/api/drizzle/` folder; future schema changes add new migration files there.

## 5. Run everything

```bash
pnpm dev
```

Open http://localhost:5173/operator (operator tools). The status pills should read **API: ok**, **Database: ok**, **GitHub App: ok**.

Click **Sign in with GitHub**, approve, and you land back on that page showing your avatar and verified emails. Then click **Install the ClearHire GitHub App and choose repositories**, pick a repo, and you return signed in with "Installed (installation …)".

## Run the demo without GitHub or Muse (judges)

About 5 minutes. You need only section 1's tools. No GitHub App, no Meta key, and no paid calls: the seed holds the imported sample profiles, postings and their saved analyses.

```bash
cp .env.example .env
pnpm install
pnpm gen:keys          # paste the two lines into .env
```

In `.env`, leave the `GITHUB_*` and `META_API_KEY` values empty and set `META_MODEL` to the model the saved analyses were made with, so they are recognised as current:

```bash
grep -m1 '"model"' data/demo/seed/demo-seed.json   # e.g. muse-spark-1.3-contributor
```

Then:

```bash
pnpm db:up
pnpm db:migrate
pnpm demo:seed load    # sample profiles, postings and saved analyses; never calls GitHub or Muse
pnpm dev
```

Open http://localhost:5173 and choose a demo identity: a sample job seeker or employer. It is not a sign-in. Try a full flow by switching between the two sides of one match:

1. Seeker answers Yes or Maybe; employer answers. Two Yes answers open Interview; any Maybe opens Discussion, where both confirm to move on.
2. Employer proposes interview times (Interviews page); seeker confirms one.
3. Employer drafts and shares an offer from the match; seeker accepts or declines it on the Offers page.

Scores appear only where both the seeker and the posting have a current saved analysis; every other match names why it has none (for example "Not analyzed yet"). Priorities can be edited on a posting that has a current analysis.

### Reset the demo

```bash
pnpm demo:reset
```

Clears answers, Discussion, interviews, offers, seeker preferences and priority changes. Sample profiles, postings and saved analyses stay, so scores are unchanged.

### Refresh the seed (demo operators)

After running analyses from the operator page (http://localhost:5173/operator, GitHub sign-in, paid), write the current database to the seed:

```bash
pnpm demo:seed export
```

## Checks if something is off

| Symptom | Fix |
|---|---|
| API exits with "Invalid configuration in .env" | The message names the variable; usually `pnpm gen:keys` was not pasted |
| Database: not ready | Docker Desktop not running, or `pnpm db:up` not run. `docker compose ps` should show `db` healthy |
| GitHub App: not ready | `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` empty; restart `pnpm dev` after editing `.env` |
| "callback URL does not match" | The App's Callback URL must be exactly `http://localhost:5173/api/auth/github/callback` |
| Verified emails: none visible | Add the Account → Email addresses: Read-only permission, then sign out and in again |
| Port already in use | Something else uses 5173, 3001 or 5432; stop it or change `PORT` / the compose port and `DATABASE_URL` |

Useful commands: `pnpm typecheck`, `pnpm test`, `pnpm build`, `curl localhost:3001/health`.

## Not needed yet (later steps)

| Account | Needed for |
|---|---|
| Meta Model API key | Claim extraction and code analysis |
| ngrok (free) | Public URL for GitHub webhooks |
| Modal ($30 free monthly credits) | Hosting the API and Sandboxes |
| Neon (free) | Production Postgres |
| Vercel (free) | Hosting the frontend |
