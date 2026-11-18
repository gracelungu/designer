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
}

export interface FileChange {
  toolUseId: string;
  tool: string;
  path: string;
  before: string;
  after: string;
}

// ----- WebSocket: client -> server -----
export type ClientMessage =
  | { type: 'start'; resume?: string; model?: string; effort?: string; mode?: PermissionMode }
  | { type: 'prompt'; text: string }
  | { type: 'interrupt' }
  | { type: 'set-model'; model: string }
  | { type: 'set-mode'; mode: PermissionMode }
  | { type: 'permission'; requestId: string; allow: boolean; message?: string }
  | { type: 'rewind'; userMessageId: string; dryRun?: boolean }
  | { type: 'connect-figma'; url: string }
  | { type: 'stop' };

// ----- WebSocket: server -> client -----
export type ChatItem =
  | { kind: 'user'; id: string; text: string; userMessageId?: string }
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
  | { type: 'error'; text: string };
