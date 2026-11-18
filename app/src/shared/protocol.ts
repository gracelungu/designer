// Messages exchanged between the Designer UI and its local server.
// Everything Claude-specific in here is filled from the installed Claude Code
// at runtime (models, commands, MCP servers, sessions); nothing is hardcoded.

/** A mode name as Claude Code reports it (from `claude --help`), e.g. manual, acceptEdits, plan, auto. */
export type PermissionMode = string;

export interface ClaudeInstall {
  found: boolean;
  path?: string;
  version?: string;
  loggedIn?: boolean;
  authMethod?: string;
  apiProvider?: string;
  error?: string;
}

export interface ModelOption {
  value: string;
  displayName: string;
  description: string;
  supportedEffortLevels: string[];
  supportsAutoMode: boolean;
  supportsFastMode: boolean;
}

export interface CommandOption {
  name: string;
  description: string;
  argumentHint: string;
  builtin: boolean;
}

export interface McpServerInfo {
  name: string;
  status: string;
  scope?: string;
  error?: string;
  toolCount: number;
}

export interface ModeOption {
  value: PermissionMode;
  label: string;
  description: string;
}

export interface Capabilities {
  claudeVersion?: string;
  models: ModelOption[];
  commands: CommandOption[];
  agents: { name: string; description?: string }[];
  outputStyles: string[];
  outputStyle?: string;
  account: Record<string, unknown>;
  mcpServers: McpServerInfo[];
  modes: ModeOption[];
  fastMode?: string;
}

export interface SessionSummary {
  sessionId: string;
  title: string;
  lastModified: number;
  gitBranch?: string;
}

export interface MemoryFile {
  scope: 'project' | 'project-local' | 'user';
  path: string;
  exists: boolean;
  content: string;
}

export interface StoryEntry {
  file: string;
  title: string;
  stories: { exportName: string; name: string; id: string }[];
}

export interface GitStatus {
  isRepo: boolean;
  branch?: string;
  remote?: string;
  ahead: number;
  behind: number;
  changed: { path: string; status: string }[];
  lastCommit?: string;
}

export interface ProjectInfo {
  path: string;
  name: string;
  git: GitStatus;
  scripts: Record<string, string>;
  stories: StoryEntry[];
  /** Reusable components found in the source, with their props, linked to their stories. */
  components: ComponentEntry[];
}

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';
export type FrameworkId = 'next' | 'nuxt' | 'remix' | 'react-router' | 'astro' | 'sveltekit' | 'gatsby' | 'angular' | 'cra' | 'vite' | 'parcel' | 'webpack' | 'node' | 'unknown';

export interface ComponentProp {
  name: string;
  type?: string;
  optional: boolean;
  default?: string;
}

export interface ComponentEntry {
  name: string;
  /** Path relative to the project. */
  file: string;
  /** The export to import it by ("default" for a default export). */
  exportName: string;
  framework: 'react' | 'vue' | 'svelte';
  props: ComponentProp[];
  /** Storybook story ids that render it; empty when it has no story yet. */
  storyIds: string[];
}

/** How a project runs, worked out from its files. */
export interface ProjectPlan {
  framework: FrameworkId;
  frameworkName: string;
  packageManager: PackageManager;
  packageManagerReason: string;
  /** Folder of the app to run, relative to the project ("." or e.g. "apps/web" in a monorepo). */
  appDir: string;
  /** Where dependencies get installed (the workspace root in a monorepo). */
  installDir: string;
  devScript?: string;
  devCommand?: string;
  installCommand?: string;
  needsInstall: boolean;
  portEnv: boolean;
  portFlag: boolean;
  asksWhenPortBusy: boolean;
  hasStorybook: boolean;
  notes: string[];
}

export type SetupStepId = 'detect' | 'index' | 'install' | 'start' | 'storybook';
export interface SetupStep {
  id: SetupStepId;
  label: string;
  status: 'pending' | 'running' | 'done' | 'skipped' | 'failed';
  detail?: string;
}

/** Progress of the automatic setup that runs when a project is added. */
export interface SetupState {
  project: string;
  status: 'running' | 'done' | 'failed';
  plan?: ProjectPlan;
  steps: SetupStep[];
  appUrl?: string;
  storybookUrl?: string;
  components: number;
  error?: string;
}

/** A comment pinned to the canvas. Saved as .designer/comments/<id>.json so it travels with the repo. */
export interface CanvasComment {
  id: string;
  num: number;
  /** Where it was dropped, in canvas pixels (used if its layer is gone). */
  x: number;
  y: number;
  /** The frame (or layer) it is pinned to; dx/dy are its offset inside that layer. */
  nodeId: string | null;
  dx: number;
  dy: number;
  author: string;
  text: string;
  at: number;
  resolved: boolean;
  replies: { author: string; text: string; at: number }[];
}

/** One frame of a shareable preview, drawn by the canvas. */
export interface PreviewFrame {
  id: string;
  name: string;
  w: number;
  h: number;
  svg: string;
  css?: string;
  /** Coded components inside it, or the components its layers link to. */
  components?: { name: string; storyId?: string; file?: string }[];
  /** Comment pins inside the frame, in frame pixels. */
  pins?: { id: string; x: number; y: number }[];
}

/** Where a project's pull requests live. */
export type ReviewHost = 'github' | 'azure';

export interface ReviewStatus {
  host: ReviewHost | null;
  /** Ready to list pull requests; otherwise `problem` says what is missing. */
  ready: boolean;
  problem?: string;
  /** For Azure DevOps: organization, project and repository read from the remote. */
  org?: string;
  project?: string;
  repo?: string;
}

export interface PullRequestSummary {
  id: number;
  title: string;
  author: string;
  branch: string;
  target: string;
  status: string;
  url: string;
  draft?: boolean;
  updatedAt?: string;
}

export interface ReviewThread {
  id: string;
  /** File and line the thread is on, if it is a code comment. */
  file?: string;
  line?: number;
  resolved: boolean;
  comments: { id: string; author: string; text: string; at?: string }[];
}

export interface FileChange {
  toolUseId: string;
  tool: string;
  path: string;
  before: string;
  after: string;
}

/** One view (a story or a page) photographed before and after a change. Image fields are file names in the review's folder. */
export interface VisualShot {
  key: string;
  label: string;
  kind: 'story' | 'page';
  storyId?: string;
  url?: string;
  before?: string;
  after?: string;
  /** Before and after with every changed pixel in red. Only there when something changed. */
  diff?: string;
  /** Share of pixels that changed, 0..1. */
  changed?: number;
  sizeChanged?: boolean;
  error?: string;
}

/** A visual review of one change: what Claude (or a token edit) did, and how it looks before and after. */
export interface VisualReview {
  id: string;
  title: string;
  createdAt: number;
  files: string[];
  shots: VisualShot[];
  note?: string;
  /** Still taking the after pictures. */
  capturing?: boolean;
  /** The pull request it was sent in. */
  sentIn?: string;
}

export type ShareStep = 'branch' | 'save' | 'screenshots' | 'push' | 'pr';

/** A saved version, in designer words: a git commit. */
export interface VersionEntry {
  id: string;
  short: string;
  title: string;
  description?: string;
  author: string;
  date: number;
  /** A named version (a tag Designer made), shown as a milestone. */
  name?: string;
  /** Files changed in it. */
  files: number;
  /** Not on the team's copy yet. */
  local: boolean;
}

/** A variation, in designer words: a git branch. */
export interface Variation {
  name: string;
  current: boolean;
  /** Last change on it. */
  updated: number;
  title: string;
  /** On the team's copy too. */
  shared: boolean;
}

export interface VersionHistory {
  branch?: string;
  main: string;
  versions: VersionEntry[];
  variations: Variation[];
  unsaved: number;
  ahead: number;
  behind: number;
  remote?: string;
}

/** An image or text file attached to a chat message. */
export interface Attachment {
  name: string;
  mediaType: string;
  /** Base64 for images, plain text for text files. */
  data: string;
}

/**
 * Layers in a simple, Figma-like shape that Claude writes (from a Figma file, or from scratch)
 * and the canvas turns into editable layers.
 */
export interface SimpleNode {
  type: 'frame' | 'group' | 'rect' | 'ellipse' | 'line' | 'text' | 'image' | 'component';
  name?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  radius?: number | [number, number, number, number];
  opacity?: number;
  rotation?: number;
  clip?: boolean;
  shadow?: { x?: number; y?: number; blur?: number; spread?: number; color?: string; opacity?: number };
  text?: { content: string; fontFamily?: string; fontSize?: number; fontWeight?: number; color?: string; align?: 'left' | 'center' | 'right'; lineHeight?: number; letterSpacing?: number; italic?: boolean };
  layout?: { mode: 'horizontal' | 'vertical'; gap?: number; padding?: number | [number, number, number, number]; align?: 'start' | 'center' | 'end' | 'space-between'; counterAlign?: 'start' | 'center' | 'end' | 'stretch' };
  sizing?: { h?: 'fixed' | 'hug' | 'fill'; v?: 'fixed' | 'hug' | 'fill' };
  imageUrl?: string;
  /** For type component: a Storybook story id, rendered live from the repo's code. */
  storyId?: string;
  args?: Record<string, unknown>;
  /** Links a design layer to the coded component that implements it. */
  codeLink?: { storyId?: string; file?: string; exportName?: string };
  children?: SimpleNode[];
}

export type CanvasOp =
  | { kind: 'add-nodes'; nodes: SimpleNode[]; nextToSelection?: boolean; select?: boolean }
  | { kind: 'update-nodes'; updates: (Partial<SimpleNode> & { id: string })[] }
  | { kind: 'show-component'; storyId: string; title: string; src: string; args?: Record<string, unknown>; nextToSelection?: boolean; file?: string }
  | { kind: 'show-page'; url: string; src: string; name: string; width: number; height: number }
  | { kind: 'select'; ids: string[] };

/** What the canvas tells Claude about itself: the selection in detail and the top-level layers in brief. */
export interface CanvasState {
  selection: unknown[];
  layers: { id: string; name: string; type: string; x: number; y: number; w: number; h: number; children?: number }[];
}

// ----- Two-way sync between canvas layers and code -----

/** One property of a layer that changed, in design terms (Fill, Corner radius, ...). */
export interface DesignChange {
  /** Key in a sync snapshot, e.g. fill, radius, padding, fontSize, content, or arg:<name> for a prop. */
  prop: string;
  label: string;
  from: unknown;
  to: unknown;
  /** The same change as CSS, when there is one (e.g. "background-color: #2563EB"). */
  css?: string;
}

/** A canvas layer linked to code, with what changed on the canvas since design and code last matched. */
export interface LayerSync {
  layerId: string;
  name: string;
  /** design: a design layer linked to a component; component: a live render whose props changed. */
  kind: 'design' | 'component';
  storyId?: string;
  file?: string;
  exportName?: string;
  changes: DesignChange[];
}

export interface SyncFile {
  path: string;
  /** null when Claude created the file. */
  before: string | null;
  after: string;
}

/** A design-to-code request run by the local Claude Code, and the code change it proposes. */
export interface SyncJob {
  id: string;
  layers: LayerSync[];
  status: 'running' | 'review' | 'kept' | 'discarded' | 'failed';
  progress: string[];
  files: SyncFile[];
  summary: string;
  error?: string;
  /** Files Discard left alone because they changed again after Claude's edit. */
  skipped?: string[];
  createdAt: number;
}

/** Code that changed under the canvas: a pull, a commit or a branch switch moved HEAD. */
export interface CodeChange {
  from: string;
  to: string;
  files: string[];
  reason: 'pull' | 'head';
}

// ----- WebSocket: client -> server -----
export type ClientMessage =
  | { type: 'start'; resume?: string; model?: string; effort?: string; mode?: PermissionMode }
  | { type: 'prompt'; text: string; attachments?: Attachment[]; context?: string }
  | { type: 'canvas-state'; state: CanvasState }
  | { type: 'canvas-result'; requestId: string; result: unknown }
  | { type: 'interrupt' }
  | { type: 'set-model'; model: string }
  | { type: 'set-mode'; mode: PermissionMode }
  | { type: 'permission'; requestId: string; allow: boolean; message?: string }
  | { type: 'rewind'; userMessageId: string; dryRun?: boolean }
  | { type: 'connect-figma'; url: string }
  | { type: 'stop' };

// ----- WebSocket: server -> client -----
export type ChatItem =
  | { kind: 'user'; id: string; text: string; userMessageId?: string; attachments?: { name: string; mediaType: string; preview?: string }[]; context?: string }
  | { kind: 'assistant'; id: string; text: string; streaming?: boolean }
  | { kind: 'thinking'; id: string; text: string }
  | { kind: 'tool'; id: string; name: string; summary: string; input: unknown; status: 'running' | 'done' | 'error'; output?: string }
  | { kind: 'permission'; id: string; requestId: string; tool: string; summary: string; input: unknown; state: 'pending' | 'allowed' | 'denied' }
  | { kind: 'result'; id: string; ok: boolean; text: string; costUsd?: number; durationMs?: number; turns?: number }
  | { kind: 'system'; id: string; text: string }
  | { kind: 'error'; id: string; text: string };

export type ServerMessage =
  | { type: 'session'; sessionId?: string; model?: string; effort?: string; mode?: PermissionMode; running: boolean; busy: boolean }
  | { type: 'item'; item: ChatItem }
  | { type: 'delta'; id: string; text: string }
  | { type: 'file-change'; change: FileChange }
  | { type: 'rewound'; userMessageId: string; dryRun: boolean; result: { canRewind: boolean; error?: string; filesChanged?: string[]; insertions?: number; deletions?: number } }
  | { type: 'history'; items: ChatItem[] }
  | { type: 'project'; project: ProjectInfo | null }
  | { type: 'run'; kind: 'app' | 'storybook'; url: string }
  | { type: 'setup'; setup: SetupState | null }
  | { type: 'canvas-op'; requestId: string; op: CanvasOp }
  | { type: 'sync'; job: SyncJob }
  | { type: 'code-changed'; change: CodeChange }
  | { type: 'comments'; comments: CanvasComment[] }
  | { type: 'review'; review: VisualReview }
  | { type: 'share-step'; step: ShareStep; state: 'running' | 'done' | 'skipped' | 'error'; detail?: string }
  | { type: 'error'; text: string };
