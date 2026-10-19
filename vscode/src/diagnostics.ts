// Problems: `uspec validate` errors, drift, and template guidance left in documents
// (docs/vscode/overview.md#editing).
import * as fs from 'fs';
import * as vscode from 'vscode';
import { locateIssue } from './core/issues';
import { isUnwritten, leftoverGuidance } from './core/templates';
import { readTextSync, type Project, type ProjectManager } from './projects';

export class Diagnostics implements vscode.Disposable {
  private readonly validate = vscode.languages.createDiagnosticCollection('uspec');
  private readonly drift = vscode.languages.createDiagnosticCollection('uspec-drift');
  private readonly hints = vscode.languages.createDiagnosticCollection('uspec-template');
  private readonly byProject = new Map<string, { validate: vscode.Uri[]; drift: vscode.Uri[] }>();
  private readonly disposables: vscode.Disposable[];

  constructor(private readonly manager: ProjectManager) {
    this.disposables = [
      this.validate,
      this.drift,
      this.hints,
      manager.onDidChange((p) => (p ? this.update(p) : manager.projects.forEach((x) => this.update(x)))),
      vscode.workspace.onDidOpenTextDocument((d) => this.updateHints(d)),
      vscode.workspace.onDidChangeTextDocument((e) => this.updateHints(e.document)),
      vscode.workspace.onDidCloseTextDocument((d) => this.hints.delete(d.uri)),
    ];
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }

  private update(p: Project): void {
    const old = this.byProject.get(p.root);
    for (const u of old?.validate ?? []) this.validate.delete(u);
    for (const u of old?.drift ?? []) this.drift.delete(u);

    const files = new Map<string, vscode.Diagnostic[]>();
    const add = (rel: string, d: vscode.Diagnostic) => files.set(rel, [...(files.get(rel) ?? []), d]);
    const ctx = {
      specRoot: p.specRoot,
      read: (rel: string) => readTextSync(p.abs(rel)),
      isDir: (rel: string) => {
        try {
          return fs.statSync(p.abs(rel)).isDirectory();
        } catch {
          return false;
        }
      },
    };
    for (const issue of p.issues) {
      for (const at of locateIssue(issue, ctx)) {
        const d = new vscode.Diagnostic(new vscode.Range(at.line, at.start, at.line, Math.max(at.end, at.start)), at.message, vscode.DiagnosticSeverity.Error);
        d.source = 'uspec';
        add(at.file, d);
      }
    }
    const validateUris: vscode.Uri[] = [];
    for (const [rel, ds] of files) {
      const uri = p.uriOf(rel);
      this.validate.set(uri, ds);
      validateUris.push(uri);
    }

    const driftUris: vscode.Uri[] = [];
    for (const [node, reason] of p.drift) {
      const uri = p.uriOf(p.nodeYaml(node));
      const d = new vscode.Diagnostic(new vscode.Range(0, 0, 0, 0), `drift: ${reason}`, vscode.DiagnosticSeverity.Warning);
      d.source = 'uspec drift';
      this.drift.set(uri, [d]);
      driftUris.push(uri);
    }
    this.byProject.set(p.root, { validate: validateUris, drift: driftUris });

    for (const doc of vscode.workspace.textDocuments) if (p.contains(doc.uri.fsPath)) this.updateHints(doc);
  }

  /** Lines of template guidance still in an open spec document. */
  private updateHints(doc: vscode.TextDocument): void {
    if (doc.uri.scheme !== 'file' || doc.languageId !== 'markdown') return;
    if (!vscode.workspace.getConfiguration('uspec').get('templateHints', true)) {
      this.hints.delete(doc.uri);
      return;
    }
    const p = this.manager.projectFor(doc.uri);
    const t = p?.target(doc.uri.fsPath);
    if (!p || !t || t.spec?.kind !== 'doc' || !t.doc) return;
    const type = p.nodes.get(t.node)?.type;
    const body = type ? p.templateBodies.get(`${type}/${t.doc}`) : undefined;
    if (body === undefined) return;
    const text = doc.getText();
    if (text.trim() !== '' && isUnwritten(text, body)) {
      const d = new vscode.Diagnostic(new vscode.Range(0, 0, 0, doc.lineAt(0).text.length), 'Not written yet: this is still the template.', vscode.DiagnosticSeverity.Information);
      d.source = 'uspec';
      this.hints.set(doc.uri, [d]);
      return;
    }
    this.hints.set(
      doc.uri,
      leftoverGuidance(text, body).map((line) => {
        const l = doc.lineAt(line);
        const d = new vscode.Diagnostic(
          new vscode.Range(line, l.firstNonWhitespaceCharacterIndex, line, l.text.length),
          'Template guidance: replace it with the document’s content.',
          vscode.DiagnosticSeverity.Information,
        );
        d.source = 'uspec';
        return d;
      }),
    );
  }
}
