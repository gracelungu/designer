# Clickable prototype

`workspace.dc.html` is the source of the clickable UI prototype:

**[Open the hosted prototype](https://claude.ai/artifact/MWMd2fJTtkMxULsEz61p6j)**

It is a design artifact, not the app. The file is a template with logic (`{{ }}` holes, `<sc-if>`, `<sc-for>`, and a `Component` class) that runs on a small hosted runtime. That runtime is not part of this repository, so opening the file directly in a browser will not render it. Use the link above.

## What you can try

- **Canvas:**
  - select cards and frames
  - change variant, size, padding and gap, for one card or all cards
  - switch the device width and light or dark mode
  - draw frames, shapes, text and comments, then drag them
  - pan by dragging empty canvas, and zoom
- **Ask AI and Chat:**
  - ask for denser cards, an empty state, dark mode, a brand colour, rounder buttons, a new variant, stories, or "turn this into code" on a frame you drew
  - try the three modes (Ask first, Plan first, Auto-edit)
  - Keep, Discard, compare Before and After, and Rewind
- **Figma import:** desktop MCP (recommended), sign-in, or token, then **Build in code** for the missing PlanBadge component.
- **Components view:**
  - variant matrix, theme and state
  - preview props and main-component tokens
  - Figma drift actions
- **Project:**
  - Get latest, Save version and Restore, Share for review, Undo
  - open another folder (with a trust prompt), or clone

All AI responses in the prototype are simulated. The real app will send them to your local Claude Code.
