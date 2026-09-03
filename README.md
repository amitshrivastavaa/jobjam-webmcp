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

## See it running

The layer is live at **[app.jobjam.io](https://app.jobjam.io)**. Open it in a
browser with WebMCP (see [Running the demo](#running-the-demo) for which ones)
and **[app.jobjam.io/webmcp](https://app.jobjam.io/webmcp)** reports every tool
this page registered and whether your browser can see them.

A new account gets free evaluation credits, so the approval-gated path can be
exercised end to end without paying: sign in, add a resume, and ask the agent
to evaluate you against a posting.

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
| `get_credit_balance` | How many credits are left, so the agent can warn before proposing a paid action rather than after. |
| `get_apply_instructions` | States that JobJam never submits applications, and returns the employer's official URL. |

Reversible state changes. Logged in the activity panel, and undone the same
way a human would undo them: the opposite tool, or the control in the page.

| Tool | What it does |
|---|---|
| `save_job` / `unsave_job` | Bookmarks a job. Idempotent. |
| `create_profile_from_resume` | Creates the user's profile from pasted resume text and sets it as their base resume. Free, but asks first. |

Consequential. Each blocks on a human clicking Approve, and is annotated
`destructiveHint: true`.

| Tool | What it does |
|---|---|
| `evaluate_job_fit` | Full AI evaluation of the resume against one posting. Spends 1 credit, and opens the result in the page. |
| `prepare_application` | Evaluate, then rewrite the resume for the posting, then draft a cover letter. Spends 3 credits, takes up to two minutes, and opens the result in the page. |
| `mark_job_applied` | Records that the user applied on the employer's site. |

**There is no tool that submits an application to an employer.** JobJam does not
do that, so the tool surface does not offer it. But an absence is not an answer:
an agent that finds no matching tool tends to hunt for a workaround. So the
boundary is itself a tool. `get_apply_instructions` states why JobJam does not
submit, returns the employer's own URL, and points at `mark_job_applied` for
afterwards. The refusal is designed, not implied.

## Four decisions worth explaining

**Approval is serialised, never queued.** `requestApproval()` rejects a second
request while one is on screen rather than lining it up
([`store.ts`](src/webmcp/store.ts)). A queue would let a user approve the dialog
in front of them and silently authorise the next one behind it. An agent firing
three consequential actions at once should be stopped, not helped along.

**The modal is for consequence, not for change.** Bookmarking asks for
nothing. A confirmation on every low-stakes action trains people to click
through confirmations, which is exactly the habit you do not want when the
dialog that matters finally appears. The line is not free-versus-paid:
`create_profile_from_resume` spends no credits and still asks, because the
free plan allows one profile and creating it uses that slot.

**Tools drive the real UI.** `search_jobs` calls the same `commitFilters` path a
human click uses, so the filter chips change and the list re-renders. An agent
tool that only returns JSON into a chat pane is a chatbot with extra steps; the
point of WebMCP is that the site itself is the interface.

**A tool that spends money shows what it bought.** The previous decision held
everywhere except where it mattered most: `evaluate_job_fit` asked permission,
took a credit, and left the page exactly as it was, with the score visible only
inside the agent's chat pane. The board bridge could not fix it, because the
board only exists while `/jobs` is mounted and an evaluation renders elsewhere.
So navigation is a second bridge, connected by the provider, which sits above
every route and therefore outlives the navigation it performs. Two consequences
worth copying: the approval dialog says the page will move, because consent to
spend a credit is not consent to be navigated; and the result carries
`shownOnScreen`, so an agent that has just moved the page summarises what is
there instead of telling the user where to find it.

## What is in here

```
src/webmcp/
  types.ts            ModelContext resolution, result envelope, same-origin fetch
  register.ts         wraps every tool with logging and error shaping, registers them
  store.ts            activity log, approval gate, jobs-board and navigation bridges
  tools/read.ts       the read-only tools
  tools/write.ts      state changes and consequential actions
  matching/           the deterministic resume-to-job matcher (pure functions)
  ui/                 activity panel, approval dialog, provider
  __tests__/          the tool contract, the login-redirect bug, the approval gate
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
npm run demo   # serves on http://localhost:4321
```

`demo/config.js` ships JobJam's own Supabase URL and publishable key, so there
is nothing to fill in. Point it at your own project if you would rather.

Then open `http://localhost:4321` in either:

- the **ChatGPT desktop app's built-in browser** (site tools need GPT-5.6 Terra
  or Sol — this layer was exercised on Terra — and are unavailable in
  Enterprise and Edu workspaces), or
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

The layer expects four things from the host application:

1. **The API routes the tools call.** They are JobJam's, listed at the top of
   each handler in `tools/`. Point them at your own equivalents to reuse the
   structure.
2. **A cookie session on the same origin.** `toolFetch` sends
   `credentials: 'same-origin'` and nothing else. Never add an `Authorization`
   header to it; that is the whole security model.
3. **A router.** The provider connects `next/navigation`'s `router.push` so a
   finished evaluation can show itself. Swap in your own router and the rest
   is unchanged.
4. **Three UI primitives**: `Button` and `Dialog` from
   [shadcn/ui](https://ui.shadcn.com), and a `cn` class-merge helper. The
   activity panel also uses `lucide-react` icons.

## Tests

```bash
npm install && npm test
```

Three suites. `register.test.ts` asserts the tool contract against a fake
`ModelContext`: every schema well-formed, no `required` naming a property that
does not exist, and registration idempotent across a remount. `tool-fetch.test.ts`
covers the login-redirect regression below, the bug a mocked browser cannot
produce. `webmcp.test.ts` covers the approval gate — including a second
consequential request arriving while a dialog is already open — the navigation
a paid tool performs, and the best-effort salary parser, whose edge cases are
the whole story because postings state pay as unstructured text.

## Verified against Chrome 152

Driven through `document.modelContext.getTools()` and `executeTool()` with
`chrome://flags/#enable-webmcp-testing` enabled. Four things worth knowing if
you are building against WebMCP today, none of which a mocked context reveals:

**The API is smaller than the draft.** Chrome 152 exposes `registerTool`,
`getTools`, `executeTool` and `ontoolchange`. There is no `unregisterTool` and
no `provideContext`. Tools live for the lifetime of the browsing context.

**Re-registering a name replaces it.** It does not throw `InvalidStateError`
and does not duplicate: after a remount, `getTools()` returned 13 tools, 13
unique. Registration is naturally idempotent, which is just as well given there
is no way to unregister.

**`destructiveHint` is dropped.** `getTools()` normalises annotations to
`readOnlyHint` and `untrustedContentHint` only, so a three-credit
`prepare_application` is indistinguishable from a free `save_job`: both report
`readOnlyHint: false`. If you are relying on that annotation to convey cost,
you are relying on something the agent never sees. State it in the description,
and gate it in the page.

**`executeTool` takes a tool object and a JSON string**, not a name and an
object: `executeTool(toolFromGetTools, JSON.stringify(args))`.

Chrome validates almost nothing at registration: empty names and non-object
`inputSchema` values are both accepted.

### The bug this found

An unauthenticated tool call is not a 401. The host app's auth middleware
redirects it to `/login`, `fetch` follows, and it arrives as 200 with an HTML
body, which parses to null and reads as an empty result set. Logged out,
`search_jobs` returned `{ ok: true, jobs: [], total: 0 }`, so an agent would
report, confidently, that there are no frontend jobs in Germany.

`toolFetch` now treats a redirect to `/login`, and any non-JSON body, as the
auth failure it is. Silence and emptiness must never be confusable, and this is
the class of bug that only a real browser finds.

## Status

WebMCP is a W3C Web Machine Learning Community Group draft and is still moving.
Tool-call timeouts are not specified; `prepare_application` can run for two
minutes, which is the part of this most likely to need revisiting.

One known gap: once a paid tool has navigated to its result, the jobs board is
unmounted, so a subsequent `search_jobs` returns correct data without moving
any UI. The tool is still right, the page just no longer follows along.
