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
## Design and code, both ways

Layers linked to code stay in step with it in both directions. A linked layer is a design layer with a code link (set by Figma import, by Claude, or with **Link to a component** in the Code panel), or a live component on the canvas.

- **Canvas to code.** When you edit a linked layer (fill, stroke, corner radius, auto layout, padding, gap, text and its font), or change a live component's props, a bar on the canvas says the layer has edits that aren't in code yet. **Send to code** runs your local Claude Code headless in the project, with only read and edit tools (commands and edits outside the repo are refused). It edits the component, using your tokens where one matches. You review the diff and choose **Keep** or **Discard**. Discard puts each file back, unless it changed again since.
- **Code to canvas.** Designer watches the project's git HEAD. After **Get latest**, a pull in a terminal, a commit or a branch switch, it reloads live components and renders each linked component out of sight. Then it updates the linked design layers with what changed in code. This is a three-way merge: a property only the code changed is applied, and a property you also changed on the canvas asks you to choose **Use code** or **Keep my design**.
- Each linked layer keeps a small sync record (`sync` in `.designer/canvas.json`): its properties when design and code last matched, and how the code rendered then.
## Working with the team

- **Comments on the canvas.** Press C and click a frame to pin a comment; it follows the frame when it moves. Each thread is saved as its own file in `<project>/.designer/comments/<id>.json`, signed with your git `user.name`, so comments travel with Save version, merge cleanly when two people comment at once, and appear for everyone after Get latest. The **Comments** tab lists them; **Fix with Claude** hands one to Claude, which can read comments (`get_comments`) and reply or resolve them (`reply_to_comment`) through Designer's MCP server.
- **A design preview for developers.** *Export design preview* (project menu) writes `.designer/preview/`: one SVG per top-level frame, a `README.md` that GitHub and Azure DevOps render with the frames, comments and linked components, and a self-contained `index.html` with comment pins and CSS (also downloaded). **Share for review** includes it by default: it commits the preview and comments, pushes the branch, and puts the preview link in the pull request.
- **Pull requests and their comments.** The **Comments › Pull requests** view lists open pull requests for the project's remote and lets you read, reply to and (on Azure DevOps) resolve their comment threads.
  - **Azure DevOps** remotes (`dev.azure.com`, `ssh.dev.azure.com`, `*.visualstudio.com`) go through Microsoft's Azure DevOps MCP server, started locally as `npx -y @azure-devops/mcp <organization>`. It signs in with your Microsoft account the first time; Designer holds no token. Claude Code gets the same server, so it can work with PRs from the chat. Set `DESIGNER_AZURE_MCP` to a JSON array (such as `["node","/path/server.js"]`) to run a different command; the organization is appended.
  - **GitHub** remotes use the GitHub CLI with your own `gh auth login`.

## Tests

```bash
npm test                         # unit and server tests (vitest)
npm run build && npm run test:smoke:collab   # the collaboration features in a real browser (Playwright)
node ../editor/tests/e2e.cjs     # the canvas editor
```

Claude Code and the Azure DevOps MCP server are replaced by stand-ins in `test/fixtures/`, so the tests need neither a sign-in nor network.

## Run it as a local server

You need Node 20 or newer, and Claude Code installed and signed in.

```bash
cd app
npm install
npm run build
npm start                 # opens http://127.0.0.1:4818
npm start -- --project ~/code/my-repo --port 4818 --no-open
```

Tests: `npm test` runs the unit and integration tests (a fake `claude` in `test/fixtures` speaks the real stream-json protocol, so no sign-in or credits are needed). `npm run build && npm run test:smoke:sync` drives the built app in Chromium through both sync directions, with a real git project and a stand-in Storybook.

For development, run `npm run dev`. Vite then serves the UI on port 5173 and the server runs on port 4818.

The server listens only on `127.0.0.1`, answers only loopback `Host` headers, and requires a per-run token on every API and WebSocket call.

## The Mac app

The first launch walks through a short welcome: what Designer is, a check that Claude Code is installed and signed in, an optional Figma connection, and how to start: the **bundled demo project**, your own project, or a blank canvas. **Help › Show Welcome Again** brings it back.

### Demo project

`demo/` is a small Vite + React pricing page ("Lumen") with design tokens in `src/tokens.css` and `Button`, `Badge` and `PriceCard` components, each with a Storybook story. The app ships it as a resource. Choosing it copies it to `~/Designer/Lumen demo` as its own git repository, so edits and Save version never touch the app. It's also under **Add a project › Open the demo project**.

### Builds and releases

`.github/workflows/mac.yml` builds the Mac app for Apple silicon and Intel on every pull request and push to `main`, smoke-tests the packaged app, and uploads it as the run's **Designer-mac** artifact. Pushing a `v*` tag that matches `version` in `package.json` publishes a GitHub release with the dmg, zip and `latest-mac.yml`.

To build on your own Mac, run `npm run dist:mac`. The builds land in `release/`. Settings are in `build/builder-config.cjs`.

### Signing and notarizing

They switch on by themselves when these repository secrets exist, and are skipped when they don't:

- `CSC_LINK` (a base64 Developer ID Application .p12) and `CSC_KEY_PASSWORD`: sign with the hardened runtime.
- `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`: also notarize.

Unsigned builds are blocked by macOS the first time. Right-click Designer.app, choose **Open**, then confirm, or run `xattr -cr /Applications/Designer.app` once.

### Auto-update

The app checks GitHub releases 10 seconds after launch and every 6 hours, or from **Designer › Check for Updates…**.

- **Signed builds** download the update in the background, then show **Restart to update** in the top bar.
- **Unsigned builds** can't replace themselves (macOS refuses), so they show **Designer x.y.z is out · Download**, which opens the release page.

## Tests

| Command | What it covers |
| --- | --- |
| `npm test` | Unit and integration tests: the Claude Code protocol, MCP server, Figma, Storybook, tokens, the HTTP server and its security, onboarding, the demo, the updater and the build settings |
| `npm run test:e2e` | The built UI in Chromium with a stand-in Claude Code: onboarding, the demo, chat and permissions, changes, tokens, drawing on the canvas, Figma import, Save version, update notices (run `npm run build` first) |
| `node ../editor/tests/e2e.cjs` | The canvas editor's own 25 checks |
| `npm run test:smoke` | Starts the desktop app headless and checks the window, onboarding, native bridge and demo. Pass a packaged binary path to `node test/smoke/electron-smoke.mjs` to check a release build |
| `npm run smoke:ui` | Builds the UI and drives the Tokens tab in Chromium; `SHOTS=<dir>` saves screenshots |
| `npm run test:smoke:setup` | Installs real apps from the registry and starts their dev servers (needs the network) |

`.github/workflows/ci.yml` runs all of them on every pull request.

Project setup is tested against fixture repos in `test/fixtures/projects` (Next + pnpm, React/Vite + yarn, Vue/Vite + npm, SvelteKit + bun, CRA, Angular with a `packageManager` field, a pnpm monorepo, a plain HTML folder). `test/smoke-setup.test.ts` boots the real server on a copy of a fixture, runs a real `npm install` and real dev servers, and checks the page answers. `npm run test:smoke:setup` also installs React, Vue, Next.js and Svelte apps from the registry with npm, pnpm, yarn and bun and starts their real dev servers (needs the network, so it is not part of `npm test`).

The tests drive a stand-in `claude` (`test/fixtures/fake-claude.mjs`) that speaks the same protocol. They cover streaming, permission allow and deny, the before/after snapshots and rewind.
