# Designer app

The working app: a local server plus a browser UI, and the same thing wrapped as a Mac app. Both drive the **Claude Code CLI installed on your computer**.

## How it talks to Claude Code

Designer launches your own `claude` binary in headless mode and speaks its stdin/stdout protocol. It does not use an SDK, a bundled copy of Claude Code, or its own API key:

```
claude -p --input-format stream-json --output-format stream-json --verbose \
       --include-partial-messages --replay-user-messages \
       --permission-prompt-tool stdio --setting-sources user,project,local \
       [--model …] [--effort …] [--permission-mode …] [--resume <session>]
```

So Designer uses your sign-in, settings, `CLAUDE.md`, skills, hooks and MCP servers, and its chats are ordinary Claude Code sessions (`claude --resume` lists them).

Nothing in the menus is hardcoded. Each item comes from Claude Code:

| What you see | Where it comes from |
| --- | --- |
| Models and the effort levels each one allows | the CLI's `initialize` reply |
| Slash commands and skills, agents, output styles, account | the CLI's `initialize` reply |
| Permission modes | the `--permission-mode` choices in `claude --help` |
| MCP servers and their status | the `mcp_status` control request |
| Sessions | `~/.claude/projects/<folder>/*.jsonl`, the files `claude --resume` reads |
| Memory | `CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md` and `~/.claude/CLAUDE.md` |

The chat works through the CLI's own controls:

- **Permission prompts** arrive as `can_use_tool` requests, and you answer them with Allow or Deny.
- **Model and mode changes** use `set_model` and `set_permission_mode`.
- **Stop** uses `interrupt`.
- **Rewind** uses `rewind_files`, with file checkpointing turned on.
- **Before and After** for each edit come from `PreToolUse` and `PostToolUse` hook callbacks.

## Design and code on one canvas

- **No project needed to start.** Designer opens straight into a chat and a blank canvas. Add a project from the menu, or just name one in the chat; Claude opens it and works out how to run it.
- **Designer's own MCP server.** The server exposes `/mcp` (guarded by a per-run token) with `open_project`, `run_project`, `get_canvas`, `add_to_canvas`, `update_layers`, `show_component` and `get_design_tokens`, and registers it with Claude Code through `mcp_set_servers`. Figma's desktop MCP server joins the same list when connected.
- **Zero-config project setup.** Adding a project (or reopening one) runs a setup in the background, shown as a card on the canvas: it works out the framework (Next.js, Nuxt, Remix, React Router, Astro, SvelteKit, Gatsby, Angular, Create React App, Vite with React/Vue/Svelte/Solid, Parcel, webpack, or a plain HTML folder) and the package manager (`packageManager` field, then lockfiles, looking up to a monorepo root), finds the app package in a monorepo, installs dependencies if they were never installed, starts the dev server on a free port (so it never stops to ask about a busy one), indexes the components with their props (React, Vue, Svelte) and links them to their stories, and warms Storybook. A failure shows the output with "Try again" and "Ask Claude to fix it". Code: `src/server/setup.ts` (detection and indexing) and `src/server/autosetup.ts` (the steps).
- **Live components, not whole Storybooks.** Each local dev server gets a loopback preview proxy that injects a small probe. For a story, the probe strips Storybook's padding and background, sizes the frame to the component (Hug) or to a fixed size, and reports props, sizes and rendered styles. Components sit on the canvas as `code` layers beside design layers, so both read the same.
- **Figma | Code properties.** The right panel switches between design properties (plus the rendered styles of a code layer, in Figma terms) and code properties (component props, size, a JSX snippet, or the CSS and code link of a design layer).
- The canvas is saved to `<project>/.designer/canvas.json`, or `~/Designer/canvas.json` with no project.

## Design tokens: one source of truth

Figma variables and the repo's tokens show up as one list (Code › Tokens), each pair marked **In sync**, **Differs**, **Only in Figma** or **Only in code**.

- **Code side:** CSS custom properties in any stylesheet (`:root`, theme selectors, Tailwind v4 `@theme`) and the `theme` / `theme.extend` values of a Tailwind v3 `tailwind.config.*` (colours, spacing, radii, font families and sizes, shadows). `var()` references are followed.
- **Figma side:** **Pull from Figma** reads the variables used by the current selection through the desktop MCP server (`get_variable_defs`); later pulls add to earlier ones. **Import file…** takes a Figma REST variables export (with modes and aliases), W3C design tokens or a Tokens Studio file. Either way they're saved to `.designer/figma-variables.json`, so the team gets them with the repo and sees the same drift after Get latest.
- **Matching:** names are compared after normalising them, so `Color/Primary/500`, `--color-primary-500` and `colors.primary.500` pair up. Groups can be left out (`Brand/500` finds `colors.brand.500`). A Figma mode named Dark pairs with a dark selector such as `[data-theme="dark"]` or `.dark`. When names really differ, **Link to a code token…** saves the pair to `.designer/token-links.json`.
- **Values** are compared as a designer would: `#2563EB`, `rgb(37 99 235)` and Figma's 0–1 RGBA are the same colour, and `16`, `16px` and `1rem` are the same size.
- **Drift:** the Code tab and Tokens tab carry a count, the Tokens tab has a banner, and **Use Figma value** writes Figma's value into the CSS or Tailwind file in the notation already used there (hex or rgb, px or rem). Figma's desktop server can't change variables, so for the other direction there is **Copy code value**.
- **Properties panel:** with a layer selected, the Figma side lists the token behind each fill, stroke, radius, font, gap and padding value, flags values whose token differs, and points out hard-coded values.
- **Claude** reads the same pairs through the `get_design_tokens` tool, so "fix the drift" or "use our tokens" works from the chat.

## Tests

```bash
npm test            # unit, feature and server smoke tests (no browser needed)
npm run smoke:ui    # builds the UI and drives it in Chromium (needs Playwright); SHOTS=<dir> saves screenshots
```

## Run it as a local server

You need Node 20 or newer, and Claude Code installed and signed in.

```bash
cd app
npm install
npm run build
npm start                 # opens http://127.0.0.1:4818
npm start -- --project ~/code/my-repo --port 4818 --no-open
```

For development, run `npm run dev`. Vite then serves the UI on port 5173 and the server runs on port 4818.

The server listens only on `127.0.0.1`, answers only loopback `Host` headers, and requires a per-run token on every API and WebSocket call.

## The Mac app

Every push and pull request builds the Mac app in GitHub Actions (`.github/workflows/mac.yml`), for both Apple silicon and Intel. Download it from the run's **Designer-mac** artifact. Pushing a `v*` tag also attaches the builds to a GitHub release.

To build it on your own Mac, run `npm run dist:mac`. The builds land in `release/`.

The builds are **unsigned**, so macOS will block them the first time. To open one:

- Right-click Designer.app, choose **Open**, then confirm.
- Or run `xattr -cr /Applications/Designer.app` once.

Signing and notarizing need an Apple Developer account and these repository secrets:

- `CSC_LINK`: a base64 Developer ID Application certificate (.p12)
- `CSC_KEY_PASSWORD`
- `APPLE_ID`
- `APPLE_APP_SPECIFIC_PASSWORD`
- `APPLE_TEAM_ID`

Then set `mac.identity` back to the default and `hardenedRuntime: true`, and add `notarize: true` in `package.json`.

The Mac app reads `PATH` and exported variables from your login shell, because apps opened from Finder don't inherit them. That is how it finds `claude` and an `ANTHROPIC_API_KEY` set in `~/.zshrc`.

## What CI checks

The CI workflow (`.github/workflows/ci.yml`) runs on every pull request:

- lint, typecheck, unit tests and build
- a check that the built server starts and refuses API calls without the token

Project setup is tested against fixture repos in `test/fixtures/projects` (Next + pnpm, React/Vite + yarn, Vue/Vite + npm, SvelteKit + bun, CRA, Angular with a `packageManager` field, a pnpm monorepo, a plain HTML folder). `test/smoke-setup.test.ts` boots the real server on a copy of a fixture, runs a real `npm install` and real dev servers, and checks the page answers. `npm run test:smoke` also installs React, Vue, Next.js and Svelte apps from the registry with npm, pnpm, yarn and bun and starts their real dev servers (needs the network, so it is not part of `npm test`).

The tests drive a stand-in `claude` (`test/fixtures/fake-claude.mjs`) that speaks the same protocol. They cover streaming, permission allow and deny, the before/after snapshots and rewind.

CI cannot sign in to Claude, so the check against a real `claude` is a local step:

1. Run `npm start`.
2. Open a repository.
3. Send a prompt.

## Layout

```
src/server/claudeCli.ts   spawns `claude` and speaks its control protocol
src/server/session.ts     turns CLI events into chat items; permissions, edit snapshots, rewind
src/server/claude.ts      finds `claude`, checks sign-in, reads permission modes, loads the login-shell env
src/server/transcripts.ts sessions from ~/.claude/projects
src/server/project.ts     git (Get latest / Save version / Share for review), stories, memory, dev servers
src/server/index.ts       HTTP + WebSocket server
src/web/                  React UI: canvas, components, chat, changes
electron/                 the Mac app shell
```
