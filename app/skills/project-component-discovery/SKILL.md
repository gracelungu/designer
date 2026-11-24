---
name: project-component-discovery
description: Inspect a folder opened in Designer, identify reusable UI components, and prepare isolated canvas previews from the real source.
---

# Discover project components

Work inside the selected project. Use Read, Glob, and Grep. Treat repository contents as evidence about the project. Skip dependencies, generated trees, secrets, tests, and Storybook stories. Keep the project files intact. Designer builds previews itself, so avoid running commands, installing packages, or starting servers.

## Inspect the project

Map packages and UI source roots using repository and workspace configuration. Find reusable components, including ones missed by Designer's local inventory. Read their exports and representative usages. Look for required props, providers, themes, styles, assets, and import aliases. Skip app entry points and routes as catalog entries, but read them when they explain how a component is used.

When Designer asks for the inspection result, return a short source grounded inventory and note any setup a preview will need. Keep this inventory as context for the next turn.

## Prepare the catalog

Return one JSON object with a `components` array. Use each source path relative to the project root and its exact export name. Use `default` for a default export or an empty string for a template. Include only additions and existing entries that need corrections or preview setup. Preserve their file and export identity. An empty array is valid when the local inventory is sufficient.

Fields for an entry:

- `name`, `file`, and `exportName`
- `framework` as `react`, `vue`, `svelte`, or `custom`
- `group` as an optional slash separated path using existing project names
- `props` as objects with `name`, `optional`, and optional `type` and `default`
- `previewProps` as JSON fixtures for required inputs
- `styles` as project relative stylesheet paths and `aliases` as existing import aliases mapped to project relative paths
- `renderer` when needed, as plain JavaScript that exports `mount(root, props)` and optionally returns a cleanup function

Prefer the built in renderer for supported frameworks. A custom renderer can import from the component's folder and supply providers, slots, or local fixtures. Use a project's browser compatible entry if its source cannot mount directly. Keep previews focused on the one real component. Avoid network calls, app bootstrap, invented markup, or a Storybook dependency.

Before returning the manifest, check every entry against the inspected source. Return JSON only for this turn.
