// Pure presentation of CLI-backed node metadata and context.
import { baseName, docKey } from '../core/paths';
import { CONTEXT_GROUPS, type ContextJson } from '../core/model';
import type { NodeTarget } from './nodeView';

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
type Mode = 'document' | 'implement';
export interface OverviewAction { command: string; args: unknown[] }
export interface OverviewContext { mode: Mode; value?: ContextJson; error?: string }

/** Only server-created actions are accepted; messages cannot supply commands or paths. */
export function renderOverview(target: NodeTarget, contexts: OverviewContext[], nonce: string, generation: number): { html: string; actions: OverviewAction[] } {
  const { p, node, doc } = target;
  const n = p.nodes.get(node)!;
  const type = p.typeOf(node);
  const actions: OverviewAction[] = [];
  const action = (label: string, command: string, args: unknown[], button = false, title = label) => {
    const id = actions.push({ command, args }) - 1;
    return button ? `<button data-action="${id}" title="${esc(title)}">${esc(label)}</button>` : `<a href="#" data-action="${id}" title="${esc(title)}">${esc(label)}</a>`;
  };
  const file = (path: string, section?: string | null, note?: string | null, baseline?: string | null, code = false) => {
    const command = note?.startsWith('diff since') && baseline ? 'uspec.diffFile' : code || path.endsWith('/') ? 'uspec.revealPath' : 'uspec.openSection';
    const args = command === 'uspec.diffFile' ? [p.root, path, baseline] : [p.root, path, section];
    return `${code ? '<span aria-label="Code" title="Code path">&lt;/&gt;</span> ' : ''}${action(baseName(path.replace(/\/$/, '')) + (section ? `#${section}` : ''), command, args, false, path + (section ? `#${section}` : ''))} <span class="secondary">${esc(path)}${note ? ` · ${esc(note)}` : ''}</span>`;
  };
  const nodeLink = (key: string) => `${action(key ? baseName(key) : p.rootLabel, 'uspec.revealNode', [p.root, key, true])} <span class="secondary">${esc(p.nodeDir(key))}</span>`;
  const list = (rows: string[], empty = 'None') => rows.length ? `<ul>${rows.map(r => `<li>${r}</li>`).join('')}</ul>` : `<p class="secondary">${empty}</p>`;
  const section = (name: string, rows: string[], empty = 'None', controls = '') => `<section><div class="section-heading"><h2>${name}</h2>${controls}</div>${list(rows, empty)}</section>`;
  const flag = (label: string, explanation: string) => `<span class="flag" title="${esc(explanation)}">${esc(label)}</span>`;
  const td = doc ? p.typeDoc(node, doc) : undefined;
  const template = doc ? `<div class="template"><h2>${td?.template ? action(`${doc}.md template`, 'uspec.openSection', [p.root, td.template]) : esc(`${doc}.md`)}</h2><p>${esc(td?.description ?? '')}</p>${td ? `${flag(td.required ? 'Required' : 'Optional', td.required ? 'Every node of this type must have this document' : 'This document may be omitted')}${flag(td.exposed ? 'Exposed' : 'Internal', td.exposed ? 'Available to nodes linking to this node' : 'Not exposed by links to this node')}${td.extra ? flag('Extra files', 'This document may have an extra files folder') : ''}<p>Derives from: ${td.derives_from.length ? td.derives_from.map(d => { const [id, anchor] = d.split('#'); return file(p.docFile(docKey(node, id)), anchor); }).join(', ') : 'None'}</p>` : '<p class="secondary">No template</p>'}</div>` : '';
  const change = p.activeChange;
  const states: string[] = [];
  if (change) {
    states.push(file(`.uspec/changes/${change.name}/change.md`));
    for (const d of change.docs.values()) {
      if (doc ? d.document !== docKey(node, doc) : !n.documents.some(id => docKey(node, id) === d.document)) continue;
      states.push(`${file(d.path)} ${flag(d.state.replace('-', ' '), d.reason ?? (d.via.join('; ') || ({ pending: 'Reached by an update; awaiting triage', affected: 'Must be updated', updated: 'Edited in this change', 'no-change': 'Reviewed; no change needed' }[d.state])))}`);
    }
    const impl = change.impl.get(node);
    if (impl) states.push(flag(impl === 'done' ? 'Implemented' : 'To implement', impl === 'done' ? 'Code updated and verified against the documents' : 'Code awaits implementation'));
    if (states.length === 1) states.push('<span class="secondary">None</span>');
  }
  const modes: Mode[] = [...(doc ? ['document' as const] : []), ...(p.hasCode(node) ? ['implement' as const] : [])];
  const controls = `<div class="actions">${modes.map(mode => {
    const label = mode === 'document' ? `${doc}.md` : 'implementation';
    return `<div><span class="secondary">${esc(label)}</span> ${['show', 'copy', 'copyWithContents'].map((verb, i) => action(['Show', 'Copy', 'Copy with contents'][i], `uspec.context.${verb}`, [{ kind: 'context', target: { ...target }, mode }], true, `${['Show', 'Copy', 'Copy with contents'][i]} ${label} context`)).join(' ')}</div>`;
  }).join('')}</div>`;
  const contextRows = modes.map(mode => {
    const result = contexts.find(c => c.mode === mode);
    const heading = `<h3>${esc(mode === 'document' ? `Document: ${doc}.md` : 'Implementation')}</h3>`;
    if (!result) return `${heading}<p role="status">Loading context…</p>`;
    if (result.error) return `${heading}<p class="error" role="alert">⚠ ${esc(result.error)}</p>`;
    const ctx = result.value!;
    return `${heading}<h4>Instructions · ${esc(ctx.instructions.type)}</h4>${ctx.instructions.text ? `<pre>${esc(ctx.instructions.text)}</pre>` : '<p class="secondary">None</p>'}${CONTEXT_GROUPS.filter(g => ctx.files[g]).map(g => `<h4>${esc(g)}</h4>${list(ctx.files[g].map(f => file(f.path, f.section, f.note, ctx.baseline, g === 'code')))}`).join('')}`;
  });
  const html = `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'"><style nonce="${nonce}">
*{box-sizing:border-box}body{margin:0;padding:20px;max-width:1000px;font-family:var(--vscode-editor-font-family,var(--vscode-font-family));font-size:var(--vscode-editor-font-size,var(--vscode-font-size));line-height:1.5;color:var(--vscode-editor-foreground);background:var(--vscode-editor-background)}h1{font-size:20px;margin:0 0 4px}h2{font-size:14px;margin:0}h3{font-size:13px;margin:8px 0}h4{font-size:12px;margin:8px 0 2px}p{margin:6px 0}section{border-top:1px solid var(--vscode-panel-border);padding-top:12px;margin-top:16px}.section-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;min-width:0}.section-heading>*{min-width:0}.secondary{color:var(--vscode-descriptionForeground);font-size:12px}ul{list-style:none;padding:0;margin:4px 0}li{padding:4px 0}li,a,p,pre,h1,.secondary{overflow-wrap:anywhere}pre{white-space:pre-wrap;font-family:var(--vscode-editor-font-family)}.flag{display:inline-block;font-size:12px;padding:0 6px;margin:2px 4px 2px 0;border:1px solid var(--vscode-panel-border);border-radius:3px}a{color:var(--vscode-textLink-foreground);text-decoration:none}a:hover{text-decoration:underline}button{font:inherit;font-size:12px;cursor:pointer;color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground);border:1px solid var(--vscode-button-border,transparent);padding:3px 7px;margin:2px}button:hover{background:var(--vscode-button-secondaryHoverBackground)}:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:2px}.warning{color:var(--vscode-list-warningForeground)}.error{color:var(--vscode-errorForeground)}.template{margin-top:16px}.actions{text-align:right}@media(max-width:600px){body{padding:12px}.section-heading{align-items:flex-start;flex-direction:column}.actions{text-align:left}.secondary{white-space:normal}}body.vscode-high-contrast section,body.vscode-high-contrast-light section,.vscode-high-contrast .flag,.vscode-high-contrast-light .flag{border-color:var(--vscode-contrastBorder)}
</style></head><body><header><h1>${esc(node ? baseName(node) : p.rootLabel)}</h1><div class="secondary">${esc(p.nodeDir(node))}</div><div class="flag">${type ? action(type.name, 'uspec.openSection', [p.root, type.path], false, type.type) : esc(n.type ?? 'Unknown type')}</div><p>${esc(type?.description ?? '')}</p></header>${template}
${section('Upstream', n.deps.map(d => d.doc ? file(p.docFile(docKey(d.node, d.doc)), d.section) : nodeLink(d.node)))}
${section('Downstream', (p.downstream.get(node) ?? []).map(nodeLink))}
${section('Code paths', n.code.map(c => file(c, null, null, null, true)))}
${section('Active change', states, 'No active change')}
${section('Drift', p.drift.has(node) ? [`<span class="warning">⚠ Drift: ${esc(p.drift.get(node)!)}</span>`] : [])}
${section('Context', contextRows, 'None', controls)}
${section('Documents', n.documents.map(d => file(p.docFile(docKey(node, d)))))}
${section('Problems', p.nodeIssues(node).map(i => `<span class="error">✕ ${esc(i.message)}</span>`))}
<script nonce="${nonce}">const v=acquireVsCodeApi();document.addEventListener('click',e=>{const a=e.target.closest('[data-action]');if(a){e.preventDefault();v.postMessage({generation:${generation},action:Number(a.dataset.action)})}});</script></body></html>`;
  return { html, actions };
}

