import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';
import { runInNewContext } from 'vm';
import type { NodeViewProvider } from '../../views/nodeView';

// Load the compiled provider with the VS Code boundary and the project model replaced.
function harness() {
  class EventEmitter { listeners: (() => void)[] = []; event = (fn: () => void) => { this.listeners.push(fn); return { dispose() {} }; }; fire() { this.listeners.forEach(fn => fn()); } dispose() {} }
  const filename = path.resolve(__dirname, '../../views/nodeView.js');
  const localRequire = createRequire(filename);
  const exports: Record<string, any> = {};
  runInNewContext('(function(require, exports) {' + fs.readFileSync(filename, 'utf8') + '\n})', {})(
    (name: string) => name === 'vscode' ? { EventEmitter } : name === '../projects' ? { codePaths: () => [], STATE_LABEL: {} } : localRequire(name), exports,
  );
  // Files: docs/<node>/<doc>.md are documents, code/<node>/… is code, anything else belongs to no node.
  const p = {
    nodes: new Map([['payments', {}], ['orders', {}]]),
    target(fsPath: string) {
      const doc = fsPath.match(/^\/docs\/(\w+)\/(\w+)\.md$/);
      if (doc) return { node: doc[1], doc: doc[2], spec: { kind: 'doc' } };
      const code = fsPath.match(/^\/code\/(\w+)\//);
      return code ? { node: code[1], code: true } : undefined;
    },
  };
  let changed = () => {};
  const manager = { projects: [p], projectFor: () => p, onDidChange: (fn: () => void) => { changed = fn; return { dispose() {} }; } };
  const view: NodeViewProvider = new exports.NodeViewProvider(manager);
  return { view, p, refresh: () => changed(), uri: (fsPath: string) => ({ fsPath }) as any };
}

describe('node view target', () => {
  it('follows node files and keeps the last node for a file of no node', () => {
    const h = harness();
    h.view.followFile(h.uri('/docs/payments/logic.md'));
    assert.deepStrictEqual([h.view.target?.node, h.view.target?.doc], ['payments', 'logic']);
    h.view.followFile(h.uri('/README.md'));
    assert.strictEqual(h.view.target?.node, 'payments');
    h.refresh();
    assert.strictEqual(h.view.target?.node, 'payments', 'a model refresh keeps it too');
    h.view.followFile(h.uri('/code/orders/index.ts'));
    assert.deepStrictEqual([h.view.target?.node, h.view.target?.doc], ['orders', undefined]);
    h.view.followFile(h.uri('/README.md'));
    h.p.nodes.delete('orders');
    h.refresh();
    assert.strictEqual(h.view.target, undefined, 'a removed node is cleared');
  });
});
