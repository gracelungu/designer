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

- **Open a project, sketch or try the demo.** Designer opens any local folder, then shows its component inventory in Components. Claude and Figma can be connected when you need them.
- **Browse and place components.** Designer scans React, Vue and Svelte without installing dependencies. Put a live story or an editable frame linked to the source on the canvas. Use **Add source** to link components from other stacks. Entries are saved in `.designer/components.json` and can be shared with the team. The file accepts a project relative path, optional `exportName` and optional `storyIds`. For example, `[{"name":"Badge","file":"templates/badge.html"}]`. A live component preview needs a runnable story. A source link works without one.
- **Open a component on the canvas.** Choose a folder, then click a component in the grouped and searchable **Components** tab. Designer builds that component with its styles and preview inputs, without a preview URL, app start script, or Storybook. Claude can discover additional components and create project-specific renderers. **Rescan** updates the catalog after source changes.
- **Open a full app when you need it.** Choose **Run full app** from the project menu. The app runner can reuse its saved launch recipe in `.designer/run.json`.
- **Designer's own MCP server.** The server exposes `/mcp` (guarded by a per-run token) with `open_project`, `run_project`, `get_canvas`, `add_to_canvas`, `update_layers`, `show_component` and `get_design_tokens`, and registers it with Claude Code through `mcp_set_servers`. Figma's desktop MCP server joins the same list when connected.
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

- **Canvas to code.** Code → Sync shows changed properties for linked editable layers. **Copy changes** hands the source and property diff to a developer, who can mark it implemented when done. **Propose code change** asks Claude to prepare a diff in a temporary source copy. **Apply to checkout** applies it after review if the branch and touched files still match. Changes to live preview props stay on their canvas instance until you explicitly **Propose story defaults**.
- **Code to canvas.** Designer watches the project's git HEAD. After a pull, commit or branch switch, it reloads live components and compares rendered properties for design layers linked to a story. A property changed only in code can update automatically. A property you also edited on the canvas asks you to choose **Use code** or **Keep my design**. A source-only link supports design changes and handoff, with rendered comparison available once a story is linked.


## Working with the team

- **Comments on the canvas.** Press C and click a frame to pin a comment; it follows the frame when it moves. Each thread is saved as its own file in `<project>/.designer/comments/<id>.json`, signed with your git `user.name`, so comments travel with Save version, merge cleanly when two people comment at once, and appear for everyone after Get latest. The **Comments** tab lists them; **Fix with Claude** hands one to Claude, which can read comments (`get_comments`) and reply or resolve them (`reply_to_comment`) through Designer's MCP server.
- **A design preview for developers.** *Export design preview* (project menu) writes `.designer/preview/`: one SVG per top-level frame, a `README.md` that GitHub and Azure DevOps render with the frames, comments and linked components, and a self-contained `index.html` with comment pins and CSS (also downloaded). **Share for review** can include it (tick *Include a design preview for developers*): the preview and comments go into the change, and the pull request links to the preview.
- **Pull requests and their comments.** The **Comments › Pull requests** view lists open pull requests for the project's remote and lets you read, reply to and (on Azure DevOps) resolve their comment threads.
  - **Azure DevOps** remotes (`dev.azure.com`, `ssh.dev.azure.com`, `*.visualstudio.com`) go through Microsoft's Azure DevOps MCP server, started locally as `npx -y @azure-devops/mcp <organization>`. It signs in with your Microsoft account the first time; Designer holds no token. Claude Code gets the same server, so it can work with PRs from the chat. Set `DESIGNER_AZURE_MCP` to a JSON array (such as `["node","/path/server.js"]`) to run a different command; the organization is appended.
  - **GitHub** remotes use the GitHub CLI with your own `gh auth login`.

## Visual review, sharing and versions

- **Before and after for every change.** When Claude is about to edit a file, Designer photographs the components on the canvas and the stories that show that file, in a headless Chrome, Edge, Brave or Chromium it finds on your computer (or `DESIGNER_BROWSER`). When Claude's turn ends it photographs them again and compares them pixel by pixel. Code › Changes lists each change with Side by side, Slider and Highlight views. Token edits get the same treatment. Pictures live in `.designer/reviews/`, kept out of git through `.git/info/exclude`.
- **Share for review, in one click.** Saves your changes on a branch of their own, uploads the pictures to a `designer-screenshots` branch (so they never enter the change itself), pushes, and opens a pull request whose description shows before and after. It uses `gh` when it is signed in; otherwise it opens GitHub's (or GitLab's, or Azure DevOps') new pull request page with everything filled in.
- **Versions tab, like Figma's version history.** Named versions (git tags under `version/`), every saved version with Restore (a new version with the old content, so nothing is lost), variations (branches) you can open, merge in or remove, and Sync with the team. Switching or restoring saves unsaved work first.

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
| `npm run test:smoke:setup` | Lets the real, signed-in Claude Code set up React, Vue, Next.js, Svelte and Python apps from scratch (needs the network and Claude Code) |
| `npm run test:smoke:sync` | Both sync directions in Chromium, with a real git project and a stand-in Storybook (build first) |
| `npm run test:smoke:collab` | Comments, the design preview and pull request comments in Chromium (build first) |
| `test/smoke-visual.test.ts` (part of `npm test`, runs once the app is built) | Visual review, Share for review and Versions in a real browser with a stand-in Claude Code, Storybook and GitHub remote; `SMOKE_SHOTS=<dir>` keeps screenshots |

`.github/workflows/ci.yml` runs the unit, e2e, editor and desktop smoke tests on every pull request. Claude Code and the Azure DevOps MCP server are replaced by stand-ins in `test/fixtures/`, so the tests need neither a sign-in nor network.

Project setup is tested against fixture repos in `test/fixtures/projects` (Next + pnpm, React/Vite + yarn, Vue/Vite + npm, SvelteKit + bun, CRA, Angular with a `packageManager` field, a pnpm monorepo, a plain HTML folder). `test/setup-runner.test.ts` boots the real server on a copy of a fixture with a scripted stand-in Claude that calls the setup tools, runs a real `npm install` and real dev servers, and checks the tasks, the activity log, the saved recipe and its replay. `npm run test:smoke:setup` lets the real Claude Code set up React, Vue, Next.js, Svelte and Python apps with npm, pnpm, yarn and bun (needs the network and a signed-in Claude Code, so it is not part of `npm test`).

The tests drive a stand-in `claude` (`test/fixtures/fake-claude.mjs`) that speaks the same protocol. They cover streaming, permission allow and deny, the before/after snapshots and rewind.
