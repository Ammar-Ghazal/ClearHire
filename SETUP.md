# Run ClearHire locally

Install Node.js 22.12 or later, pnpm 10, and Docker Desktop. Open Docker Desktop before starting.

```bash
cp .env.example .env
pnpm install
pnpm gen:keys
```

Paste the two generated values into `.env`. Keep `.env` out of source control. Then run:

```bash
pnpm db:up
pnpm db:migrate
pnpm demo:seed load
pnpm dev
```

Open [ClearHire](http://localhost:5173) and choose a sample seeker or employer. The bundled profiles and saved skill markers can be explored without GitHub sign-in or a Muse API key. The checked-in seed includes saved candidate skill markers and job requirements. Where both sides have a compatible saved assessment, ClearHire calculates the match score. Chats, interviews, offers, and match stages start empty.

## Try fresh analysis as a judge

1. Put your Muse key in `.env` as `META_API_KEY` and restart ClearHire. Keep the supplied `META_MODEL` value for the bundled demo. Your own profile uses standard Muse, and the first run also analyzes a sample posting in that model.
2. Open [My profile](http://localhost:5173/my-profile) and choose **Sign in with GitHub**. Enter the displayed code on GitHub and approve the connection. Return to ClearHire when approval completes.
3. Select and save up to ten public repositories you own. Choose **Analyze my repos** to create your private skill profile and see its match against a sample posting.
4. To refresh a bundled candidate, choose that sample seeker on the demo home page and open their **Profile**. Choose **Regrade from latest code**. The first run discovers the candidate's public repos; subsequent runs allow you to choose which repos to refresh. A successful refresh can supersede the saved results in your local database. If it stops partway through, use **Resume interrupted regrade**.

Fresh runs use your GitHub authorization and make Muse calls against your key. Both Muse model variants must be available to try both flows. If GitHub authorization expires, sign out and sign in again.

## Maintainer setup for GitHub sign-in

The distributed `.env.example` points to the existing ClearHire GitHub App. In its settings, enable **Device Flow** and expiring user authorization tokens. Use a public registration, disable webhooks, and grant read-only access for **Contents**, **Pull requests**, and the account’s **Email addresses**. GitHub supplies Metadata read access. If you replace the registration, update `GITHUB_CLIENT_ID` with the new App’s public client ID. [ClearHire GitHub App settings](https://github.com/settings/apps/clearhire-dev-ammar-ghazal)

Before distributing, verify sign-in with a second account and confirm that a public repository produces line-level evidence. Also test a sample regrade with that account. [GitHub device flow documentation](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)

## Resetting

`pnpm demo:reset` clears demo interactions and preferences. It keeps saved assessments. To see the original checked-in sample assessments after regrading, use a fresh local database and run the seed load again.

Use `pnpm typecheck`, `pnpm test`, and `pnpm build` to verify a local checkout.
