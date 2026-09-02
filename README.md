# jobjam-webmcp

The [WebMCP](https://github.com/webmachinelearning/webmcp) tool layer that makes
[JobJam](https://www.jobjam.io) operable by a browser agent.

JobJam is an AI job-application workspace: a live job board built from company
applicant-tracking systems, resume evaluation against a posting, resume
optimization, cover-letter drafting and application tracking. This repository is
the layer that exposes that product to an agent running in the page, so a person
can say *"find senior frontend roles in Germany, rank them against my resume,
save the best three and prepare an application for the top one"* and watch the
site do it.

It is MIT licensed. JobJam's application code is closed; the agent surface is
not, because how a website hands control to an agent is the part worth arguing
about in public.

## The idea

Most attempts to let an agent use a website end up scraping the DOM or handing a
long-lived API token to a server the user cannot see. WebMCP replaces both: the
site registers typed tools with the browser, and the agent calls them.

That yields a property this layer is built around:

> **Tool handlers are the page's own JavaScript, so `fetch` is same-origin and
> the browser attaches the session cookie the user already has. The agent
> supplies arguments and reads results. It never sees a credential.**

JobJam's session is an HttpOnly Supabase cookie with row-level security behind
it. Page JavaScript cannot read the token, so neither can a tool, so neither can
the agent. An agent that invents an id belonging to another user gets zero rows
from Postgres, not an error message it can learn from. Nothing about
authentication had to change to support any of this.

## The tools

Read-only. Free, no confirmation, safe to call unprompted.

| Tool | What it does |
|---|---|
| `search_jobs` | Searches live postings by role, country, region, work model, seniority and stack. Also filters the visible job board. |
| `get_job_details` | One posting with its full description text. Selects it in the board. |
| `get_my_profile` | The signed-in user's profile and the skills, seniority and location derived from their resume. |
| `rank_jobs_for_me` | Ranks jobs against that resume with a deterministic matcher. Instant, free, no AI call. |
| `list_saved_jobs` | Saved jobs with any evaluation score and application status. |

Reversible state changes. Logged in the activity panel, undoable in a click.

| Tool | What it does |
|---|---|
| `save_job` / `unsave_job` | Bookmarks a job. Idempotent. |

Consequential. Each blocks on a human clicking Approve, and is annotated
`destructiveHint: true`.

| Tool | What it does |
|---|---|
| `evaluate_job_fit` | Full AI evaluation of the resume against one posting. Spends 1 credit. |
| `prepare_application` | Evaluate, then rewrite the resume for the posting, then draft a cover letter. Spends 3 credits, takes up to two minutes. |
| `mark_job_applied` | Records that the user applied on the employer's site. |

**There is no tool that submits an application to an employer.** JobJam does not
do that, so the tool surface does not offer it. When an agent is asked to
"just apply," the honest answer is a capability boundary, not an attempt.

## Three decisions worth explaining

**Approval is serialised, never queued.** `requestApproval()` rejects a second
request while one is on screen rather than lining it up
([`store.ts`](src/webmcp/store.ts)). A queue would let a user approve the dialog
in front of them and silently authorise the next one behind it. An agent firing
three consequential actions at once should be stopped, not helped along.

**Reversible actions get no modal.** Bookmarking asks for nothing. A
confirmation on every low-stakes action trains people to click through
confirmations, which is exactly the habit you do not want when the dialog that
matters finally appears.

**Tools drive the real UI.** `search_jobs` calls the same `commitFilters` path a
human click uses, so the filter chips change and the list re-renders. An agent
tool that only returns JSON into a chat pane is a chatbot with extra steps; the
point of WebMCP is that the site itself is the interface.

## What is in here

```
src/webmcp/
  types.ts            ModelContext resolution, result envelope, same-origin fetch
  register.ts         wraps every tool with logging and error shaping, registers them
  store.ts            activity log, approval gate, jobs-board bridge
  tools/read.ts       the read-only tools
  tools/write.ts      state changes and consequential actions
  matching/           the deterministic resume-to-job matcher (pure functions)
  ui/                 activity panel, approval dialog, provider
  __tests__/          runnable tests for the salary heuristic and the approval gate
demo/                 a standalone WebMCP page, no login and no backend needed
```

`document.modelContext` is read first and `navigator.modelContext` second, so
one build works on browsers that shipped either: the getter moved from Navigator
to Document in the May 2026 draft and the old form is deprecated in Chromium 150.

## Running the demo

The demo registers three public job-market tools and needs no JobJam account,
no server and no build step. It reads JobJam's anon-granted Postgres functions
directly.

```bash
cp demo/config.js demo/config.local.js   # optional
# edit demo/config.js with a Supabase URL and publishable anon key
npm run demo                             # serves on http://localhost:4321
```

Then open `http://localhost:4321` in either:

- the **ChatGPT desktop app's built-in browser** (site tools need GPT-5.6 Sol or
  Terra, and are unavailable in Enterprise and Edu workspaces), or
- **Chrome 149+** with `chrome://flags/#enable-webmcp-testing` enabled.

WebMCP requires a secure context, so `localhost` or HTTPS. Opening the file
directly over `file://` will not work.

Ask the agent: *"Which companies are hiring the most right now, and how long do
their roles stay open?"* The last part is answerable because JobJam records when
postings close, not only what is currently open.

## Using the layer in a host app

`src/webmcp` is written for a Next.js App Router client component tree. Mount the
provider once, above your layout branches:

```tsx
import WebMcpProvider from '@/webmcp/ui/WebMcpProvider'

<>
  <LayoutShell>{children}</LayoutShell>
  <WebMcpProvider />
</>
```

The layer expects three things from the host application:

1. **The API routes the tools call.** They are JobJam's, listed at the top of
   each handler in `tools/`. Point them at your own equivalents to reuse the
   structure.
2. **A cookie session on the same origin.** `toolFetch` sends
   `credentials: 'same-origin'` and nothing else. Never add an `Authorization`
   header to it; that is the whole security model.
3. **Three UI primitives**: `Button` and `Dialog` from
   [shadcn/ui](https://ui.shadcn.com), and a `cn` class-merge helper.

## Tests

```bash
npm install && npm test
```

The tests cover the two pieces of non-obvious logic: the best-effort salary
parser (job postings state salary as unstructured text, so its edge cases are
the whole story) and the approval gate, including the case where a second
consequential request arrives while a dialog is already open.

## Status

WebMCP is a W3C Web Machine Learning Community Group draft and is still moving.
Tool-call timeouts and behaviour across single-page navigations are not yet
specified; `prepare_application` can run for two minutes, which is the part of
this most likely to need revisiting.
