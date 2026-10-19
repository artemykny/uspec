import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import type { Project } from '../projects';
import { showNode } from '../core/paths';

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** A node's overview lives alongside its documents in the editor, with the tree still visible. */
export class NodeWindow implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private links: vscode.Uri[] = [];
  dispose(): void { this.panel?.dispose(); }
  show(p: Project, node: string): void {
    const n = p.nodes.get(node);
    if (!n) return;
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel('uspec.nodeOverview', showNode(node), vscode.ViewColumn.Active, { enableScripts: true });
      this.panel.onDidDispose(() => { this.panel = undefined; });
      this.panel.webview.onDidReceiveMessage(m => {
        if (Number.isInteger(m.open) && this.links[m.open]) void vscode.commands.executeCommand('vscode.open', this.links[m.open]);
      });
    }
    this.links = [];
    const link = (label: string, file: string) => { const index = this.links.push(p.uriOf(file)) - 1; return `<a href="#" data-open="${index}">${esc(label)}</a>`; };
    const t = p.typeOf(node), nonce = randomBytes(16).toString('base64');
    const row = (title: string, items: string[]) => items.length ? `<section><h2>${title}<span>${items.length}</span></h2><ul>${items.map(s => `<li>${s}</li>`).join('')}</ul></section>` : '';
    this.panel.title = `${showNode(node)} · overview`;
    this.panel.webview.html = `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'"><style nonce="${nonce}">
*{box-sizing:border-box}body{margin:0;font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);line-height:1.5;color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:16px 20px;max-width:960px}h1{font-size:16px;font-weight:600;margin:0 0 4px;overflow-wrap:anywhere}h2{display:flex;align-items:center;gap:8px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.3px;margin:0;padding:6px 10px;background:var(--vscode-sideBarSectionHeader-background);color:var(--vscode-sideBarSectionHeader-foreground)}h2 span{font-weight:normal;color:var(--vscode-descriptionForeground);letter-spacing:0}section{border:1px solid var(--vscode-panel-border);margin-top:12px}ul{list-style:none;padding:0;margin:0}li{min-height:30px;padding:5px 10px;overflow-wrap:anywhere}li:hover{background:var(--vscode-list-hoverBackground)}li a{display:block;color:var(--vscode-foreground);text-decoration:none}li a:hover{color:var(--vscode-textLink-foreground)}a{color:var(--vscode-textLink-foreground);text-decoration:none}a:hover{text-decoration:underline}p{color:var(--vscode-descriptionForeground);margin:4px 0 10px;font-size:12px}p:empty{display:none}:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:2px}@media(max-width:600px){body{padding:12px}}body.vscode-high-contrast section,body.vscode-high-contrast-light section{border-color:var(--vscode-contrastBorder)}
</style></head><body><h1>${esc(showNode(node))}</h1><p>${t ? link(t.name, t.path) : esc(n.type ?? '')}</p><p>${esc(t?.description ?? '')}</p>
${row('Documents', n.documents.map(d => link(`${d}.md`, p.docFile(`${node ? node + '/' : ''}${d}.md`))))}
${row('Derives from', n.deps.map(d => link(d.raw, d.doc ? p.docFile(`${d.node ? d.node + '/' : ''}${d.doc}.md`) : `${p.nodeDir(d.node)}/node.yaml`)))}
${row('Used by', (p.downstream.get(node) ?? []).map(d => link(showNode(d), `${p.nodeDir(d)}/node.yaml`)))}
${row('Code', n.code.map(c => link(c, c)))}
${row('Problems', p.nodeIssues(node).map(i => esc(i.message)))}
<script nonce="${nonce}">const v=acquireVsCodeApi();document.addEventListener('click',e=>{const a=e.target.closest('[data-open]');if(a){e.preventDefault();v.postMessage({open:Number(a.dataset.open)})}});</script></body></html>`;
    this.panel.reveal(undefined, true);
  }
}
