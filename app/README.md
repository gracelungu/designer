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
- **Designer's own MCP server.** The server exposes `/mcp` (guarded by a per-run token) with `open_project`, `run_project`, `get_canvas`, `add_to_canvas`, `update_layers` and `show_component`, and registers it with Claude Code through `mcp_set_servers`. Figma's desktop MCP server joins the same list when connected.
- **Live components, not whole Storybooks.** Each local dev server gets a loopback preview proxy that injects a small probe. For a story, the probe strips Storybook's padding and background, sizes the frame to the component (Hug) or to a fixed size, and reports props, sizes and rendered styles. Components sit on the canvas as `code` layers beside design layers, so both read the same.
- **Figma | Code properties.** The right panel switches between design properties (plus the rendered styles of a code layer, in Figma terms) and code properties (component props, size, a JSX snippet, or the CSS and code link of a design layer).
- The canvas is saved to `<project>/.designer/canvas.json`, or `~/Designer/canvas.json` with no project.

## Design and code, both ways

Layers linked to code stay in step with it in both directions. A linked layer is a design layer with a code link (set by Figma import, by Claude, or with **Link to a component** in the Code panel), or a live component on the canvas.

- **Canvas to code.** When you edit a linked layer (fill, stroke, corner radius, auto layout, padding, gap, text and its font), or change a live component's props, a bar on the canvas says the layer has edits that aren't in code yet. **Send to code** runs your local Claude Code headless in the project, with only read and edit tools (commands and edits outside the repo are refused). It edits the component, using your tokens where one matches. You review the diff and choose **Keep** or **Discard**. Discard puts each file back, unless it changed again since.
- **Code to canvas.** Designer watches the project's git HEAD. After **Get latest**, a pull in a terminal, a commit or a branch switch, it reloads live components and renders each linked component out of sight. Then it updates the linked design layers with what changed in code. This is a three-way merge: a property only the code changed is applied, and a property you also changed on the canvas asks you to choose **Use code** or **Keep my design**.
- Each linked layer keeps a small sync record (`sync` in `.designer/canvas.json`): its properties when design and code last matched, and how the code rendered then.

## Run it as a local server

You need Node 20 or newer, and Claude Code installed and signed in.

```bash
cd app
npm install
npm run build
npm start                 # opens http://127.0.0.1:4818
npm start -- --project ~/code/my-repo --port 4818 --no-open
```

Tests: `npm test` runs the unit and integration tests (a fake `claude` in `test/fixtures` speaks the real stream-json protocol, so no sign-in or credits are needed). `npm run build && npm run test:smoke` drives the built app in Chromium through both sync directions, with a real git project and a stand-in Storybook.

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
