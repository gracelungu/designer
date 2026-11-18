// A design preview developers can open without Designer: every top-level frame as an SVG, the
// comments on it, and its specs (size, CSS, the coded components it uses). It is written into the
// project (.designer/preview/) so it travels with the branch: on GitHub or Azure DevOps the folder's
// README shows the frames and comments, and index.html is a single file anyone can open offline.

import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CanvasComment, PreviewFrame } from '../shared/protocol.js';

export const PREVIEW_DIR = '.designer/preview';

export function slugify(name: string, taken: Set<string>) {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'frame';
  let slug = base;
  for (let i = 2; taken.has(slug); i++) slug = `${base}-${i}`;
  taken.add(slug);
  return slug;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
/** Markdown text that cannot open links, images or HTML. */
const mdText = (s: string) => esc(s).replace(/([\\`*_[\]()#|!])/g, '\\$1').replace(/\r?\n/g, ' ');

/**
 * The web address of the preview folder on the branch, for GitHub and Azure DevOps remotes.
 * Undefined for other hosts or a local-only repo.
 */
export function previewLink(remote: string | undefined, branch: string | undefined): string | undefined {
  if (!remote || !branch) return undefined;
  const gh = /github\.com[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(remote);
  if (gh) return `https://github.com/${gh[1]}/${gh[2]}/tree/${encodeURI(branch)}/${PREVIEW_DIR}`;
  const az = parseAzureRemote(remote);
  if (az) return `https://dev.azure.com/${encodeURIComponent(az.org)}/${encodeURIComponent(az.project)}/_git/${encodeURIComponent(az.repo)}?path=/${PREVIEW_DIR}/README.md&version=GB${encodeURIComponent(branch)}`;
  return undefined;
}

/** Reads organization, project and repository from an Azure DevOps remote (https, ssh, or the old visualstudio.com form). */
export function parseAzureRemote(remote: string): { org: string; project: string; repo: string } | undefined {
  const d = decodeURIComponent;
  let m = /dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/?#]+)/.exec(remote);
  if (m) return { org: d(m[1]), project: d(m[2]), repo: d(m[3]).replace(/\.git$/, '') };
  m = /ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/([^/?#]+)/.exec(remote);
  if (m) return { org: d(m[1]), project: d(m[2]), repo: d(m[3]).replace(/\.git$/, '') };
  m = /\/\/(?:[^@/]+@)?([^.]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/([^/?#]+)/.exec(remote);
  if (m) return { org: d(m[1]), project: d(m[2]), repo: d(m[3]).replace(/\.git$/, '') };
  return undefined;
}

export interface PreviewInput {
  title: string;
  frames: PreviewFrame[];
  comments: CanvasComment[];
  /** Comment ids pinned to each frame id (from the canvas); the rest are listed as "elsewhere". */
  link?: string;
  generatedAt?: Date;
}

export function buildPreview(input: PreviewInput): { files: Record<string, string>; slugs: Record<string, string> } {
  const taken = new Set<string>();
  const slugs: Record<string, string> = {};
  for (const f of input.frames) slugs[f.id] = slugify(f.name, taken);
  const byId = new Map(input.comments.map((c) => [c.id, c]));
  const onFrame = new Set(input.frames.flatMap((f) => (f.pins ?? []).map((p) => p.id)));
  const loose = input.comments.filter((c) => !onFrame.has(c.id) && !c.resolved);
  const when = (input.generatedAt ?? new Date()).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const files: Record<string, string> = {};

  // ---- README.md (what GitHub and Azure DevOps show for the folder) ----
  const md: string[] = [`# ${mdText(input.title)}`, '', `Design preview from Designer, made ${when}. Open \`index.html\` for the interactive version with comment pins and specs.`, ''];
  for (const f of input.frames) {
    const slug = slugs[f.id];
    md.push(`## ${mdText(f.name)}`, '', `![${mdText(f.name)}](./${slug}.svg)`, '', `${Math.round(f.w)} × ${Math.round(f.h)}`, '');
    if (f.components?.length) {
      md.push('**Components**', '');
      for (const c of f.components) md.push(`- ${mdText(c.name)}${c.file ? ` · [\`${mdText(c.file)}\`](../../${c.file.split('/').map(encodeURIComponent).join('/')})` : ''}${c.storyId ? ` · story \`${mdText(c.storyId)}\`` : ''}`);
      md.push('');
    }
    const cs = (f.pins ?? []).map((p) => byId.get(p.id)).filter((c): c is CanvasComment => !!c);
    if (cs.length) {
      md.push('**Comments**', '');
      for (const c of cs) md.push(...commentMd(c));
      md.push('');
    }
    if (f.css) md.push('<details><summary>CSS</summary>', '', '```css', f.css.replace(/```/g, ''), '```', '', '</details>', '');
  }
  if (loose.length) {
    md.push('## Other comments', '');
    for (const c of loose) md.push(...commentMd(c));
    md.push('');
  }
  if (!input.frames.length) md.push('_The canvas has no frames yet._', '');
  files['README.md'] = md.join('\n');

  // ---- one SVG per frame ----
  for (const f of input.frames) files[`${slugs[f.id]}.svg`] = f.svg;

  // ---- index.html: one self-contained page ----
  files['index.html'] = previewHtml(input, slugs, byId, loose, when);
  return { files, slugs };
}

function commentMd(c: CanvasComment) {
  const out = [`- **#${c.num}** ${c.resolved ? '~~' : ''}${mdText(c.author)}: ${mdText(c.text)}${c.resolved ? '~~ (resolved)' : ''}`];
  for (const r of c.replies) out.push(`  - ${mdText(r.author)}: ${mdText(r.text)}`);
  return out;
}

function previewHtml(input: PreviewInput, slugs: Record<string, string>, byId: Map<string, CanvasComment>, loose: CanvasComment[], when: string) {
  const thread = (c: CanvasComment) =>
    `<li class="c${c.resolved ? ' done' : ''}" id="c-${esc(c.id)}"><span class="n">${c.num}</span><div><b>${esc(c.author)}</b> ${esc(c.text)}${c.resolved ? ' <em>resolved</em>' : ''}${c.replies.map((r) => `<div class="r"><b>${esc(r.author)}</b> ${esc(r.text)}</div>`).join('')}</div></li>`;
  const frames = input.frames
    .map((f) => {
      const cs = (f.pins ?? []).filter((p) => byId.has(p.id));
      const pins = cs
        .map((p) => {
          const c = byId.get(p.id)!;
          return `<a class="pin${c.resolved ? ' done' : ''}" href="#c-${esc(c.id)}" style="left:${((p.x / Math.max(f.w, 1)) * 100).toFixed(2)}%;top:${((p.y / Math.max(f.h, 1)) * 100).toFixed(2)}%" title="${esc(c.text)}">${c.num}</a>`;
        })
        .join('');
      const comps = (f.components ?? []).map((c) => `<li>${esc(c.name)}${c.file ? ` <code>${esc(c.file)}</code>` : ''}${c.storyId ? ` <code>${esc(c.storyId)}</code>` : ''}</li>`).join('');
      return `<section class="frame" id="f-${slugs[f.id]}">
<h2>${esc(f.name)} <span class="dim">${Math.round(f.w)} × ${Math.round(f.h)}</span></h2>
<div class="art"><div class="shot" style="aspect-ratio:${Math.max(f.w, 1)} / ${Math.max(f.h, 1)};max-width:${Math.ceil(f.w)}px"><img alt="${esc(f.name)}" src="data:image/svg+xml;base64,${Buffer.from(f.svg).toString('base64')}">${pins}</div></div>
<div class="specs">
${cs.length ? `<h3>Comments</h3><ul class="cl">${cs.map((p) => thread(byId.get(p.id)!)).join('')}</ul>` : ''}
${comps ? `<h3>Components</h3><ul>${comps}</ul>` : ''}
${f.css ? `<h3>CSS</h3><pre>${esc(f.css)}</pre>` : ''}
</div></section>`;
    })
    .join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(input.title)}</title>
<style>
:root{--bg:#f5f5f5;--card:#fff;--text:#111;--dim:#6b6b6b;--line:#e6e6e6;--pin:#111;--on-pin:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#1e1e1e;--card:#2c2c2c;--text:#f0f0f0;--dim:#a0a0a0;--line:#3a3a3a;--pin:#f0f0f0;--on-pin:#111}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 Inter,system-ui,-apple-system,sans-serif}
header{padding:20px 16px;border-bottom:1px solid var(--line);background:var(--card)}header h1{margin:0;font-size:18px}
nav{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}nav a{color:var(--text);font-size:12px;padding:2px 8px;border:1px solid var(--line);border-radius:6px;text-decoration:none}
main{max-width:1280px;margin:0 auto;padding:16px}
.frame{background:var(--card);border:1px solid var(--line);border-radius:10px;margin:0 0 20px;display:grid;grid-template-columns:minmax(0,1fr) 320px;overflow:hidden}
.frame h2{grid-column:1/-1;margin:0;padding:12px 16px;font-size:14px;border-bottom:1px solid var(--line)}
.dim{color:var(--dim);font-weight:400}.art{padding:16px;background:var(--bg);overflow:auto}
.shot{position:relative;width:100%}.shot img{display:block;width:100%;height:100%}
.pin{position:absolute;transform:translate(0,-100%);width:24px;height:24px;border-radius:12px 12px 12px 2px;background:var(--pin);color:var(--on-pin);font:600 11px/24px system-ui;text-align:center;text-decoration:none;box-shadow:0 1px 4px #0005}
.pin.done{opacity:.45}.specs{padding:12px 16px;border-left:1px solid var(--line);min-width:0}
h3{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--dim);margin:12px 0 6px}
ul{margin:0;padding-left:18px}.cl{list-style:none;padding:0}.c{display:flex;gap:8px;margin-bottom:10px}.c.done{opacity:.6}
.n{flex:none;width:20px;height:20px;border-radius:10px;background:var(--pin);color:var(--on-pin);font-size:10px;font-weight:600;display:grid;place-items:center}
.r{margin-top:4px;padding-left:8px;border-left:2px solid var(--line)}
pre{white-space:pre-wrap;word-break:break-word;font:12px/1.4 ui-monospace,Menlo,monospace;background:var(--bg);padding:8px;border-radius:6px;margin:0}
code{font:12px ui-monospace,Menlo,monospace}
@media (max-width:760px){.frame{grid-template-columns:1fr}.specs{border-left:0;border-top:1px solid var(--line)}}
</style></head><body>
<header><h1>${esc(input.title)}</h1><div class="dim">Design preview from Designer · ${esc(when)}${input.link ? ` · <a href="${esc(input.link)}">on the branch</a>` : ''}</div>
<nav>${input.frames.map((f) => `<a href="#f-${slugs[f.id]}">${esc(f.name)}</a>`).join('')}</nav></header>
<main>
${frames || '<p class="dim">The canvas has no frames yet.</p>'}
${loose.length ? `<section class="frame"><h2>Other comments</h2><div class="specs" style="grid-column:1/-1;border:0"><ul class="cl">${loose.map(thread).join('')}</ul></div></section>` : ''}
</main></body></html>
`;
}

/** Replaces the preview folder with a fresh build. Returns the files written, relative to the project. */
export async function writePreview(designerDir: string, files: Record<string, string>) {
  const dir = join(designerDir, 'preview');
  await mkdir(dir, { recursive: true });
  for (const f of await readdir(dir).catch(() => [] as string[])) if (!(f in files)) await rm(join(dir, f), { force: true, recursive: true });
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
  return { dir, files: Object.keys(files).map((f) => `${PREVIEW_DIR}/${f}`) };
}
