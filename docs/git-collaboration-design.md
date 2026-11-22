# Reproducing Figma’s collaboration model with Git

Designer can use a Git remote as the shared source of truth for saved design state, branches, review, releases, and recovery. Each change can be made offline, stored locally, and published when a connection is available. Git moves committed snapshots. Figma’s live collaboration, access controls, and design semantics require additional components described below.

## Workspace structure

| Figma concept | Representation in Designer | Boundary |
| --- | --- | --- |
| Organization and teams | Git provider organization, groups, repositories, and rules. Designer may group connected repositories into a local workspace. | Use repository access as the security boundary. Anyone who can clone a repo can generally read its objects and accessible refs. |
| Project | One connected repository by default. A monorepo can group design files into logical projects. Use separate repositories when the membership differs. | Choose whether design and code travel together. The same repo lets one pull request review both. A dedicated design repo keeps their permissions and history separate. |
| Design file | A stable document ID and a manifest in the repository. The name and folder are editable metadata. | A document must retain its ID through moves and renames so links and comments survive. |
| Page | An ordered entry in the document manifest with its own stable ID and canvas data. | Pages live inside design files. Branches represent versions of the checkout. |
| Main file | The document at the repository’s default branch. Branch protection and review rules are configured at the Git provider. | Main can consist of many design files. One Git branch forks the whole tree. |
| Branch | A Git branch such as `design/checkout-redesign`. A document scoped variation can record its affected document IDs and enforce scope before review. | A Figma branch is scoped to a file. Use a separate repository for truly independent permissions or histories, and a document scoped merge operation for a single file inside a shared repo. |
| Named version | A commit plus a version reference keyed by document ID, visible in relevant document history. | Current Designer already uses commits and named tags. File scoped versions need path filtering and stable IDs. |
| Restore a version | Restore the selected document or page from a commit and record a new commit. | The target version’s history remains intact. Current project restore operates on the whole project. |
| Design library | Versioned manifest referencing released components, styles, variables, and asset hashes. | A reviewed release ref identifies published content. Each consumer pins an exact commit and accepts updates explicitly. |

Figma references [organizations and workspaces](https://help.figma.com/hc/en-us/articles/360039957374-Get-started-with-organizations), [branching](https://help.figma.com/hc/en-us/articles/360063144053-Guide-to-branching), [managing branches](https://help.figma.com/hc/en-us/articles/5668839659415-View-and-manage-branches), and [libraries](https://help.figma.com/hc/en-us/articles/360041051154-Guide-to-libraries-in-Figma).

### Proposed storage schema

| Path | Content |
| --- | --- |
| `.designer/workspace.json` | Schema version, project IDs, names, ordered design file references, and relationships to code and libraries. |
| `.designer/documents/<document-id>/manifest.json` | Name, order of pages, file settings, dependency pins, and references to prototype flows. |
| `.designer/documents/<document-id>/pages/<page-id>.json` | Title, root layers, and deterministic object records keyed by stable layer IDs. Large pages can split objects into stable shards. |
| `.designer/documents/<document-id>/threads/<thread-id>.json` | Thread anchored to document ID, page ID, and layer ID or coordinates. Replies are individually identified. |
| `.designer/libraries/<library-id>/manifest.json` | Stable exported IDs, dependencies, version metadata, migration entries, and published asset references. |
| `.designer/assets/<content-hash>.<ext>` | Deduplicated images and fonts with limits and license metadata. Large binaries may use Git LFS when the remote and all clients support it. |
| Local Git configuration and app cache | Sync preference, checkout choice, device identity, cached previews, and editor presence. Credentials use Git’s credential store. |

The schema above is a proposed migration. The current implementation keeps `.designer/canvas.json` and `.designer/comments/<thread-id>.json` working. Preserve IDs and comments when converting the existing canvas into one document and one page. Validate the migrated tree before switching the reader to it. Keep generated previews, caches, and workspace credentials out of automatically published data.

## Collaboration workflows

| Workflow | How it works with Git | What Designer must supply |
| --- | --- | --- |
| Offline editing and autosave | Save into the working tree, then commit scoped design changes. | Durable and atomic writes, background retries, clear state for saved locally, published, received, or needs attention. |
| Share progress and join | Push the named branch. A teammate with access fetches it and checks it out in their clone. | Remote branch discovery and readable branch status. Shareable links can identify repository, branch or commit, document, page, and selected layer. Recipient still needs Git access. |
| Stay current on a shared branch | Fetch and fast-forward when the local checkout is clean. A remote advance during push rejects a non fast forward. | Pause for divergence. Offer a review of incoming differences. Preserve both sides when editing the same document. |
| Update a design branch from main | Fetch the default branch and merge it into the design branch after inspecting the changes. | Show affected documents and report semantic conflicts before applying changes. Preserve branch history to keep links to milestones valid. |
| Branch review and approval | Open a pull request and use provider reviewers, protected branches, status checks, and merge rules. | Canvas thumbnails and a visual diff, comments scoped to layers, ready for dev markers, and design checks with a reproducible snapshot. |
| Resolve design conflicts | Compute from merge base, local, and incoming commits. | Merge independent changes by object ID and field. Ask a user about opposing values, deletion versus modification, reparenting, and incompatible order changes. Validate all references before committing. A text merge on canvas JSON cannot infer these rules. |
| Create, move, duplicate, delete, or archive | Manifest changes and commits record structure. Archive refs can keep branch history available. | Stable references, explicit duplication of IDs, trash and recovery UX, and review of destructive changes. |
| Feedback and review status | Repository threads sync as files. Provider pull request comments, approvals, and webhooks carry review state. | Bridge comments to their stable anchors. Merge distinct replies independently. Track resolved state and record team notification preferences. |
| Publish and upgrade a library | Review component changes, cut a release at a protected ref, and pin the release commit in a consumer project. | Compatibility checks, dependency resolution, preview of affected instances and variables, migration suggestions, and explicit acceptance or rollback. |
| Compare versions and handoff | Work from an immutable commit or release with links to the source version. | Inspect dimensions, tokens, annotations, exported assets, links to code, and changes since the last approved version. |
| Asset portability | Git stores source artwork and small assets. LFS can store larger binary content. | Verify hashes and safe paths, handle missing assets offline, and report size and license policy. Keep large files out of auto sync until the project enables a storage policy. |
| Governance and audit | A managed Git provider can supply identity, team policies, review requirements, signed commits, and audit exports according to its plan. | Keep identity mapping and audit provenance honest. A commit records repository history. It cannot prove who opened a file, enforce permissions inside a checkout, or retain full provider policy events. |
| Analytics | A scanner can compute known component use and dependency versions from accessible repositories and commits. | Cross team aggregation, approved access, and consent or retention for user activity. Git history only represents data that was committed. |
| Realtime editing and presence | Git can preserve agreed snapshots after a live session. | Live cursors, multiplayer text, chat, and presence need a realtime transport plus a collaborative document model. Git polling only provides eventual snapshots. |
| Guest previews and file permissions | Share a protected project or publish an approved export via the existing Git host or CI. | File or page level access inside a shared clone, revocation of cloned content, anonymous prototype links, and historical purging need separate controls. Use separate repositories for actual access boundaries. |

Review references [updating from main](https://help.figma.com/hc/en-us/articles/5665728006423-Get-updates-from-main-files), [merging branches](https://help.figma.com/hc/en-us/articles/5691189138839-Merge-branch-into-main-file), [sharing branches](https://help.figma.com/hc/en-us/articles/5665697002263-Share-a-branch), and [plan capabilities](https://help.figma.com/hc/en-us/articles/360040328273-Compare-Figma-plans-and-features).

Git reference [Merging and fast forwarding](https://git-scm.com/docs/git-merge).

## What works in this change

1. Open a clone of the shared repository in Designer. Use the repository root and one `origin` with the same fetch and push URL. Designer uses Git’s existing credentials.
2. In **Versions**, create a design variation. Designer puts a plain name under `design/`. Choose **Sync design now** or check **Automatically sync this branch**.
3. On the other computer, open the repository in Designer, choose **Refresh branches**, and open the team variation. Each teammate can enable automatic sync in their own clone.
4. The sender publishes canvas and comment commits. The recipient checks out incoming commits when their working tree is clean. A diverged branch pauses so both copies can be reviewed and merged.

Automatic sync checks for changes about every 30 seconds while the Designer window is active and eligible. It briefly pauses editing when it needs to update the checkout. Use it with repositories and collaborators you trust. The preference is local to the checkout’s Git configuration. It applies to the selected working branch and never opts another teammate in. The repository’s default branch stays on the review workflow. The design sync does not publish unrelated working changes or local code commits. The older **Sync entire project** action retains its explicit whole project behaviour.

## Implementation order for the remaining work

1. Migrate to stable workspace, document, page, object, asset, and thread IDs. Add document and page navigation, multi file fixtures, and migration and compatibility tests.
2. Build document scoped history, named milestones, selective restore, immutable links, and a visual before and after comparison.
3. Build the three way document merge and conflict UI, then gate Git merges with schema and referential integrity checks. Add remote failures and concurrent edit fixtures.
4. Publish component, variable, and style libraries with immutable versions, dependency pins, previews, update acceptance, and rollback.
5. Connect provider identity, pull request reviews, access policy, CI preview exports, and audit data where those APIs are available. Introduce live transport only if simultaneous editing becomes a requirement.

## Opting into a tracked workspace

Open **Versions → Shared workspace → Set up shared workspace** to choose a shared name and create `.designer/workspace.json`. This small manifest starts with a schema version and a stable workspace ID. Designer stages only this manifest. Collaborators receive it as part of the branch once committed and synced. Renaming preserves its ID, and imported workspaces can be tracked explicitly. The setup respects repository ignore rules and leaves credentials and the automatic sync preference in the local environment. The document and library manifests in the proposed schema can build on this workspace ID as those features land.

## Reviewing a design change before applying it

In the design and code review panel, choose whether an edit belongs to one example, the production component default, or a named shared token. Review the intended values, the proposed file diff, and possible source references. Reference results are text matches and may miss indirect consumers.

The agent reads the project and suggests its own preparation commands, tests, and preview routes. **Run preview and checks** runs those commands locally in temporary copies. Browser previews use an allocated `$PORT`. Projects that only have verification commands can use the same flow without a browser preview. A missing runtime, project dependency or suitable verification command appears as failed or skipped evidence.

After applying a proposal, you can include its intent, check results, and available comparisons in **Share for review**. Designer only attaches that evidence when the proposal’s changed files match the PR commit. The validation itself ran against the temporary workspace snapshots, so it does not replace the repository’s CI.
