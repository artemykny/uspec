// Read-only documents the extension shows: a file at a change's baseline, `uspec context` output,
// agent run logs and the content a writer started from.
import { execFile } from 'child_process';
import * as vscode from 'vscode';

export const SCHEME = 'uspec';

/** Serves `uspec:` documents. The URI's authority says what it is; the path is only for the title. */
export class ContentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;
  private readonly texts = new Map<string, () => string>();
  private readonly registration = vscode.workspace.registerTextDocumentContentProvider(SCHEME, this);
  private readonly pending = new Map<string, NodeJS.Timeout>();

  dispose(): void {
    this.registration.dispose();
    this.emitter.dispose();
  }

  /** A document whose text comes from `text`, updated when `changed` is called. */
  register(kind: string, id: string, title: string, text: () => string): vscode.Uri {
    const uri = vscode.Uri.from({ scheme: SCHEME, authority: kind, path: `/${id}/${title}` });
    this.texts.set(uri.toString(), text);
    return uri;
  }

  /** Tells open editors that a document's text changed, at most twice a second. */
  changed(uri: vscode.Uri): void {
    const key = uri.toString();
    if (this.pending.has(key)) return;
    this.pending.set(
      key,
      setTimeout(() => {
        this.pending.delete(key);
        this.emitter.fire(uri);
      }, 500),
    );
  }

  /** A file as it was at a commit: `git show <rev>:./<path>` in the project root. Empty if it didn't exist. */
  atRevision(root: string, rev: string, rel: string): vscode.Uri {
    return vscode.Uri.from({ scheme: SCHEME, authority: 'git', path: `/${rel}`, query: JSON.stringify({ root, rev }) });
  }

  provideTextDocumentContent(uri: vscode.Uri): string | Thenable<string> {
    if (uri.authority === 'git') {
      const { root, rev } = JSON.parse(uri.query) as { root: string; rev: string };
      const rel = uri.path.slice(1);
      return new Promise((resolve) => {
        execFile('git', ['show', `${rev}:./${rel}`], { cwd: root, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => resolve(err ? '' : stdout));
      });
    }
    return this.texts.get(uri.toString())?.() ?? '';
  }
}
