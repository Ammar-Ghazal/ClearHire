# ClearHire

Built for the **Meta Global AI Developer Hackathon** in the **Indie Developer** track under the **Build for Your World** theme.

## Problem statement

In the current market, recruiters have to search through hundreds of identical AI generated resumes for every single job opening and engineers are forced to submit thousands of applications just to get a chance at an interview. To resolve this, I've created a job matching platform which analyzes an engineer's personal github portfolio projects and determines which skills they posses and to what proficiency they display it. The aim is to make job searching and recruiting headache-free and more productive for both parties involved.

## Privacy notice

**Live analysis sends selected inputs to Meta.** Both **My profile** analysis and bundled sample regrades use Muse Spark 1.3 Contributor. Meta may use the submitted content, including code excerpts, and model responses to train future models. Browsing the saved demo makes no model calls. [Meta’s model modes](https://dev.meta.ai/docs/models)


## Local setup

Install **Node.js 22.12 or later**, **pnpm 10** (the project uses 10.28.0), and **Docker Desktop** with Docker Compose. Start Docker Desktop before running the commands. Docker runs PostgreSQL 16 on port 5432. The API and web app run locally through pnpm.

### Run the bundled demo

Clone the repository or extract the submission archive. From the project directory, run the following.

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

### Try fresh grading

1. Get a **Meta Model API key** and put it in the root `.env` as `META_API_KEY`. Keep `META_MODEL=muse-spark-1.3-contributor`, then restart `pnpm dev`. The API key provides access, and the model ID selects Contributor mode. [Meta Model API](https://dev.meta.ai/ai)
2. Open [My profile](http://localhost:5173/my-profile) and select **Sign in with GitHub**. Enter the displayed code on GitHub to authorize ClearHire. The shipped configuration uses the ClearHire GitHub App’s public client ID, with GitHub Device Flow required on the app registration.
3. Select and save up to ten public repos you own, acknowledge the Contributor privacy notice, then click **Analyze my repos** to create your private skill profile and compare it with a sample job posting.
4. To refresh a bundled sample, return to the demo home page, choose a sample seeker, open **Profile**, and click **Regrade from latest code**. This uses your GitHub authorization to read the sample’s public repositories and the sample candidate’s identity to attribute contributions. A successful regrade can replace the active result in your local database.

Use `pnpm demo:reset` to clear demo interactions and preferences while keeping saved assessments. See the [setup guide](SETUP.md) for GitHub App configuration and reset details.

## Project overview

### Build for Your World

As an indie developer, I built ClearHire around a problem familiar from software job searches. A résumé compresses months of work into a few lines, and a GitHub link leaves the reviewer to figure out what the person actually contributed. Employers face a similar problem when a long job posting mixes core requirements with nice-to-haves. ClearHire uses Muse Spark to turn both sources into comparable skill markers, so seekers and employers can spend less time piecing together evidence and more time discussing the work that matters for the role.

### How it works

1. **Collect seeker evidence.** The API fetches selected GitHub repositories at a pinned commit. GitHub GraphQL history, pull request data, and blame help attribute specific lines to the seeker. ClearHire filters and redacts code excerpts before sending them to Muse Spark, along with résumé context where available for the bundled demo.
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
