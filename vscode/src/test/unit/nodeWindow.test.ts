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
  const panel = {
    title: '', webview: { html: '', onDidReceiveMessage: (fn: typeof message) => {
      message = fn; return { dispose() { message = () => {}; } };
    } },
    onDidDispose: (fn: () => void) => { disposed = fn; },
    reveal() {}, dispose: () => disposed(),
  };
  const vscode = {
    ViewColumn: { Active: -1 }, window: { createWebviewPanel: () => panel },
    commands: { executeCommand: (...args: unknown[]) => calls.push(args) },
  };
  const filename = path.resolve(__dirname, '../../views/nodeWindow.js');
  const localRequire = createRequire(filename);
  const exports: Record<string, any> = {};
  runInNewContext('(function(require, exports) {' + fs.readFileSync(filename, 'utf8') + '\n})', {})(
    (name: string) => name === 'vscode' ? vscode : localRequire(name), exports,
  );
  const p = {
    root: '/project', rootLabel: 'docs', nodes: new Map([['payments', { documents: [], deps: [], code: ['payments/'] }]]),
    typeOf: () => undefined, nodeDir: (node: string) => `docs/${node}`, hasCode: () => true,
    downstream: new Map(), drift: new Map(), nodeIssues: () => [],
  };
  const target = { p, node: 'payments' } as unknown as NodeTarget;
  const pending: ((ctx: ContextJson) => void)[] = [];
  const view = {
    target: undefined as NodeTarget | undefined,
    setTarget(t: NodeTarget | undefined) { this.target = t; changed(); },
    onDidChangeTreeData(fn: () => void) { changed = fn; return { dispose() { changed = () => {}; } }; },
    context: () => new Promise<ContextJson>(resolve => pending.push(resolve)),
  };
  const window: import('../../views/nodeWindow').NodeWindow = new exports.NodeWindow(view as unknown as NodeViewProvider);
  const version = () => Number(panel.webview.html.match(/generation:(\d+)/)?.[1]);
  return { window, view, target, panel, pending, calls, version, message: (m: unknown) => message(m) };
}
const context: ContextJson = {
  node: 'payments', type: 'service', documents: [], baseline: null,
  instructions: { type: 'Service', text: null },
  files: { upstream: [{ path: 'docs/api.md', section: null, note: null }] },
};
const settle = () => new Promise(resolve => setImmediate(resolve));

describe('overview lifecycle', () => {
  it('rejects clicks from the loading page after context changes the action table', async () => {
    const h = harness();
    try {
      h.window.show(h.target);
      const loadingVersion = h.version();
      h.pending[0](context);
      await settle();
      assert.notStrictEqual(h.version(), loadingVersion);
      h.message({ generation: loadingVersion, action: 0 });
      assert.strictEqual(h.calls.length, 0);
      h.message({ generation: h.version(), action: 0 });
      assert.strictEqual(h.calls.length, 1);
      assert.strictEqual(h.calls[0][0], 'uspec.context.show');
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
