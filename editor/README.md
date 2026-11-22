# Canvas editor

A Figma-style design canvas with working tools, written as plain ES modules with no build step and no dependencies. It is the canvas the Designer app will mount; the prototype in `../prototype` only simulated the toolbar.

Run it with any static server from this folder, for example `npx http-server editor` then open `/index.html`. Work is saved in the browser's local storage.

## What works

- **Tools (bottom toolbar, Figma's grouping):** Move (V), Hand (H or hold Space), Scale (K), Frame (F) with device presets, Section (Shift+S), Rectangle (R), Line (L), Arrow (Shift+L), Ellipse (O), Polygon, Star, Place image (Shift+Cmd+K, or drop or paste images), Pen (P), Pencil (Shift+P), Text (T), Comment (C).
- **Selection:** click, Shift+click, marquee, Cmd+click for the deepest layer, double-click to go into groups, Enter and Shift+Enter for children and parent, Tab between siblings. Children of top-level frames are picked directly, like Figma.
- **Transform:** move with smart guides and snapping to edges and centres, whole-pixel positions, Shift to lock an axis, Alt-drag to duplicate; resize from corners and edges (Shift keeps proportions, Alt from the centre), rotate just outside a corner (Shift for 15°), line endpoints, flips, nudging with arrows.
- **Structure:** group and ungroup, frame selection, drag into and out of frames, drawing a frame around layers adopts them, constraints when a frame resizes, layer ordering, hide and lock.
- **Auto layout:** Shift+A, direction, gap or auto spacing, padding, 3×3 alignment, hug, fill and fixed sizing, reordering by dragging inside the frame, and horizontal wrapping with a separate row gap.
- **Properties:** position, size, rotation, constraints, clip content, opacity, corner radius (per corner), polygon and star points, text (font, weight, size, line height, letter spacing, alignment, auto width or height, decoration, case), fills (solid, image, linear gradient or radial gradient on nontext layers), strokes (weight, inside, centre or outside, dashes, arrow ends), drop shadow, inner shadow and layer blur. Number fields scrub by dragging their label and accept maths.
- **Layers panel:** tree, multi-select, rename (double-click or Cmd+R), drag to reorder or nest, hide and lock.
- **Prototyping:** select a layer inside a top level frame, open Prototype, and choose a click action. Play from any frame or a selected start frame. The player renders editable artwork with static placeholders for live source previews.
- **Quick actions:** Cmd/Ctrl + / opens a searchable list of tools and commands.
- **Also:** undo and redo for everything, copy and paste (also between tabs as JSON), copy and paste properties, Alt to measure distances, zoom (Cmd+scroll, Shift+0, 1, 2), comments with replies and resolve, SVG, PNG and JPG export, an Inspect tab with CSS, a context menu and a shortcut sheet (Shift+?).

## Not done yet

Vector boolean operations and outline stroke, editing rectangle or ellipse points (vector editing works on pen and pencil paths), components and variants, variables and styles, advanced prototype actions and transitions, multiple pages, rich text runs (styles apply to the whole text layer), additional gradient types, background blur, PDF export, rulers and layout grids, and vertical auto layout wrap.

See the [Figma parity audit](../docs/figma-parity-audit.md) for the editor and enterprise comparison.

## Layout of the code

- `src/core/` holds the document model, store with undo, geometry, hit testing, snapping, auto layout and constraints, and commands. It has no UI and is the part to reuse.
- `src/render/` turns the document into SVG and draws the selection overlay.
- `src/tools/` has one file per tool.
- `src/ui/` has the toolbar, layers, properties, inspect, shortcuts and menus.
- `src/editor.js` mounts a canvas into any element: `new Editor(element)`; panels talk to `editor.store`.

## Tests

`node editor/tests/e2e.cjs` drives the editor in headless Chromium with Playwright (25 checks covering drawing, selection, transforms, grouping, auto layout, clipboard, panels, comments and zoom).
