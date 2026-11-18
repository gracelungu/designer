// One source of truth for design tokens: Figma variables matched to the repo's tokens
// (CSS custom properties and Tailwind theme values), with drift between them reported.
// Pure functions only, so the server and the UI share them.

export type TokenKind = 'color' | 'size' | 'font' | 'shadow' | 'other';

/** A token declared in the repo. */
export interface CodeToken {
  name: string;
  value: string;
  file: string;
  line: number;
  selector: string;
  kind: TokenKind;
  source: 'css' | 'tailwind';
  /** The value with var(--x) references followed, when they could be. */
  resolved?: string;
}

export interface FigmaRGBA {
  r: number;
  g: number;
  b: number;
  a?: number;
}

/** A Figma variable value in one mode. */
export interface FigmaVariable {
  name: string;
  value: string | number | boolean | FigmaRGBA;
  type?: 'COLOR' | 'FLOAT' | 'STRING' | 'BOOLEAN';
  collection?: string;
  mode?: string;
}

export type PairStatus = 'in-sync' | 'drift' | 'figma-only' | 'code-only';

export interface TokenPair {
  /** Stable id of the pair: figma name (and mode), or the code name. */
  key: string;
  status: PairStatus;
  kind: TokenKind;
  mode?: string;
  figma?: { name: string; value: string; collection?: string };
  code?: CodeToken;
  /** How the two were matched. */
  match?: 'linked' | 'name' | 'loose-name';
}

export interface SyncSummary {
  inSync: number;
  drift: number;
  figmaOnly: number;
  codeOnly: number;
}

// ---------- names ----------

const GROUP_SYNONYMS: Record<string, string> = {
  colors: 'color',
  colour: 'color',
  colours: 'color',
  spacing: 'space',
  spaces: 'space',
  spacings: 'space',
  borderradius: 'radius',
  'border-radius': 'radius',
  radii: 'radius',
  rounded: 'radius',
  corner: 'radius',
  corners: 'radius',
  'corner-radius': 'radius',
  fontfamily: 'font',
  'font-family': 'font',
  fonts: 'font',
  family: 'font',
  fontsize: 'font-size',
  fontsizes: 'font-size',
  fontweight: 'font-weight',
  fontweights: 'font-weight',
  boxshadow: 'shadow',
  'box-shadow': 'shadow',
  shadows: 'shadow',
  elevation: 'shadow',
};

/** "Color/Primary/500", "--color-primary-500" and colors.primary.500 all become "color-primary-500". */
export function canonicalName(name: string): string {
  const parts = name
    .replace(/^--/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .split(/[/.\s_]+/)
    .map((p) => p.replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, ''))
    .filter((p) => p && p !== 'default');
  if (!parts.length) return '';
  const first = parts[0];
  const compact = first.replace(/-/g, '');
  parts[0] = GROUP_SYNONYMS[first] ?? GROUP_SYNONYMS[compact] ?? first;
  return parts.join('-').replace(/-+/g, '-');
}

const GROUPS = new Set(['color', 'space', 'radius', 'font', 'font-size', 'font-weight', 'shadow', 'size', 'text', 'line-height']);

/** The name without its group, e.g. color-primary-500 -> primary-500. */
function looseName(canonical: string): string {
  for (const g of GROUPS) if (canonical.startsWith(g + '-')) return canonical.slice(g.length + 1);
  return canonical;
}

// ---------- values ----------

export type NormValue = { type: 'color'; rgba: [number, number, number, number] } | { type: 'length'; px: number } | { type: 'string'; s: string };

const NAMED: Record<string, [number, number, number, number]> = {
  white: [255, 255, 255, 1],
  black: [0, 0, 0, 1],
  transparent: [0, 0, 0, 0],
  red: [255, 0, 0, 1],
};

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  s /= 100;
  l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

const num = (s: string, scale = 1) => (s.trim().endsWith('%') ? (parseFloat(s) / 100) * scale : parseFloat(s));

export function parseColorValue(input: string): [number, number, number, number] | null {
  const v = input.trim().toLowerCase();
  if (NAMED[v]) return NAMED[v];
  let m = /^#([0-9a-f]{3,8})$/.exec(v);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), h.length === 8 ? Math.round((n(6) / 255) * 1000) / 1000 : 1];
  }
  m = /^(rgba?|hsla?)\(([^)]*)\)$/.exec(v);
  if (m) {
    const parts = m[2].split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const alpha = parts[3] !== undefined ? num(parts[3], 1) : 1;
    if (m[1].startsWith('rgb')) return [num(parts[0], 255), num(parts[1], 255), num(parts[2], 255), alpha];
    const [r, g, b] = hslToRgb(parseFloat(parts[0]), parseFloat(parts[1]), parseFloat(parts[2]));
    return [r, g, b, alpha];
  }
  return null;
}

export function figmaColorToRgba(c: FigmaRGBA): [number, number, number, number] {
  return [c.r * 255, c.g * 255, c.b * 255, c.a ?? 1];
}

const isRGBA = (v: unknown): v is FigmaRGBA => !!v && typeof v === 'object' && 'r' in v && 'g' in v && 'b' in v;

/** Turns a token value into something comparable. Bare numbers are pixels, like Figma's. */
export function normalizeValue(value: string | number | boolean | FigmaRGBA, remPx = 16): NormValue {
  if (isRGBA(value)) return { type: 'color', rgba: figmaColorToRgba(value) };
  if (typeof value === 'number') return { type: 'length', px: value };
  if (typeof value === 'boolean') return { type: 'string', s: String(value) };
  const v = value.trim();
  const color = parseColorValue(v);
  if (color) return { type: 'color', rgba: color };
  const m = /^(-?\d*\.?\d+)(px|rem|em)?$/i.exec(v);
  if (m) return { type: 'length', px: parseFloat(m[1]) * (m[2] && m[2].toLowerCase() !== 'px' ? remPx : 1) };
  return { type: 'string', s: v.replace(/\s+/g, ' ').replace(/\s*,\s*/g, ',').replace(/["']/g, '').toLowerCase() };
}

export function sameValue(a: NormValue, b: NormValue): boolean {
  if (a.type === 'color' && b.type === 'color') return a.rgba.slice(0, 3).every((x, i) => Math.abs(x - b.rgba[i]) <= 1) && Math.abs(a.rgba[3] - b.rgba[3]) <= 0.01;
  if (a.type === 'length' && b.type === 'length') return Math.abs(a.px - b.px) < 0.01;
  if (a.type === 'string' && b.type === 'string') {
    // Font stacks: Figma has the family, code the whole stack. The first family decides.
    if (a.s === b.s) return true;
    return a.s.split(',')[0] === b.s.split(',')[0];
  }
  return false;
}

const hex2 = (n: number) =>
  Math.max(0, Math.min(255, Math.round(n)))
    .toString(16)
    .padStart(2, '0');

export function rgbaToHex(rgba: [number, number, number, number]): string {
  const [r, g, b, a] = rgba;
  return `#${hex2(r)}${hex2(g)}${hex2(b)}${a < 1 ? hex2(a * 255) : ''}`.toUpperCase();
}

/** A Figma value as text for people. */
export function formatFigmaValue(v: FigmaVariable['value']): string {
  if (isRGBA(v)) return rgbaToHex(figmaColorToRgba(v));
  if (typeof v === 'number') return String(Math.round(v * 1000) / 1000);
  return String(v);
}

/** Writes a Figma value in the style the code already uses (hex vs rgb, px vs rem, bare numbers). */
export function toCodeValue(figmaValue: string, codeValue: string, remPx = 16): string {
  const f = normalizeValue(figmaValue, remPx);
  const c = codeValue.trim();
  if (f.type === 'color') {
    if (/^rgba?\(/i.test(c)) {
      const [r, g, b, a] = f.rgba.map((x, i) => (i < 3 ? Math.round(x) : Math.round(x * 1000) / 1000));
      return a < 1 ? `rgba(${r}, ${g}, ${b}, ${a})` : `rgb(${r}, ${g}, ${b})`;
    }
    const hex = rgbaToHex(f.rgba);
    return /^#[0-9a-f]+$/.test(c) ? hex.toLowerCase() : hex;
  }
  if (f.type === 'length') {
    const round = (n: number) => String(Math.round(n * 10000) / 10000);
    if (/rem$/i.test(c)) return `${round(f.px / remPx)}rem`;
    if (/em$/i.test(c)) return `${round(f.px / remPx)}em`;
    if (/^-?\d*\.?\d+$/.test(c)) return round(f.px);
    return `${round(f.px)}px`;
  }
  // A font family: keep the rest of the code's stack.
  const fam = figmaValue.trim();
  const rest = c.split(',').slice(1).join(',');
  const quoted = /\s/.test(fam) && !/^["']/.test(fam) ? `"${fam}"` : fam;
  return rest ? `${quoted},${rest}` : quoted;
}

// ---------- Figma variable files ----------

type Json = null | string | number | boolean | Json[] | { [k: string]: Json };

/**
 * Reads Figma variables from any of the shapes people have:
 * - the desktop MCP server's get_variable_defs reply: { "Color/Primary": "#2563EB", "Space/4": "16" }
 * - Figma's REST API (GET /v1/files/:key/variables/local), with modes and aliases
 * - W3C design tokens (DTCG, Tokens Studio): nested groups with $value / value
 * - Designer's own snapshot: { variables: FigmaVariable[] }
 */
export function parseFigmaVariables(input: unknown): FigmaVariable[] {
  const data = (typeof input === 'string' ? JSON.parse(input) : input) as Json;
  if (!data || typeof data !== 'object') throw new Error('Expected a JSON object of Figma variables');
  const obj = data as Record<string, Json>;
  if (Array.isArray(obj.variables)) return (obj.variables as unknown as FigmaVariable[]).filter((v) => v && typeof v.name === 'string');
  const meta = (obj.meta ?? obj) as Record<string, Json>;
  if (meta.variables && meta.variableCollections && typeof meta.variables === 'object') return fromRest(meta);
  if (Array.isArray(data)) return (data as unknown as FigmaVariable[]).filter((v) => v && typeof v.name === 'string');
  return fromTree(obj);
}

function typeOf(v: FigmaVariable['value']): FigmaVariable['type'] {
  if (isRGBA(v)) return 'COLOR';
  if (typeof v === 'number') return 'FLOAT';
  if (typeof v === 'boolean') return 'BOOLEAN';
  return parseColorValue(v) ? 'COLOR' : /^-?\d*\.?\d+(px)?$/.test(v.trim()) ? 'FLOAT' : 'STRING';
}

function fromRest(meta: Record<string, Json>): FigmaVariable[] {
  type RestVar = { id: string; name: string; resolvedType?: string; variableCollectionId: string; valuesByMode: Record<string, Json>; remote?: boolean };
  type RestCol = { id: string; name: string; modes: { modeId: string; name: string }[]; defaultModeId?: string };
  const vars = meta.variables as unknown as Record<string, RestVar>;
  const cols = meta.variableCollections as unknown as Record<string, RestCol>;
  const out: FigmaVariable[] = [];
  const resolve = (v: Json, modeName: string, depth = 0): FigmaVariable['value'] | undefined => {
    if (v && typeof v === 'object' && !Array.isArray(v) && (v as Record<string, Json>).type === 'VARIABLE_ALIAS') {
      const target = vars[String((v as Record<string, Json>).id)];
      if (!target || depth > 10) return undefined;
      const col = cols[target.variableCollectionId];
      const mode = col?.modes.find((m) => m.name === modeName) ?? col?.modes.find((m) => m.modeId === col.defaultModeId) ?? col?.modes[0];
      return mode ? resolve(target.valuesByMode[mode.modeId], modeName, depth + 1) : undefined;
    }
    if (isRGBA(v)) return v as unknown as FigmaRGBA;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
    return undefined;
  };
  for (const v of Object.values(vars)) {
    if (v.remote) continue;
    const col = cols[v.variableCollectionId];
    if (!col) continue;
    for (const mode of col.modes) {
      const value = resolve(v.valuesByMode[mode.modeId], mode.name);
      if (value === undefined) continue;
      out.push({
        name: v.name,
        value,
        type: (v.resolvedType as FigmaVariable['type']) ?? typeOf(value),
        collection: col.name,
        mode: col.modes.length > 1 ? mode.name : undefined,
      });
    }
  }
  return out;
}

function fromTree(obj: Record<string, Json>): FigmaVariable[] {
  const flat: { name: string; value: Json }[] = [];
  const walk = (node: Json, path: string[]) => {
    if (node === null || node === undefined) return;
    if (typeof node !== 'object' || Array.isArray(node)) {
      if (path.length) flat.push({ name: path.join('/'), value: Array.isArray(node) ? node.join(', ') : node });
      return;
    }
    const n = node as Record<string, Json>;
    // DTCG uses $value; Tokens Studio uses { value, type }.
    const leaf = '$value' in n ? n.$value : 'value' in n && (typeof n.value !== 'object' || isRGBA(n.value) || 'type' in n) ? n.value : undefined;
    if (leaf !== undefined) {
      flat.push({ name: path.join('/'), value: leaf });
      return;
    }
    if (isRGBA(n)) {
      flat.push({ name: path.join('/'), value: n });
      return;
    }
    for (const [k, v] of Object.entries(n)) if (!k.startsWith('$')) walk(v, [...path, k]);
  };
  walk(obj, []);
  // DTCG aliases: "{color.blue.500}".
  const byPath = new Map(flat.map((f) => [f.name.replace(/\//g, '.'), f.value]));
  const deref = (v: Json, depth = 0): Json => {
    const m = typeof v === 'string' ? /^\{([^}]+)\}$/.exec(v.trim()) : null;
    return m && depth < 10 && byPath.has(m[1]) ? deref(byPath.get(m[1])!, depth + 1) : v;
  };
  return flat
    .map(({ name, value }) => {
      const v = deref(value);
      const val: FigmaVariable['value'] = isRGBA(v) ? (v as unknown as FigmaRGBA) : typeof v === 'number' || typeof v === 'boolean' ? v : String(v);
      return { name, value: val, type: typeOf(val) };
    })
    .filter((v) => v.name);
}

// ---------- matching ----------

/** Follows var(--x) references between code tokens. */
export function resolveCodeTokens(tokens: CodeToken[]): CodeToken[] {
  const base = new Map<string, string>();
  for (const t of tokens) if (!/dark/i.test(t.selector) && !base.has(t.name)) base.set(t.name, t.value);
  const follow = (v: string, depth = 0): string =>
    depth > 10 ? v : v.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^)]+))?\)/g, (_m, n: string, fb?: string) => (base.has(n) ? follow(base.get(n)!, depth + 1) : (fb?.trim() ?? _m)));
  return tokens.map((t) => ({ ...t, resolved: /var\(/.test(t.value) ? follow(t.value) : t.value }));
}

const isDarkMode = (mode?: string) => !!mode && /dark|night/i.test(mode);
const isDarkSelector = (sel: string) => /dark/i.test(sel);
const isBaseSelector = (t: CodeToken) => t.source === 'tailwind' || /^(:root|@theme|html|:host)\b/.test(t.selector) || t.selector === '@theme inline';

/** The code declaration that stands for a Figma mode: :root / @theme for the default mode, a dark selector for Dark. */
function pickForMode(candidates: CodeToken[], mode?: string): CodeToken | undefined {
  // With no dark override, the base value is what dark mode shows too.
  if (isDarkMode(mode)) return candidates.find((t) => isDarkSelector(t.selector)) ?? pickForMode(candidates);
  return candidates.find((t) => !isDarkSelector(t.selector) && isBaseSelector(t)) ?? candidates.find((t) => !isDarkSelector(t.selector));
}

function kindOf(f?: FigmaVariable, c?: CodeToken): TokenKind {
  if (c) return c.kind;
  if (!f) return 'other';
  if (f.type === 'COLOR' || isRGBA(f.value) || (typeof f.value === 'string' && parseColorValue(f.value))) return 'color';
  const n = canonicalName(f.name);
  if (/shadow/.test(n)) return 'shadow';
  if (/^font(?!-size|-weight)/.test(n) || /family/.test(n)) return 'font';
  if (f.type === 'FLOAT' || typeof f.value === 'number') return 'size';
  return 'other';
}

/**
 * Pairs every Figma variable with the code token it stands for and says whether they agree.
 * `links` are explicit Figma name -> code name links the user made; they win over name matching.
 */
export function syncTokens(figma: FigmaVariable[], code: CodeToken[], links: Record<string, string> = {}): TokenPair[] {
  const resolved = resolveCodeTokens(code);
  const byName = new Map<string, CodeToken[]>();
  const byCanon = new Map<string, Set<string>>();
  const byLoose = new Map<string, Set<string>>();
  for (const t of resolved) {
    byName.set(t.name, [...(byName.get(t.name) ?? []), t]);
    const c = canonicalName(t.name);
    byCanon.set(c, (byCanon.get(c) ?? new Set()).add(t.name));
    const l = looseName(c);
    byLoose.set(l, (byLoose.get(l) ?? new Set()).add(t.name));
  }
  // One candidate wins; with several (a Tailwind colour that only points at a CSS variable, say), the one holding the real value.
  const only = (names?: Set<string>): string | undefined => {
    if (!names?.size) return undefined;
    if (names.size === 1) return [...names][0];
    const real = [...names].filter((n) => byName.get(n)!.some((t) => !/^var\(/.test(t.value.trim())));
    return real.length === 1 ? real[0] : undefined;
  };
  const used = new Set<string>();
  const pairs: TokenPair[] = [];
  for (const f of figma) {
    const fc = canonicalName(f.name);
    let codeName: string | undefined;
    let match: TokenPair['match'];
    if (links[f.name] && byName.has(links[f.name])) {
      codeName = links[f.name];
      match = 'linked';
    } else if ((codeName = only(byCanon.get(fc)))) {
      match = 'name';
    } else if ((codeName = only(byLoose.get(looseName(fc))))) {
      match = 'loose-name';
    }
    const fv = { name: f.name, value: formatFigmaValue(f.value), collection: f.collection };
    const key = f.mode ? `${f.name}@${f.mode}` : f.name;
    const c = codeName ? pickForMode(byName.get(codeName)!, f.mode) : undefined;
    if (!c) {
      pairs.push({ key, status: 'figma-only', kind: kindOf(f), mode: f.mode, figma: fv });
      continue;
    }
    used.add(`${c.file}:${c.line}:${c.name}`);
    const same = sameValue(normalizeValue(f.value), normalizeValue(c.resolved ?? c.value));
    pairs.push({ key, status: same ? 'in-sync' : 'drift', kind: kindOf(f, c), mode: f.mode, figma: fv, code: c, match });
  }
  for (const c of resolved) {
    if (used.has(`${c.file}:${c.line}:${c.name}`)) continue;
    // A dark override of a token Figma has, when Figma has no dark mode, is not "missing in Figma".
    if (isDarkSelector(c.selector) && pairs.some((p) => p.code?.name === c.name)) continue;
    pairs.push({ key: `${c.name}@${c.file}:${c.line}`, status: 'code-only', kind: c.kind, code: c });
  }
  return pairs;
}

export function summarize(pairs: TokenPair[]): SyncSummary {
  const s: SyncSummary = { inSync: 0, drift: 0, figmaOnly: 0, codeOnly: 0 };
  for (const p of pairs) {
    if (p.status === 'in-sync') s.inSync++;
    else if (p.status === 'drift') s.drift++;
    else if (p.status === 'figma-only') s.figmaOnly++;
    else s.codeOnly++;
  }
  return s;
}

/** The tokens a raw value stands for (by its code or its Figma value), for the properties panel. */
export function tokensForValue(value: string | number, pairs: TokenPair[], kind?: TokenKind): TokenPair[] {
  const v = normalizeValue(value);
  const hits = pairs.filter((p) => {
    if (kind && p.kind !== kind) return false;
    if (p.mode && isDarkMode(p.mode)) return false;
    if (p.code && sameValue(v, normalizeValue(p.code.resolved ?? p.code.value))) return true;
    return !!p.figma && sameValue(v, normalizeValue(p.figma.value));
  });
  // Drift first: those are the ones to act on.
  const rank: Record<PairStatus, number> = { drift: 0, 'in-sync': 1, 'figma-only': 2, 'code-only': 3 };
  return hits.sort((a, b) => rank[a.status] - rank[b.status]);
}
