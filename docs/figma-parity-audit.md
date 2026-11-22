# Designer and Figma Design parity

Baseline verified against Designer main at `401898f45d05bcf27172a47219e9df1aae0b9287` on November 22, 2026. The audit compares the integrated Designer app and its canvas engine with Figma Design, Dev Mode, Figma Draw, and the design workflows included in Figma Enterprise. Figma’s hosted file storage and sharing are outside the requested editor scope. The other Figma products are listed to make the suite boundary visible.

Designer has two overlapping surfaces. The canvas engine handles artwork, layout, and selection. The app adds local project onboarding, Claude Code, live previews, Figma import, design and code sync, and Git review. The rows below distinguish those integrations from native editing features. A partial match is usable for part of the workflow and leaves the named gaps open.

## Editor and design systems

| Capability | Designer coverage | Remaining gap |
| --- | --- | --- |
| Drawing and navigation | Move, hand, scale, zoom, frames, sections, basic shapes, text, pen, pencil, images and comments. | Slice tool, richer presets, arc controls, colour picker across the canvas, advanced Draw tools. |
| Selection and arrangement | Deep select, marquee, sibling and hierarchy navigation, layers, names, grouping, stacking, lock, hide, align, distribute and tidy up. | Search and filtering across the layer tree, bulk renaming patterns, advanced selection predicates. |
| Transforms and snapping | Smart guides, edge and centre snapping, resize handles, rotate, flip, nudge and distance measurements. | Rulers, guides, layout guides with columns and rows, pixel preview and snapping preferences. |
| Constraints and sizing | Basic constraints, absolute positioning, fixed/hug/fill sizing and frame clipping. | Min/max constraints across the editor, full sizing behaviour across nested flows and baseline alignment. |
| Auto layout | Horizontal and vertical flows, gap, automatic spacing, padding and alignment. This change adds horizontal wrapping, row gap, per row alignment and a drag insertion guide. | Vertical wrapping, grid flow, nested sizing edge cases and the rest of Figma’s layout behaviour. |
| Paint and effects | Solid and image fills, multiple paints and strokes, radius, drop and inner shadows, layer blur. This change adds linear and centred radial gradients on nontext fills with editable stops and CSS inspection. | Angular and diamond gradients, direct on canvas handles, gradient text and strokes, image crop/tile, blend modes, background blur and additional effects. |
| Vector editing | Editable pen and pencil paths. | Vector networks, joins and tangents across branches, boolean operations, masks, outline stroke, flatten, shapes to paths, advanced Draw brushes and illustration tools. |
| Type | Font family and weight, alignment, casing, decoration, spacing and text box sizing. | Rich text spans, missing font workflow, browser and local font discovery, shared fonts, OpenType options, variable axes, lists, truncation and typography styles. |
| Pages | One page per canvas. | Create, rename, reorder, duplicate and switch pages, with page specific viewport and comments that survive Git operations. |
| Components, variants and instances | Live source/story components with argument controls, links to editable layers and source code. | Native main components, linked instances, nested overrides, component sets and variants, boolean/text/instance swap properties, reset, detach and swap. |
| Design tokens and variables | Repo tokens, Figma variable import and drift review with code bindings. | Local collections with typed variables, aliases, modes, per frame inheritance, bindings across supported properties, extended collections and mode overrides. |
| Styles and libraries | Repo tokens and a source catalogue. | Reusable native paint, typography, effect and layout styles. Versioned component, style and variable libraries with publication, discovery, dependency handling, updates and migration. |
| Import and migration | Figma MCP/REST import in the app, plus images and Designer clipboard data in the editor. | Native .fig or .sketch import, comprehensive SVG vector import, and a migration fidelity matrix for masks, effects, prototypes, styles, variables, text and components. |
| Export | SVG selection and project review previews. This change adds PNG and JPG at 1×, 2× and 3× and corrects ancestor transforms for nested SVG export. | PDF, custom export presets and scales, suffixes, slices and batch export. Live code layers remain placeholders in static exports. |
| Commands and accessibility | Existing editor shortcuts and menus. This change adds searchable Quick actions on Cmd/Ctrl + /. | Full shortcut coverage by platform and keyboard layout, broader discoverability and systematic assistive technology coverage. |

Editor references [Auto layout](https://help.figma.com/hc/en-us/articles/360040451373-Guide-to-auto-layout-in-Figma), [wrap and directions](https://help.figma.com/hc/en-us/articles/31289464393751-Use-the-horizontal-and-vertical-flows-in-auto-layout), [boolean operations](https://help.figma.com/hc/en-us/articles/360039957534-Boolean-operations), [Figma Draw](https://help.figma.com/hc/en-us/articles/31440394517143-Explore-Figma-Draw), [OpenType](https://help.figma.com/hc/en-us/articles/4913951097367-Use-OpenType-features), [imports](https://help.figma.com/hc/en-us/articles/360041003114-Import-files-to-the-file-browser), [export formats](https://help.figma.com/hc/en-us/articles/13402894554519-Export-formats-and-settings-for-static-designs) and [keyboard layout](https://help.figma.com/hc/en-us/articles/5665442977431-Select-keyboard-layout).

Design system references [Component properties](https://help.figma.com/hc/en-us/articles/39636407507735-Components-collection-Component-property-fundamentals), [variable modes](https://help.figma.com/hc/en-us/articles/15343816063383-Modes-for-variables), [extended collections](https://help.figma.com/hc/en-us/articles/36346281624471-Extend-a-variable-collection) and [publishing libraries](https://help.figma.com/hc/en-us/articles/360025508373-Publish-a-library).

## Prototyping, handoff and review

| Capability | Designer coverage | Remaining gap |
| --- | --- | --- |
| Prototype flow authoring | This change adds a start frame and click actions to navigate across visible top level frames or go back. Links are stored with the project canvas and can be undone. | Multiple independent flows, canvas connectors, device settings, scroll destinations and prototype settings per flow. |
| Prototype presentation | This change adds keyboard accessible hotspots, frame fitting, back, restart and Escape to close. The player shows a static SVG snapshot of the design, with placeholders for live code layers. | Overlays, scrolling regions and fixed layers, device frames, responsive presentation, animation and transitions, video, and richer hotspot geometry. |
| Advanced interactions | Live code previews allow interaction with actual rendered Storybook or app content. | Native hover, drag, keyboard and timer triggers, component state changes, multi action interactions, variables, expressions and branching conditions. |
| Dev inspection | CSS, measured story styles, code linkage, rendered components and edit proposals. | Measurements and spec annotations in a dedicated handoff workflow, asset queue, version comparisons inside inspect, readiness and completion statuses, official Code Connect mapping parity and IDE integrations. |
| Comments and review | Canvas pins, replies, resolve, GitHub/Azure review integration and before/after screenshots. | Complete review permissions and notifications, mentions and activity filters, and formal handoff approvals. |
| Versions and branches | Git backed named versions, variations, restore, merge and review. | Layer aware diff and conflict resolution for canvas documents, publish from branch, protected library releases, branch review tied to editable design changes. |

References [Prototyping](https://help.figma.com/hc/en-us/articles/360040314193-Guide-to-prototyping-in-Figma), [actions](https://help.figma.com/hc/en-us/articles/360040035874-Prototype-actions), [presentation](https://help.figma.com/hc/en-us/articles/360040318013-Play-your-prototypes), [Dev Mode](https://help.figma.com/hc/en-us/articles/15023124644247-Guide-to-Dev-Mode-in-Figma), [change comparison](https://help.figma.com/hc/en-us/articles/15023193382935-Compare-changes-in-Dev-Mode) and [branching](https://help.figma.com/hc/en-us/articles/360063144053-Guide-to-branching).

## What matters for enterprise

| Enterprise workflow | Why teams use it | Designer position |
| --- | --- | --- |
| Libraries across products and brands | Publish an approved system, reuse it in each product, update consumers deliberately and track adoption. | Git and source catalogues are useful building blocks. Native cross project design assets, update review, using versions side by side, deprecation and usage analytics are open. |
| Brand and theme inheritance | Extend a common design vocabulary while each brand overrides specific values. | Code token drift review exists. Local variable collections, alias resolution, mode propagation, extended collections and supported bindings are open. |
| Review and handoff | Designers branch, reviewers see material changes, and engineers know which designs are ready to build. | Git review and visual comparison already work for code. Semantic design merge, library release review and design readiness tracking are open. |
| Shared fonts and tooling standards | Teams use the same typography and approved integrations across machines. | Open gaps include font distribution, private extensions, extension permissions, allowlists, origin restrictions and extension auditability. |
| Workspace administration | Organize teams, admins and resources around business units. | Designer operates in local projects with access from the host OS and repository. There is no separate organization, workspace administration or delegated role model. |
| Identity and audit | Apply SAML SSO and SCIM provisioning, enforce access policy, and track activity for incident review. | Enterprise identity, managed session policy, organization audit log exports and reviewable administrative actions are open. Git history covers tracked revisions. |
| Governance and external access | Apply guest, link and external content rules. Governance+ adds controls including multiple identity providers, enforced 2FA and enhanced session controls. | Hosted sharing, guest/link policy and data residency were excluded. Local audit, policy enforcement and extension isolation remain relevant. |
| Large file and long running operations | Protect work through interrupted writes and concurrent review activity, with performance budgets for large files. | This change makes canvas writes atomic and validates API JSON object envelopes. Desktop/canvas security review, document schema validation, integrity and load benchmarks remain open. |
| Other Figma products | FigJam is a whiteboard; Slides is for decks; Buzz is for branded production; Sites is for building and publishing websites; Make is for prompt driven interactive work. | Designer already has a code based AI workflow. These products have distinct data models and workflows and have no full equivalent in Designer. |

References [Plan comparison](https://help.figma.com/hc/en-us/articles/360040328273-Compare-Figma-plans-and-features), [Enterprise](https://help.figma.com/hc/en-us/articles/13840245466391-Enterprise-plan-overview), [organizations and workspaces](https://help.figma.com/hc/en-us/articles/360039957374-Get-started-with-organizations), [library analytics](https://help.figma.com/hc/en-us/articles/360039238353-View-and-explore-library-analytics), [extension governance](https://help.figma.com/hc/en-us/articles/4404228724759-Manage-plugins-and-widgets-in-an-organization) and [Governance+](https://help.figma.com/hc/en-us/articles/31825370509591-Governance-for-Figma).

## Dependencies for the remaining editor work

1. Establish stable page, layer, asset and reference IDs with a versioned migration, schema validation and round trip tests for legacy projects.
2. Build components, instance overrides, variables and local styles on those references. Exercise nested instances, mode inheritance, missing dependencies and library changes across Git branches.
3. Publish and resolve versioned libraries, then add semantic review and merge for editable design changes. Keep live source previews and code syncing in the same design workflow.
4. Finish layout, vectors, typography, import and export fidelity, and prototype actions. Run browser fixtures for every supported input and output and use the same fixtures for regression checks.
5. Define enterprise policy and audit boundaries for the local app, Git, and extensions. Enforce those boundaries where the owning system can authenticate the actor and reject prohibited actions.
