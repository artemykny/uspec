import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';
import { runInNewContext } from 'vm';
import type { NodeTarget, NodeViewProvider } from '../../views/nodeView';
import type { ContextJson } from '../../core/model';

// Load the compiled controller with only the VS Code UI boundary replaced.
function harness() {
  let changed = () => {};
  let message = (_: unknown) => {};
  let disposed = () => {};
  const calls: unknown[][] = [];
  const created: unknown[][] = [];
  const panel = {
    title: '', webview: { html: '', onDidReceiveMessage: (fn: typeof message) => {
      message = fn; return { dispose() { message = () => {}; } };
    } },
    onDidDispose: (fn: () => void) => { disposed = fn; },
    reveal() {}, dispose: () => disposed(),
  };
  const vscode = {
    ViewColumn: { Active: -1, Beside: -2 }, window: { createWebviewPanel: (...args: unknown[]) => { created.push(args); return panel; } },
    commands: { executeCommand: (...args: unknown[]) => calls.push(args) },
  };
  const filename = path.resolve(__dirname, '../../views/nodeWindow.js');
  const localRequire = createRequire(filename);
  const exports: Record<string, any> = {};
  runInNewContext('(function(require, exports) {' + fs.readFileSync(filename, 'utf8') + '\n})', {})(
    (name: string) => name === 'vscode' ? vscode : localRequire(name), exports,
  );
  const p = {
    root: '/project', rootLabel: 'docs', nodes: new Map([['payments', { documents: ['logic'], deps: [], code: ['payments/'] }]]),
    typeOf: () => undefined, typeDoc: () => undefined, nodeDir: (node: string) => `docs/${node}`, hasCode: () => true,
    downstream: new Map(), nodeDrift: new Map(), docDrift: new Map(), nodeIssues: () => [],
  };
  const target = { p, node: 'payments' } as unknown as NodeTarget;
  const pending: ((ctx: ContextJson) => void)[] = [];
  const requested: string[] = [];
  const view = {
    target: undefined as NodeTarget | undefined,
    setTarget(t: NodeTarget | undefined) { this.target = t; changed(); },
    onDidChangeTreeData(fn: () => void) { changed = fn; return { dispose() { changed = () => {}; } }; },
    context: (mode: string) => { requested.push(mode); return new Promise<ContextJson>(resolve => pending.push(resolve)); },
  };
  const window: import('../../views/nodeWindow').NodeWindow = new exports.NodeWindow(view as unknown as NodeViewProvider);
  const version = () => Number(panel.webview.html.match(/generation:(\d+)/)?.[1]);
  return { window, view, target, panel, pending, requested, calls, created, version, message: (m: unknown) => message(m) };
}
const context: ContextJson = {
  node: 'payments', type: 'service', documents: [], baseline: null,
  instructions: { type: 'Service', text: null },
  files: { upstream: [{ path: 'docs/api.md', section: null, note: null }] },
};
const settle = () => new Promise(resolve => setImmediate(resolve));

describe('overview lifecycle', () => {
  it('opens beside the editor and rejects clicks from the loading page after context changes the action table', async () => {
    const h = harness();
    try {
      h.window.show(h.target);
      assert.deepStrictEqual({ ...(h.created[0][2] as object) }, { viewColumn: -2, preserveFocus: true });
      const loadingVersion = h.version();
      h.pending[0](context);
      await settle();
      assert.notStrictEqual(h.version(), loadingVersion);
      h.message({ generation: loadingVersion, action: 0 });
      assert.strictEqual(h.calls.length, 0);
      h.message({ generation: h.version(), action: 0 });
      assert.strictEqual(h.calls.length, 1);
      assert.strictEqual(h.calls[0][0], 'uspec.revealPath');
    } finally { h.window.dispose(); }
  });

  it('switches between the offered context modes, requesting only the selected one', async () => {
    const h = harness();
    try {
      h.window.show({ ...h.target, doc: 'logic' });
      assert.deepStrictEqual(h.requested, ['document']);
      assert.match(h.panel.webview.html, /data-mode="document" aria-pressed="true"/);
      h.message({ generation: h.version(), mode: 'bogus' });
      h.message({ generation: h.version() - 1, mode: 'implement' });
      assert.deepStrictEqual(h.requested, ['document']);
      h.message({ generation: h.version(), mode: 'implement' });
      assert.deepStrictEqual(h.requested, ['document', 'implement']);
      assert.match(h.panel.webview.html, /data-mode="implement" aria-pressed="true"/);
      assert.strictEqual(h.calls.length, 0);
      h.pending[0](context);
      await settle();
      assert.match(h.panel.webview.html, /role="status">Loading context/, 'a stale response of the other mode is ignored');
      h.pending[1](context);
      await settle();
      assert.match(h.panel.webview.html, /Instructions · Service/);
      const copy = h.calls.length;
      h.view.setTarget({ ...h.target });
      assert.deepStrictEqual(h.requested.slice(2), ['implement']);
      h.message({ generation: h.version(), mode: 'document' });
      assert.deepStrictEqual(h.requested.slice(2), ['implement'], 'a mode not offered is ignored');
      assert.strictEqual(h.calls.length, copy);
    } finally { h.window.dispose(); }
  });

  it('ignores pending responses after clearing a target or disposing the panel', async () => {
    const h = harness();
    h.window.show(h.target);
    const version = h.version();
    h.view.setTarget(undefined);
    h.pending[0](context);
    await settle();
    assert.match(h.panel.webview.html, /No node selected/);
    h.message({ generation: version, action: 0 });
    assert.strictEqual(h.calls.length, 0);
    h.window.show(h.target);
    const html = h.panel.webview.html;
    h.window.dispose();
    h.pending.at(-1)!(context);
    await settle();
    assert.strictEqual(h.panel.webview.html, html);
    assert.strictEqual(h.window.currentPanel, undefined);
  });
});
