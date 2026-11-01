# ClearHire local setup

About 20 minutes. At the end you have the web app on http://localhost:5173, the API on port 3001, Postgres in Docker, and "Sign in with GitHub" working.

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

Open http://localhost:5173. The status pills should read **API: ok**, **Database: ok**, **GitHub App: ok**.

Click **Sign in with GitHub**, approve, and you land back on the page showing your avatar and verified emails. Then click **Install the ClearHire GitHub App and choose repositories**, pick a repo, and you return signed in with "Installed (installation …)".

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
