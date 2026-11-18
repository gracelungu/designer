// Loose types for TypeScript hosts. The editor itself is plain JavaScript.
/* eslint-disable @typescript-eslint/no-explicit-any */
export type EditorNode = {
  id: string;
  type: string;
  name: string;
  parent: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  visible: boolean;
  locked: boolean;
  opacity: number;
  fills: any[];
  strokes: any[];
  strokeWidth: number;
  effects: any[];
  radius: number;
  radii: number[] | null;
  children?: string[];
  layout?: any;
  sizing?: { h: string; v: string };
  clip?: boolean;
  text?: any;
  code?: { kind: 'component' | 'page'; src: string | null; title: string; hug: boolean; args: Record<string, unknown>; storyId?: string; file?: string; url?: string; measured?: { w: number; h: number } };
  codeLink?: { storyId?: string; file?: string; exportName?: string };
  [k: string]: any;
};
export interface CodeInfo {
  storyId?: string;
  title?: string;
  name?: string;
  argTypes?: Record<string, { name: string; type?: string; control?: string | null; options?: unknown[] | null; description?: string; defaultValue?: string; category?: string | null }>;
  initialArgs?: Record<string, unknown>;
  args?: Record<string, unknown>;
  styles?: Record<string, string>;
  measured?: { w: number; h: number };
  error?: string | null;
}
export declare class Store {
  doc: { name: string; nodes: Record<string, EditorNode>; root: string[]; comments: any[]; page: { name: string; background: string } };
  assets: Record<string, string>;
  selection: string[];
  view: { x: number; y: number; zoom: number };
  tool: string;
  undoStack: string[];
  redoStack: string[];
  on(fn: (changes: Set<string>) => void): () => void;
  emit(kind?: string): void;
  get(id: string): EditorNode | undefined;
  parent(id: string): EditorNode | null;
  selected(): EditorNode[];
  select(ids: string[], opts?: { add?: boolean; toggle?: boolean }): void;
  create(type: string, props?: Record<string, unknown>, parentId?: string | null, index?: number | null): EditorNode;
  insert(n: EditorNode, parentId?: string | null, index?: number | null): void;
  remove(id: string): void;
  update(id: string, props: Record<string, unknown>): void;
  transact<T>(fn: () => T): T;
  checkpoint(): void;
  commit(): void;
  finalize(): void;
  load(doc: any, assets?: Record<string, string>): void;
  undo(): boolean;
  redo(): boolean;
  worldBox(id: string): { x: number; y: number; w: number; h: number };
  selectionBox(ids?: string[]): { x: number; y: number; w: number; h: number } | null;
  allIds(): string[];
  moveBy(id: string, dx: number, dy: number): void;
}
export declare class Editor {
  constructor(root: HTMLElement, opts?: { store?: Store });
  root: HTMLElement;
  store: Store;
  code: { info: Map<string, CodeInfo>; interacting: string | null; interact(id: string | null): void; post(id: string, msg: Record<string, unknown>): void; syncArgs(id: string, force?: boolean): void; frames: Map<string, any> };
  setTool(id: string): void;
  zoomToFit(): void;
  zoomToSelection(): void;
  zoomStep(dir: number): void;
  zoomAt(zoom: number): void;
  zoomToBox(b: { x: number; y: number; w: number; h: number }, opts?: { max?: number; pad?: number }): void;
  viewRect(): { x: number; y: number; w: number; h: number };
  pickImages(): void;
  showShortcuts?: () => void;
}
export declare const TOOL_INFO: Record<string, { label: string; key: string }>;
export declare function emptyDoc(): any;
export declare function createNode(type: string, props?: Record<string, unknown>): EditorNode;
export declare function uid(): string;
export declare function solid(color: string, opacity?: number): any;
export declare function shadow(kind?: string): any;
export declare function defaultLayout(mode?: string): any;
export declare const FRAME_PRESETS: any[];
export declare const commands: Record<string, (...args: any[]) => any>;
export declare class Toolbar { constructor(editor: Editor, el: HTMLElement, opts?: { onAskAI?: (btn?: HTMLElement) => void }); }
export declare class LayersPanel { constructor(editor: Editor, el: HTMLElement); }
export declare class PropertiesPanel { constructor(editor: Editor, el: HTMLElement, opts?: { layers?: LayersPanel }); tab: string; }
export declare function bindShortcuts(editor: Editor, opts?: { layers?: LayersPanel; onShortcuts?: () => void; onAskAI?: () => void }): { getClipboard(): unknown; unbind(): void };
export declare const SHORTCUTS: [string, [string, string][]][];
export declare function showMenu(items: any[], x: number, y: number, opts?: any): void;
export declare function toast(text: string): void;
export declare function download(name: string, content: string, type?: string): void;
export declare function cssFor(store: Store, n: EditorNode): string;
export declare function exportSVG(store: Store, ids: string[]): string;
