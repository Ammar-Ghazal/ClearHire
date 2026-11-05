# ClearHire

Built for the **Meta Global AI Developer Hackathon** in the **Indie Developer** track under the **Build for Your World** theme.

## Problem statement

In the current market, recruiters have to search through hundreds of identical AI-generated résumés for every single job opening and engineers are forced to submit thousands of applications just to get a chance at an interview. To resolve this, I've created a job matching platform which analyzes an engineer's personal GitHub portfolio projects and determines which skills they possess and to what proficiency they display them. The aim is to make job searching and recruiting headache-free and more productive for both parties involved.

## Privacy notice

**Live analysis sends selected inputs to Meta.** Both **My profile** analysis and bundled sample regrades use Muse Spark 1.3 Contributor. Meta may use the submitted content, including code excerpts, sample résumé text and job posting text, and model responses to train future models. Browsing the saved demo makes no model calls. [Meta’s model modes](https://dev.meta.ai/docs/models)


## Local setup

Install **Node.js 22.12 or later**, **pnpm 10** (the project uses 10.28.0), and **Docker Desktop** with Docker Compose. Start Docker Desktop before running the commands. Docker runs PostgreSQL 16 on port 5432. The API and web app run locally through pnpm.

### Run the bundled demo

Clone the repository, then from the project directory, run the following:

```bash
cp .env.example .env
pnpm install
pnpm gen:keys
```

Paste the two generated values into the corresponding `SESSION_SECRET` and `TOKEN_ENCRYPTION_KEY` entries in the root `.env` file. Keep that file out of Git.

```bash
pnpm db:up
pnpm db:migrate
pnpm demo:seed load
pnpm dev
```

Open [ClearHire](http://localhost:5173) and choose a sample seeker or employer. The seed includes candidate profiles, saved résumés and skill markers where available, companies, job postings, and saved posting assessments. Sample chats, interviews, offers, and match stages start empty. You can explore existing scores and try the recruiting workflow without a GitHub login or a Muse key.

### How to grade your GitHub repo through Meta API

1. Get a **Meta Model API key** and put it in the root `.env` as `META_API_KEY`. Keep `META_MODEL=muse-spark-1.3-contributor`, then restart `pnpm dev`. The API key provides access, and the model ID selects Contributor mode. [Meta Model API](https://dev.meta.ai/ai)
2. Open [My profile](http://localhost:5173/my-profile) and select **Sign in with GitHub**. Enter the displayed code on GitHub to authorize ClearHire. No GitHub setup is needed: `.env.example` already includes the ClearHire GitHub App’s public client ID. If your authorization expires, sign out and sign in again.
3. Select and save up to ten public repos you own, acknowledge the Contributor privacy notice, then click **Analyze my repos** to create your private skill profile and compare it with a sample job posting.
4. To refresh a bundled sample, return to the demo home page, choose a sample seeker, open **Profile**, and click **Regrade from latest code**. This uses your GitHub authorization to read the sample’s public repositories and the sample candidate’s identity to attribute contributions. A successful regrade can replace the active result in your local database. The first regrade finds the sample's public repos; later ones let you choose which to refresh. If a regrade stops partway, click **Resume interrupted regrade**.

### Reset and checks

- `pnpm demo:reset` clears demo interactions, preferences and priority changes, and keeps saved assessments.
- To restore the original sample assessments after a regrade, use a fresh local database and run `pnpm demo:seed load` again.
- `pnpm typecheck`, `pnpm test` and `pnpm build` verify a local checkout.

### GitHub App configuration (maintainers only)

Judges can skip this. `.env.example` points to the existing ClearHire GitHub App. That app needs **Device Flow** and expiring user tokens enabled, a public registration, webhooks off, and read-only access to **Contents**, **Pull requests** and **Email addresses**. Sign-in only needs the public client ID, so the client secret and callback URLs can stay unused. If you replace the app, update `GITHUB_CLIENT_ID` in `.env`.

## Project overview

### How it works

1. **Collect job seeker evidence.** The API reads the job seeker's selected GitHub repositories as they were at one fixed commit. It uses each repository's commit and pull request history, and GitHub's record of who last changed each line, to work out which lines the job seeker wrote. ClearHire then skips files that aren't useful as evidence before sending the code to Muse Spark. For the bundled demo samples, it also sends the job seeker's résumé text where available.
2. **Assess demonstrated skills.** Muse Spark identifies skills, proposes proficiency levels, and cites the code evidence behind each marker. The API checks citations against the supplied evidence and keeps the file, commit, and line references so reviewers can inspect the supporting work. The result describes what the available evidence demonstrates and flags attribution or coverage gaps.
3. **Assess job postings.** Muse Spark reads the posting and maps requirements to the same skill catalogue, with required proficiency levels, suggested priorities, and supporting references to the posting. Employers can adjust the priorities to reflect what matters most for the role.
4. **Calculate the match.** The API compares the two saved assessments and weights each requirement by its priority. It shows which requirements are met, partly met, or lack sufficient evidence. Scores can be recalculated from the saved assessments when priorities change, without another model call.
5. **Bring the evidence into the workflow.** The React app gives seekers and employers separate views of the same match. They can review the evidence, indicate interest, discuss a match, schedule an interview, and share or respond to an offer. PostgreSQL stores the structured assessments and workflow state locally.

### Tech stack

| Layer | Technology |
| --- | --- |
| Web app | React, TypeScript, Vite, Tailwind CSS, and shadcn/ui |
| API | Node.js, Fastify, TypeScript, and Zod |
| Data | PostgreSQL 16, Drizzle ORM and migrations, and Docker Compose |
| GitHub integration | GitHub App device authorization, Octokit, REST, and GraphQL |
| AI assessment | Meta Model API with Muse Spark 1.3 in Contributor mode |
| Workspace and tests | pnpm workspaces, shared TypeScript schemas, and Vitest |
