// Pure presentation of CLI-backed node metadata and context (docs/vscode/overview.md#views, Node overview).
import { baseName, docKey } from '../core/paths';
import { CONTEXT_GROUPS, type ContextJson } from '../core/model';
import type { NodeTarget } from './nodeView';

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
export type Mode = 'document' | 'implement';
export interface OverviewAction { command: string; args: unknown[] }
export interface OverviewContext { mode: Mode; value?: ContextJson; error?: string }

/** The contexts the overview offers: writing the current document, and implementing a node with code paths. */
export function contextModes(t: NodeTarget): Mode[] {
  return [...(t.doc ? ['document' as const] : []), ...(t.p.hasCode(t.node) ? ['implement' as const] : [])];
}

const STATE_MEANING: Record<string, string> = {
  pending: 'Reached by an update; awaiting triage',
  affected: 'Must be updated in this change',
  updated: 'Edited in this change',
  'no-change': 'Reviewed; no change needed',
};
const MODE_LABEL: Record<Mode, string> = { document: 'Write', implement: 'Implement' };
const DRIFT_MEANING: Record<'dependency' | 'code' | 'spec', string> = {
  code: 'The code changed since it was last verified against its spec',
  spec: 'The spec changed since its code was last verified',
  dependency: 'What the document depends on changed since it was last checked',
};
const driftMeaning = (kind: 'dependency' | 'code' | 'spec', reason: string) => reason === 'never checked' ? 'Never checked: nothing records what it was last checked against' : DRIFT_MEANING[kind];

/** Only server-created actions are accepted; messages cannot supply commands or paths. */
export function renderOverview(target: NodeTarget, mode: Mode | undefined, context: OverviewContext | undefined, nonce: string, generation: number): { html: string; actions: OverviewAction[] } {
  const { p, node, doc } = target;
  const n = p.nodes.get(node)!;
  const type = p.typeOf(node);
  const actions: OverviewAction[] = [];
  const action = (label: string, command: string, args: unknown[], button = false, title = label) => {
    const id = actions.push({ command, args }) - 1;
    return button ? `<button data-action="${id}" title="${esc(title)}">${esc(label)}</button>` : `<a href="#" data-action="${id}" title="${esc(title)}">${esc(label)}</a>`;
  };
  const label = (text: string, meaning: string) => `<span class="label" title="${esc(meaning)}">${esc(text)}</span>`;
  const secondary = (text: string, title = text) => `<span class="secondary" title="${esc(title)}">${esc(text)}</span>`;
  const row = (...parts: string[]) => `<div class="row">${parts.filter(Boolean).join(' ')}</div>`;
  const file = (path: string, section?: string | null, note?: string | null, baseline?: string | null, code = false) => {
    const command = note?.startsWith('diff since') && baseline ? 'uspec.diffFile' : code || path.endsWith('/') ? 'uspec.revealPath' : 'uspec.openSection';
    const args = command === 'uspec.diffFile' ? [p.root, path, baseline] : command === 'uspec.revealPath' ? [p.root, path] : [p.root, path, section];
    const full = path + (section ? `#${section}` : '');
    return row(
      code ? '<span aria-label="Code" title="Code path">&lt;/&gt;</span>' : '',
      action(baseName(path.replace(/\/$/, '')) + (section ? `#${section}` : ''), command, args, false, full),
      secondary(path + (note ? ` · ${note}` : ''), full + (note ? ` · ${note}` : '')),
    );
  };
  const name = (key: string) => key ? baseName(key) : p.rootLabel;
  const narrows = (l: { doc?: string; section?: string }) => l.doc ? `${l.doc}.md${l.section ? ` #${l.section}` : ''}` : 'whole node';
  const list = (rows: string[], empty = 'None') => rows.length ? `<ul>${rows.map(r => `<li>${r}</li>`).join('')}</ul>` : `<p class="secondary">${esc(empty)}</p>`;
  const section = (title: string, body: string, controls = '') => `<section aria-labelledby="h-${title.replace(/\W/g, '')}"><div class="section-heading"><h2 id="h-${title.replace(/\W/g, '')}">${esc(title)}</h2>${controls ? `<div class="actions">${controls}</div>` : ''}</div>${body}</section>`;

  // Header
  const issues = p.nodeIssues(node).length;
  const header = `<header><div class="title"><h1>${esc(name(node))}</h1>${type ? label(type.name, type.type) : label(n.type ?? 'Unknown type', n.type ? 'Unknown type' : 'No type')}${issues ? action(`${issues} problem${issues === 1 ? '' : 's'}`, 'workbench.actions.view.problems', [], true, 'Show the validation errors in the Problems panel') : ''}</div>${secondary(p.nodeDir(node))}</header>`;

  // About
  const td = doc ? p.typeDoc(node, doc) : undefined;
  const flags = td ? [
    td.required ? label('required', 'Every node of this type must have this document') : label('optional', 'Nodes of this type may omit this document'),
    td.exposed ? label('exposed', 'Nodes that link to this node can read this document') : label('internal', 'Not readable through links to this node'),
    td.extra ? label('extra', 'This document may have an -extra/ folder of further files') : '',
    td.derives_from.length ? label(`derives from ${td.derives_from.join(', ')}`, 'The documents this document is written from') : '',
  ].filter(Boolean).join(' ') : '';
  const about = `${type?.description ? `<p>${esc(type.description)}</p>` : '<p class="secondary">None</p>'}${doc ? `<div class="document"><h3>${td?.template ? action(`${doc}.md`, 'uspec.openSection', [p.root, td.template], false, `Open the template of ${doc}.md`) : esc(`${doc}.md`)}</h3>${td ? `${td.description ? `<p>${esc(td.description)}</p>` : ''}<div class="labels">${flags}</div>` : '<p class="secondary">No template</p>'}</div>` : ''}`;

  // Upstream and Downstream
  const upstream = n.deps.map(l => {
    const link = l.doc
      ? action(name(l.node), 'uspec.openSection', [p.root, p.docFile(docKey(l.node, l.doc)), ...(l.section ? [l.section] : [])], false, p.docFile(docKey(l.node, l.doc)) + (l.section ? `#${l.section}` : ''))
      : action(name(l.node), 'uspec.showOverview', [p.root, l.node], false, p.nodeDir(l.node));
    return row(link, secondary(narrows(l)));
  });
  const downstream = (p.downstream.get(node) ?? []).map(d => {
    const links = p.nodes.get(d)?.deps.filter(l => l.node === node) ?? [];
    return row(action(name(d), 'uspec.showOverview', [p.root, d], false, p.nodeDir(d)), secondary(links.map(narrows).join(', ')));
  });

  // Code paths
  const code = p.hasCode(node) ? list(n.code.map(c => file(c, null, null, null, true))) : '<p class="secondary">No code</p>';

  // Active change
  const change = p.activeChange;
  let changeBody = '<p class="secondary">No active change</p>';
  if (change) {
    const docs = n.documents.flatMap(id => [...change.docs.values()].filter(d => d.document === docKey(node, id)));
    const rows = docs.map(d => {
      const why = d.reason ?? (d.via.length ? `via ${d.via.join('; ')}` : '');
      return `${file(d.path)}${row(label(d.state, `${STATE_MEANING[d.state] ?? d.state}${why ? `: ${why}` : ''}`), why ? secondary(why) : '')}`;
    });
    const impl = change.impl.get(node);
    if (impl) rows.push(row('Implementation', impl === 'done' ? label('done', 'Code updated and verified against the documents') : label('pending', 'Code awaits implementation')));
    changeBody = `<p>${action(change.name, 'uspec.openSection', [p.root, `.uspec/changes/${change.name}/change.md`], false, `.uspec/changes/${change.name}/change.md`)}</p>${rows.length ? list(rows) : '<p class="secondary">Not in this change</p>'}`;
  }

  // Drift: the node, then its documents in its type's order, each with every reason and Accept drift
  const driftItems = [
    ...(p.nodeDrift.get(node) ? [{ doc: undefined as string | undefined, reasons: p.nodeDrift.get(node)! }] : []),
    ...n.documents.flatMap(d => p.docDrift.get(docKey(node, d)) ? [{ doc: d as string | undefined, reasons: p.docDrift.get(docKey(node, d))! }] : []),
  ];
  const driftRows = driftItems.map(({ doc: d, reasons }) => {
    const accept = d
      ? action('Accept drift', 'uspec.drift.accept', [{ p, node, doc: d }], true, `Record ${d}.md as checked against what it depends on, as they are now, without a change`)
      : action('Accept drift', 'uspec.drift.accept', [{ p, node }], true, `Record the code of ${name(node)} as verified against its spec, as both are now, without a change`);
    return row(`<span>${esc(d ? `${d}.md` : name(node))}</span>`, accept) + reasons.map(r => `<p class="warning">${label('⚠ drift', driftMeaning(d ? 'dependency' : r.startsWith('spec ') ? 'spec' : 'code', r))} ${esc(r)}</p>`).join('');
  });
  const driftBody = list(driftRows);

  // Context
  const modes = contextModes(target);
  const mode0 = mode && modes.includes(mode) ? mode : modes[0];
  const modeTitle = (m: Mode) => m === 'document' ? `The context of writing ${doc}.md` : 'The context of implementing this node';
  let controls = '';
  let contextBody: string;
  if (!mode0) contextBody = '<p class="secondary">This node has no code paths. Open one of its documents to see the context of writing it.</p>';
  else {
    const which = modes.length > 1
      ? `<div class="switch" role="group" aria-label="Context">${modes.map(m => `<button data-mode="${m}" aria-pressed="${m === mode0}" title="${esc(modeTitle(m))}">${MODE_LABEL[m]}</button>`).join('')}</div>`
      : label(MODE_LABEL[mode0], modeTitle(mode0));
    const job = { kind: 'context', target: { ...target }, mode: mode0 };
    controls = `${which} ${action('Copy context', 'uspec.context.copy', [job], true, 'Copy the CLI output')} ${action('Copy with contents', 'uspec.context.copyWithContents', [job], true, 'Copy the CLI output followed by every listed file and diff')}`;
    if (!context || context.mode !== mode0) contextBody = '<p role="status">Loading context…</p>';
    else if (context.error) contextBody = `<p class="error" role="alert">⚠ ${esc(context.error)}</p>`;
    else {
      const ctx = context.value!;
      contextBody = `<h3>Instructions · ${esc(ctx.instructions.type)}</h3>${ctx.instructions.text ? `<pre>${esc(ctx.instructions.text)}</pre>` : '<p class="secondary">None</p>'}${CONTEXT_GROUPS.filter(g => ctx.files[g]?.length).map(g => `<h3>${esc(g)}</h3>${list(ctx.files[g].map(f => file(f.path, f.section, f.note, ctx.baseline, g === 'code')))}`).join('')}`;
    }
  }

  const html = `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'"><style nonce="${nonce}">
*{box-sizing:border-box}body{margin:0;padding:20px;max-width:900px;font-family:var(--vscode-editor-font-family,var(--vscode-font-family));font-size:var(--vscode-editor-font-size,var(--vscode-font-size));line-height:1.5;color:var(--vscode-editor-foreground);background:var(--vscode-editor-background)}
h1{font-size:20px;margin:0}h2{font-size:13px;font-weight:600;margin:0}h3{font-size:12px;font-weight:600;margin:10px 0 2px}p{margin:4px 0}
header .title{display:flex;align-items:center;flex-wrap:wrap;gap:8px}section{border-top:1px solid var(--vscode-panel-border);padding:12px 0;margin-top:12px}
.section-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;min-width:0;margin-bottom:4px}.section-heading>*{min-width:0}.actions{display:flex;align-items:center;flex-wrap:wrap;gap:4px}
.secondary{color:var(--vscode-descriptionForeground);font-size:12px}ul{list-style:none;padding:0;margin:0}li{padding:2px 0}
.row{display:flex;align-items:baseline;gap:8px;min-width:0}.row>*{flex:none}.row>.secondary{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:4px 0;font-family:var(--vscode-editor-font-family)}
.label{display:inline-block;font-size:11px;line-height:16px;padding:0 6px;margin:2px 4px 2px 0;border:1px solid var(--vscode-panel-border);border-radius:3px;color:var(--vscode-descriptionForeground)}
a{color:var(--vscode-textLink-foreground);text-decoration:none}a:hover{text-decoration:underline}
button{font:inherit;font-size:12px;cursor:pointer;color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground);border:1px solid var(--vscode-button-border,transparent);border-radius:2px;padding:2px 8px}button:hover{background:var(--vscode-button-secondaryHoverBackground)}
.switch{display:inline-flex}.switch button{margin:0}.switch button[aria-pressed="true"]{color:var(--vscode-button-foreground);background:var(--vscode-button-background)}
:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:2px}.warning{color:var(--vscode-list-warningForeground)}.error{color:var(--vscode-errorForeground)}
body.vscode-high-contrast section,body.vscode-high-contrast-light section,body.vscode-high-contrast .label,body.vscode-high-contrast-light .label,body.vscode-high-contrast button,body.vscode-high-contrast-light button{border-color:var(--vscode-contrastBorder)}
@media(max-width:600px){body{padding:12px}.section-heading{align-items:flex-start;flex-direction:column}.row{flex-wrap:wrap}.row>.secondary{white-space:normal;overflow-wrap:anywhere}.label{white-space:normal;overflow-wrap:anywhere}}
</style></head><body>${header}
${section('About', about)}
${section('Upstream', list(upstream))}
${section('Downstream', list(downstream))}
${section('Code paths', code)}
${section('Active change', changeBody)}
${section('Drift', driftBody)}
${section('Context', contextBody, controls)}
<script nonce="${nonce}">const v=acquireVsCodeApi();document.addEventListener('click',e=>{const a=e.target.closest('[data-action],[data-mode]');if(!a)return;e.preventDefault();if(a.dataset.mode)v.postMessage({generation:${generation},mode:a.dataset.mode});else v.postMessage({generation:${generation},action:Number(a.dataset.action)})});</script></body></html>`;
  return { html, actions };
}
