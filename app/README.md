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

`.github/workflows/ci.yml` runs all of them on every pull request.
