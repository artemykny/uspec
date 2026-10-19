// Commands: nodes, changes, context, agents and terminal sessions (docs/vscode/overview.md).
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { AgentManager, AgentRun } from './agents';
import { writerDocs } from './core/agents';
import { runJson, UspecError } from './core/cli';
import { sectionLine, sectionText } from './core/links';
import { CONTEXT_GROUPS, type ContextJson, type NextJson, type SetJson } from './core/model';
import { baseName, docKey, join, nodeKey, showNode, splitDoc } from './core/paths';
import type { ContentProvider } from './content';
import { codePaths, readText, type Project, type ProjectManager } from './projects';
import { ensureSkills, installSkills, openClaude } from './terminal';
import type { NodeViewProvider } from './views/nodeView';
import { contextArgs } from './views/nodeView';
import type { SpecEl, SpecTreeProvider } from './views/specTree';
import type { StateWindows } from './views/stateWindow';

export interface Services {
  manager: ProjectManager;
  agents: AgentManager;
  content: ContentProvider;
  specTree: SpecTreeProvider;
  specTreeView: vscode.TreeView<SpecEl>;
  nodeView: NodeViewProvider;
  stateWindows: StateWindows;
  extensionPath: string;
}

interface NodeRef {
  p: Project;
  node: string;
}
interface DocRef extends NodeRef {
  doc: string;
}
interface ChangeRef {
  p: Project;
  name: string;
}

/** Shows a command's failure: the CLI's own message when it has one. */
function fail(e: unknown): void {
  const msg = e instanceof UspecError ? e.message : e instanceof Error ? e.message : String(e);
  void vscode.window.showErrorMessage(msg);
}

export function registerCommands(ctx: vscode.ExtensionContext, s: Services): void {
  const { manager, agents, content } = s;

  const reg = (id: string, fn: (...args: any[]) => unknown) =>
    ctx.subscriptions.push(
      vscode.commands.registerCommand(id, async (...args: any[]) => {
        try {
          await fn(...args.map(arg => arg?.kind === 'foreign' ? arg.value : arg));
        } catch (e) {
          fail(e);
        }
      }),
    );

  // --- Resolving what a command works on: a view element, a lens argument, or the active editor ---

  const activeTarget = () => {
    const uri = vscode.window.activeTextEditor?.document.uri;
    const p = manager.projectFor(uri);
    const t = p && uri ? p.target(uri.fsPath) : undefined;
    return p && t ? { p, ...t } : undefined;
  };

  const pickProject = async (): Promise<Project | undefined> => {
    const fromEditor = manager.projectFor(vscode.window.activeTextEditor?.document.uri);
    if (fromEditor) return fromEditor;
    if (manager.projects.length <= 1) return manager.projects[0];
    const pick = await vscode.window.showQuickPick(
      manager.projects.map((p) => ({ label: p.name, description: vscode.workspace.asRelativePath(p.uri), p })),
      { placeHolder: 'Project' },
    );
    return pick?.p;
  };

  const pickNode = async (placeHolder: string, filter: (p: Project, node: string) => boolean = () => true): Promise<NodeRef | undefined> => {
    const items = manager
      .allNodes()
      .filter(({ project, node }) => filter(project, node.path))
      .map(({ project, node }) => ({
        label: showNode(node.path),
        description: node.type ?? '?',
        detail: manager.projects.length > 1 ? project.name : undefined,
        ref: { p: project, node: node.path },
      }));
    return (await vscode.window.showQuickPick(items, { placeHolder, matchOnDescription: true }))?.ref;
  };

  const nodeRef = async (arg: any, placeHolder = 'Node'): Promise<NodeRef | undefined> => {
    if (arg?.kind === 'context') return s.nodeView.target ? { p: s.nodeView.target.p, node: s.nodeView.target.node } : undefined;
    if (arg?.p && typeof arg.node === 'string') return { p: arg.p, node: arg.node };
    if (arg?.p && typeof arg.key === 'string') return { p: arg.p, node: splitDoc(arg.key).node };
    const t = activeTarget();
    if (t) return { p: t.p, node: t.node };
    return pickNode(placeHolder);
  };

  const docRef = async (arg: any): Promise<DocRef | undefined> => {
    if (arg?.kind === 'context') {
      const t = s.nodeView.target;
      return t?.doc ? { p: t.p, node: t.node, doc: t.doc } : undefined;
    }
    if (arg?.p && typeof arg.key === 'string') return { p: arg.p, ...splitDoc(arg.key) };
    if (arg?.p && typeof arg.node === 'string' && typeof arg.doc === 'string') return { p: arg.p, node: arg.node, doc: arg.doc };
    const t = activeTarget();
    if (t?.doc) return { p: t.p, node: t.node, doc: t.doc };
    void vscode.window.showInformationMessage('Open a spec document first.');
    return undefined;
  };

  const changeRef = async (arg: any): Promise<ChangeRef | undefined> => {
    if (arg?.p && typeof arg.name === 'string') return { p: arg.p, name: arg.name };
    if (arg?.run) return arg.run.change ? { p: arg.run.p, name: arg.run.change } : undefined;
    const p: Project | undefined = arg?.p ?? (await pickProject());
    if (!p) return undefined;
    const c = p.activeChange;
    if (!c) {
      void vscode.window.showInformationMessage(`${p.name} has no open change.`, 'New Change').then((a) => a && vscode.commands.executeCommand('uspec.change.new'));
      return undefined;
    }
    return { p, name: c.name };
  };

  const runArg = (arg: any): AgentRun | undefined => arg?.run;
  /** The writer document a run action is on, when it is on one (a `runDoc` item). */
  const runDocArg = (arg: any): string | undefined => (typeof arg?.key === 'string' ? arg.key : undefined);

  const open = async (uri: vscode.Uri) => vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: false });

  const saveIfDirty = async (uri: vscode.Uri) => {
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath);
    if (doc?.isDirty) await doc.save();
  };

  const reveal = async (p: Project, node: string, doc?: string) => {
    const el: SpecEl = doc ? { kind: 'doc', p, node, doc } : { kind: 'node', p, node };
    await s.specTreeView.reveal(el, { select: true, focus: false, expand: doc ? false : 1 });
  };

  // --- General -----------------------------------------------------------------------------------

  reg('uspec.refresh', () => manager.discover());

  reg('uspec.init', async () => {
    const folders = vscode.workspace.workspaceFolders ?? [];
    let dir: string | undefined;
    if (folders.length === 1) dir = folders[0].uri.fsPath;
    else {
      const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Initialize here', defaultUri: folders[0]?.uri });
      dir = picked?.[0]?.fsPath;
    }
    if (!dir) return;
    const choice = await vscode.window.showQuickPick(
      [
        { label: 'Basic', description: 'one node type with an overview document', preset: undefined as string | undefined },
        { label: 'Local preset…', description: 'node types from a directory', preset: 'local' },
        { label: 'GitHub preset…', description: 'github:<owner>/<repo>[/<path>][@<ref>]', preset: 'github' },
      ],
      { placeHolder: `Initialize a uspec project in ${dir}` },
    );
    if (!choice) return;
    let preset = choice.preset;
    if (preset === 'local') {
      preset = (await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Use preset' }))?.[0]?.fsPath;
      if (!preset) return;
    } else if (preset === 'github') {
      preset = await vscode.window.showInputBox({ prompt: 'GitHub preset', placeHolder: 'github:owner/repo/path@ref', value: 'github:' });
      if (!preset) return;
    }
    const out = await runJson<{ types: string[]; root_type: string; created: string[] }>(manager.cliPath, dir, ['init', ...(preset ? ['--preset', preset] : [])]);
    await manager.discover();
    const first = out.created.find((f) => f.endsWith('.md'));
    if (first) await open(vscode.Uri.file(path.join(dir, first)));
    void vscode.window.showInformationMessage(`Created a uspec project with ${out.types.length} node types; the root is a ${out.root_type}.`);
  });

  reg('uspec.validate', async () => {
    await Promise.all(manager.projects.map((p) => manager.load(p)));
    const errors = manager.projects.reduce((n, p) => n + p.issues.length, 0);
    if (errors) {
      await vscode.commands.executeCommand('workbench.actions.view.problems');
      void vscode.window.showWarningMessage(`uspec validate: ${errors} error${errors === 1 ? '' : 's'}.`);
    } else {
      const summary = manager.projects.map((p) => `${p.types.size} node types, ${p.nodes.size} nodes`).join('; ');
      void vscode.window.showInformationMessage(`uspec validate: ok (${summary}).`);
    }
  });

  reg('uspec.checkDrift', async () => {
    await Promise.all(manager.projects.map((p) => manager.load(p)));
    const drifting = manager.projects.flatMap((p) => [...p.drift.entries()].map(([n, r]) => ({ p, n, r })));
    if (!drifting.length) {
      void vscode.window.showInformationMessage('No drift: every node’s code matches a committed spec change.');
      return;
    }
    const pick = await vscode.window.showQuickPick(
      drifting.map((d) => ({ label: `$(warning) ${showNode(d.n)}`, description: d.r, d })),
      { placeHolder: `${drifting.length} node${drifting.length === 1 ? '' : 's'} drift` },
    );
    if (pick) await open(pick.d.p.uriOf(pick.d.p.nodeYaml(pick.d.n)));
  });

  reg('uspec.goToNode', async () => {
    const items = manager.allNodes().flatMap(({ project, node }) => [
      {
        label: `$(${project.typeOf(node.path)?.code ? 'file-code' : 'symbol-namespace'}) ${showNode(node.path)}`,
        description: node.type ?? '?',
        detail: manager.projects.length > 1 ? project.name : undefined,
        p: project,
        node: node.path,
        doc: undefined as string | undefined,
      },
      ...node.documents.map((d) => ({
        label: `$(markdown) ${docKey(node.path, d)}`,
        description: project.typeDoc(node.path, d)?.description?.split('\n')[0] ?? '',
        detail: manager.projects.length > 1 ? project.name : undefined,
        p: project,
        node: node.path,
        doc: d as string | undefined,
      })),
    ]);
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Go to a node or document', matchOnDescription: true });
    if (!pick) return;
    if (pick.doc) await open(pick.p.uriOf(pick.p.docFile(docKey(pick.node, pick.doc))));
    else {
      await open(pick.p.uriOf(pick.p.nodeYaml(pick.node)));
      await reveal(pick.p, pick.node);
    }
  });

  reg('uspec.revealActiveFile', async () => {
    const t = activeTarget();
    if (!t) {
      void vscode.window.showInformationMessage('The active file isn’t part of a spec node or its code.');
      return;
    }
    await vscode.commands.executeCommand('uspec.specTree.focus');
    await reveal(t.p, t.node, t.code ? undefined : t.doc);
  });

  reg('uspec.revealNode', async (root: string, node: string, openYaml?: boolean) => {
    const p = manager.projects.find((x) => x.root === root);
    if (!p) return;
    const key = nodeKey(node);
    if (openYaml) await open(p.uriOf(p.nodeYaml(key)));
    await reveal(p, key);
  });

  reg('uspec.revealPath', async (root: string, rel: string) => {
    const uri = vscode.Uri.file(path.join(root, ...rel.replace(/\/+$/, '').split('/')));
    if (!fs.existsSync(uri.fsPath)) {
      void vscode.window.showWarningMessage(`${rel} doesn’t exist.`);
      return;
    }
    if (fs.statSync(uri.fsPath).isDirectory()) await vscode.commands.executeCommand('revealInExplorer', uri);
    else await open(uri);
  });

  // Opens a document, at a section's heading when one is given.
  reg('uspec.openSection', async (root: string, rel: string, section?: string) => {
    const uri = vscode.Uri.file(path.join(root, ...rel.split('/')));
    const doc = await vscode.workspace.openTextDocument(uri);
    const line = section ? sectionLine(doc.getText(), section) : undefined;
    const at = new vscode.Position(line ?? 0, 0);
    await vscode.window.showTextDocument(doc, { preview: false, selection: new vscode.Range(at, at) });
  });

  reg('uspec.diffFile', async (root: string, rel: string, baseline: string) => {
    const file = vscode.Uri.file(path.join(root, ...rel.split('/')));
    await vscode.commands.executeCommand('vscode.diff', content.atRevision(root, baseline, rel), file, `${path.basename(rel)} (${baseline.slice(0, 7)} ↔ now)`);
  });

  reg('uspec.installSkills', async () => {
    const p = await pickProject();
    if (p) await installSkills(p, s.extensionPath);
  });

  // --- Nodes -------------------------------------------------------------------------------------

  reg('uspec.node.new', async (arg?: any) => {
    const parent = arg ? await nodeRef(arg) : await pickNode('Parent of the new node', (p, n) => Boolean(p.typeOf(n)?.children.length));
    if (!parent) return;
    const { p } = parent;
    const pt = p.typeOf(parent.node);
    if (!pt) throw new Error(`${showNode(parent.node)} has no known type.`);
    if (!pt.children.length) {
      void vscode.window.showInformationMessage(`Type ${pt.type} allows no children.`);
      return;
    }
    const typePick = await vscode.window.showQuickPick(
      pt.children.map((id) => p.types.get(id)).filter((t) => t !== undefined).map((t) => ({ label: t.type, description: t.name, detail: t.description ?? undefined, t })),
      { placeHolder: `Type of the new node under ${showNode(parent.node)}` },
    );
    if (!typePick) return;
    const t = typePick.t;
    const reserved = new Set(pt.documents.map((d) => `${d.document}-extra`));
    const name = await vscode.window.showInputBox({
      prompt: `Name of the new ${t.name} under ${showNode(parent.node)}`,
      placeHolder: 'kebab-case directory name',
      validateInput: (v) => {
        if (!v.trim()) return 'Give a name';
        if (/[/\\]/.test(v) || v.startsWith('.')) return 'A name, not a path; it can’t start with a dot';
        if (reserved.has(v)) return `${v} holds the extra files of ${v.slice(0, -6)}.md`;
        if (p.nodes.has(join(parent.node, v))) return `${showNode(join(parent.node, v))} already exists`;
        return undefined;
      },
    });
    if (!name) return;
    const args = ['node', 'new', showNode(join(parent.node, name.trim())), '--type', t.type];
    if (t.derives_from.length) {
      const candidates = [...p.nodes.values()].filter((n) => n.type && t.derives_from.includes(n.type));
      if (candidates.length) {
        const links = await vscode.window.showQuickPick(
          candidates.map((n) => ({ label: showNode(n.path), description: n.type ?? '' })),
          { canPickMany: true, placeHolder: `Nodes the new ${t.name} derives from (${t.derives_from.join(', ')}); none is fine` },
        );
        if (!links) return;
        if (links.length) args.push('--derives-from', ...links.map((l) => l.label));
      }
    }
    if (t.code) {
      const code = await vscode.window.showInputBox({
        prompt: `Code paths of the new ${t.name}, relative to ${p.name}/ (several separated by spaces)`,
        placeHolder: 'services/payments/',
        validateInput: (v) => (v.trim() ? undefined : `Type ${t.type} has code: true, so the node needs at least one code path`),
      });
      if (!code) return;
      args.push('--code', ...code.trim().split(/\s+/));
    }
    const out = await manager.mutate<{ node: string; created: string[] }>(p, args);
    const first = out.created.find((f) => f.endsWith('.md')) ?? out.created[0];
    if (first) await open(p.uriOf(first));
  });

  reg('uspec.node.move', async (arg?: any) => {
    const ref = await nodeRef(arg, 'Node to move');
    if (!ref || !ref.node) return;
    const to = await vscode.window.showInputBox({
      prompt: `Move ${ref.node} to (a path in the spec tree; rename by changing the last part)`,
      value: ref.node,
      valueSelection: [ref.node.length - baseName(ref.node).length, ref.node.length],
      validateInput: (v) => (!v.trim() ? 'Give the new path' : nodeKey(v) === ref.node ? 'That is where it is' : ref.p.nodes.has(nodeKey(v)) ? `${v} already exists` : undefined),
    });
    if (!to) return;
    const out = await manager.mutate<{ from: string; to: string; links_rewritten: string[] }>(ref.p, ['node', 'move', ref.node, nodeKey(to)]);
    const rewrote = out.links_rewritten.length ? ` Rewrote links in ${out.links_rewritten.join(', ')}.` : '';
    void vscode.window.showInformationMessage(`Moved ${out.from} to ${out.to}.${rewrote}`);
  });

  reg('uspec.node.remove', async (arg?: any) => {
    const ref = await nodeRef(arg, 'Node to remove');
    if (!ref || !ref.node) return;
    const below = [...ref.p.nodes.keys()].filter((n) => n.startsWith(`${ref.node}/`)).length;
    const ok = await vscode.window.showWarningMessage(
      `Remove ${ref.node}${below ? ` and the ${below} node${below === 1 ? '' : 's'} under it` : ''}? This deletes its directory.`,
      { modal: true },
      'Remove',
    );
    if (ok !== 'Remove') return;
    const out = await manager.mutate<{ removed: string[] }>(ref.p, ['node', 'remove', ref.node]);
    void vscode.window.showInformationMessage(`Removed ${out.removed.length} node${out.removed.length === 1 ? '' : 's'}.`);
  });

  reg('uspec.node.openYaml', async (arg?: any) => {
    const ref = await nodeRef(arg);
    if (ref) await open(ref.p.uriOf(ref.p.nodeYaml(ref.node)));
  });

  reg('uspec.node.revealCode', async (arg?: any) => {
    const ref = await nodeRef(arg);
    if (!ref) return;
    const paths = codePaths(ref.p, ref.node);
    if (!paths.length) return;
    const pick = paths.length === 1 ? paths[0] : (await vscode.window.showQuickPick(paths.map((c) => ({ label: c.path, c }))))?.c;
    if (pick) await vscode.commands.executeCommand('uspec.revealPath', ref.p.root, pick.path);
  });

  reg('uspec.node.searchCode', async (arg?: any) => {
    const ref = await nodeRef(arg);
    if (!ref) return;
    const include = codePaths(ref.p, ref.node)
      .map((c) => vscode.workspace.asRelativePath(ref.p.abs(c.path)) + (c.dir ? '/**' : ''))
      .join(', ');
    await vscode.commands.executeCommand('workbench.action.findInFiles', { filesToInclude: include, triggerSearch: false });
  });

  reg('uspec.node.copyPath', async (arg?: any) => {
    const d = arg?.doc && arg?.node !== undefined ? docKey(arg.node, arg.doc) : undefined;
    const ref = d ? undefined : await nodeRef(arg);
    const text = d ?? (ref ? showNode(ref.node) : undefined);
    if (text) await vscode.env.clipboard.writeText(text);
  });

  // --- Context -----------------------------------------------------------------------------------

  /** The job a context command is about: a document to write, or a node to implement. */
  const contextJob = async (arg: any) => {
    if (arg?.kind === 'context' && s.nodeView.target) return { t: s.nodeView.target, mode: arg.mode as 'document' | 'implement' };
    const isDoc = (arg?.kind === 'doc' && (arg.doc || arg.key)) || (!arg && activeTarget()?.doc && !activeTarget()?.code);
    if (isDoc) {
      const d = await docRef(arg);
      return d ? { t: { p: d.p, node: d.node, doc: d.doc }, mode: 'document' as const } : undefined;
    }
    const n = await nodeRef(arg);
    if (!n) return undefined;
    if (!n.p.hasCode(n.node)) {
      void vscode.window.showInformationMessage(`${showNode(n.node)} has no code paths; pick one of its documents for its context.`);
      return undefined;
    }
    return { t: { p: n.p, node: n.node }, mode: 'implement' as const };
  };

  let contextDocs = 0;
  reg('uspec.context.show', async (arg?: any) => {
    const job = await contextJob(arg);
    if (!job) return;
    const args = contextArgs(job.t, job.mode);
    const text = await manager.text(job.t.p, args);
    const title = `${job.mode === 'document' ? docKey(job.t.node, job.t.doc!) : showNode(job.t.node)} context.txt`.replace(/\//g, '_');
    const body = `$ uspec ${args.join(' ')}\n\n${text}`;
    await open(content.register('context', String(++contextDocs), title, () => body));
  });

  reg('uspec.context.copy', async (arg?: any) => {
    const job = await contextJob(arg);
    if (!job) return;
    await vscode.env.clipboard.writeText(await manager.text(job.t.p, contextArgs(job.t, job.mode)));
    void vscode.window.showInformationMessage(`Copied the context of ${job.mode === 'document' ? `${job.t.doc}.md of ` : ''}${showNode(job.t.node)}.`);
  });

  reg('uspec.context.copyWithContents', async (arg?: any) => {
    const job = await contextJob(arg);
    if (!job) return;
    const { p } = job.t;
    const args = contextArgs(job.t, job.mode);
    const [text, json] = await Promise.all([manager.text(p, args), manager.json<ContextJson>(p, args)]);
    const parts = [text.trimEnd(), ''];
    for (const g of CONTEXT_GROUPS) {
      if (g === 'code') continue;
      for (const f of json.files[g] ?? []) {
        if (f.note?.startsWith('diff since') && json.baseline) {
          parts.push(`===== git diff ${json.baseline.slice(0, 7)} -- ${f.path} =====`, await gitDiff(p.root, json.baseline, f.path), '');
        } else if (f.path.endsWith('/')) {
          for (const file of listFiles(p.abs(f.path))) parts.push(`===== ${p.rel(file)} =====`, (await readText(file)) ?? '', '');
        } else if (f.section) {
          const text = (await readText(p.abs(f.path))) ?? '';
          parts.push(`===== ${f.path}#${f.section} =====`, sectionText(text, f.section) ?? '(missing section)', '');
        } else {
          parts.push(`===== ${f.path} =====`, (await readText(p.abs(f.path))) ?? '(missing)', '');
        }
      }
    }
    const all = parts.join('\n');
    await vscode.env.clipboard.writeText(all);
    void vscode.window.showInformationMessage(`Copied the context with file contents (${Math.round(all.length / 1024)} KB).`);
  });

  // --- Changes -----------------------------------------------------------------------------------

  reg('uspec.change.new', async () => {
    const p = await pickProject();
    if (!p) return;
    const name = await vscode.window.showInputBox({
      prompt: 'Name of the change',
      placeHolder: 'refund-window',
      validateInput: (v) => (!/^[a-z0-9-]+$/.test(v) ? 'kebab-case: lowercase letters, digits and -' : p.change(v) ? `${v} is already open` : undefined),
    });
    if (!name) return;
    await manager.mutate(p, ['change', 'new', name]);
    const md = p.uriOf(`.uspec/changes/${name}/change.md`);
    await manager.load(p);
    await open(md);
    void vscode.window
      .showInformationMessage(
        `Describe ${name} in change.md: why, what changes rule by rule, and a worked example with real values. Then Run Agents finds the documents it starts at.`,
        'Write in Claude Code',
      )
      .then((a) => a && vscode.commands.executeCommand('uspec.claude.continueChange', { p, name }));
    const active = p.activeChange?.name;
    if (active && active !== name) void vscode.window.showInformationMessage(`${name} is open. Changes are processed oldest first, so ${active} stays active until it closes.`);
  });

  reg('uspec.change.setActive', async (arg?: any) => {
    const c = await changeRef(arg);
    if (!c) return;
    c.p.chosenChange = c.name;
    manager.notify(c.p);
  });

  reg('uspec.change.close', async (arg?: any) => {
    const c = await changeRef(arg);
    if (!c) return;
    await manager.mutate(c.p, ['change', 'close', c.name]);
    void vscode.window.showInformationMessage(`Closed ${c.name}. Commit the spec and the code together.`);
  });

  reg('uspec.change.showState', async (arg?: any) => {
    const c = await changeRef(arg);
    if (c) await s.stateWindows.show(c.p, c.name);
  });

  reg('uspec.change.openChangeMd', async (arg?: any) => {
    const c = await changeRef(arg);
    if (c) await open(c.p.uriOf(`.uspec/changes/${c.name}/change.md`));
  });

  reg('uspec.change.openStatus', async (arg?: any) => {
    const c = await changeRef(arg);
    if (c) await open(c.p.uriOf(`.uspec/changes/${c.name}/status.yaml`));
  });

  reg('uspec.change.reviewDiffs', async (arg?: any) => {
    const c = await changeRef(arg);
    if (!c) return;
    const data = c.p.change(c.name)!;
    const updated = [...data.docs.values()].filter((d) => d.state === 'updated');
    if (!updated.length) {
      void vscode.window.showInformationMessage(`${c.name} has no updated documents yet.`);
      return;
    }
    const resources = updated.map((d) => {
      const file = c.p.uriOf(c.p.docFile(d.document));
      return [file, content.atRevision(c.p.root, data.baseline, c.p.docFile(d.document)), file];
    });
    try {
      await vscode.commands.executeCommand('vscode.changes', `${c.name}: updated documents since ${data.baseline.slice(0, 7)}`, resources);
    } catch {
      for (const [file, left] of resources) await vscode.commands.executeCommand('vscode.diff', left, file);
    }
  });

  /** The change a document or node command works on: the one in the argument, else the active one. */
  const changeFor = (p: Project, arg: any): string | undefined => (typeof arg?.name === 'string' ? arg.name : p.activeChange?.name);

  reg('uspec.change.diff', async (arg?: any) => {
    const d = await docRef(arg);
    if (!d) return;
    const name = changeFor(d.p, arg);
    const c = name ? d.p.change(name) : undefined;
    if (!c) {
      void vscode.window.showInformationMessage('No open change to diff against.');
      return;
    }
    await vscode.commands.executeCommand('uspec.diffFile', d.p.root, d.p.docFile(docKey(d.node, d.doc)), c.baseline);
  });

  reg('uspec.change.recordUpdated', async (arg?: any) => {
    const d = await docRef(arg);
    if (!d) return;
    const name = changeFor(d.p, arg);
    if (!name) {
      void vscode.window.showInformationMessage('Open a change first.', 'New Change').then((a) => a && vscode.commands.executeCommand('uspec.change.new'));
      return;
    }
    const key = docKey(d.node, d.doc);
    await saveIfDirty(d.p.uriOf(d.p.docFile(key)));
    const out = await manager.mutate<SetJson>(d.p, ['change', 'set', name, key, 'updated']);
    const reached = out.propagated?.length ?? 0;
    const nodes = new Set(out.propagated?.map((x) => splitDoc(x.document).node));
    void vscode.window.showInformationMessage(
      `${key} is updated in ${name}: reached ${reached} document${reached === 1 ? '' : 's'}${reached ? ` in ${nodes.size} node${nodes.size === 1 ? '' : 's'}` : ''}${out.implementation ? `; ${out.implementation} is to implement` : ''}.`,
    );
  });

  const decide = async (arg: any, state: 'affected' | 'no-change') => {
    const d = await docRef(arg);
    if (!d) return;
    const name = changeFor(d.p, arg);
    if (!name) return;
    const key = docKey(d.node, d.doc);
    const reason = await vscode.window.showInputBox({
      prompt: `Why is ${key} ${state === 'affected' ? 'affected' : 'unchanged'}? One line that can be checked against the document.`,
      validateInput: (v) => (v.trim() ? undefined : 'A reason is required'),
    });
    if (!reason) return;
    await manager.mutate(d.p, ['change', 'set', name, key, state, '--reason', reason.trim()]);
  };
  reg('uspec.change.markAffected', (arg?: any) => decide(arg, 'affected'));
  // A document not in the change becomes a starting document: affected, reached via change.md.
  reg('uspec.change.addDocument', (arg?: any) => decide(arg, 'affected'));
  reg('uspec.change.markNoChange', (arg?: any) => decide(arg, 'no-change'));

  reg('uspec.change.markDone', async (arg?: any) => {
    const n = await nodeRef(arg);
    if (!n) return;
    const name = changeFor(n.p, arg);
    if (!name) return;
    const ok = await vscode.window.showWarningMessage(
      `Mark ${showNode(n.node)} done in ${name}? Do it once its code is updated and verified against its documents.`,
      { modal: true },
      'Mark Done',
    );
    if (ok === 'Mark Done') await manager.mutate(n.p, ['change', 'set', name, showNode(n.node), 'done']);
  });

  // --- Agents ------------------------------------------------------------------------------------

  reg('uspec.agents.runChange', async (arg?: any) => {
    const c = await changeRef(arg);
    if (!c) return;
    const oldest = c.p.changes[0]?.name;
    if (oldest && oldest !== c.name) {
      const ok = await vscode.window.showWarningMessage(
        `${oldest} is older and still open. Changes are processed one at a time, oldest first, so each starts from the tree the previous one left. Run agents on ${c.name} anyway?`,
        { modal: true },
        'Run Anyway',
      );
      if (ok !== 'Run Anyway') return;
    }
    await agents.runChange(c.p, c.name);
  });

  reg('uspec.agents.stopChange', async (arg?: any) => {
    const c = await changeRef(arg);
    if (c) agents.stopChange(c.p, c.name);
  });

  reg('uspec.agents.runTriage', async (arg?: any) => {
    const c = await changeRef(arg);
    if (c) await agents.runTriage(c.p, c.name);
  });

  /** Asks before running an agent on an item `change next` doesn't list as ready. */
  const confirmNotReady = async (what: string, why: string) =>
    (await vscode.window.showWarningMessage(`${what} isn’t ready: ${why} Run it anyway?`, { modal: true }, 'Run Anyway')) === 'Run Anyway';

  reg('uspec.agents.runWriter', async (arg?: any) => {
    const d = await docRef(arg);
    if (!d) return;
    const name = changeFor(d.p, arg);
    if (!name) return;
    const key = docKey(d.node, d.doc);
    const state = d.p.change(name)?.docs.get(key)?.state;
    if (state !== 'affected') {
      void vscode.window.showInformationMessage(`Only affected documents get a writer; ${key} is ${state ?? 'not in the change'}.`);
      return;
    }
    if (agents.isBusy(d.p, name, key)) {
      void vscode.window.showInformationMessage(`${key} is already being written or waits for approval.`);
      return;
    }
    // The writer of the document's node, with that document and the node's other documents under `write`.
    const next = await manager.json<NextJson>(d.p, ['change', 'next', name]);
    const w = writerDocs(next, key);
    if (!w.ready && !(await confirmNotReady(key, 'an unsettled document can still reach it.'))) return;
    const docs = w.documents.filter((x) => x === key || !agents.isBusy(d.p, name, x));
    for (const x of docs) await saveIfDirty(d.p.uriOf(d.p.docFile(x)));
    await agents.runWriter(d.p, name, w.node, docs);
  });

  reg('uspec.agents.runImpact', async (arg?: any) => {
    const c = await changeRef(arg);
    if (!c) return;
    if (c.p.change(c.name)?.docs.size) {
      void vscode.window.showInformationMessage(`${c.name} already has documents: the starting documents are found once, before any.`);
      return;
    }
    await agents.runImpact(c.p, c.name);
  });

  reg('uspec.agents.runPlanner', async (arg?: any) => {
    const c = await changeRef(arg);
    if (c) await agents.runPlanner(c.p, c.name);
  });

  /** The plan a plan command works on: the one in the argument, else one picked from the active change. */
  const planRef = async (arg: any): Promise<{ p: Project; name: string; plan: string } | undefined> => {
    if (arg?.p && typeof arg.name === 'string' && typeof arg.plan === 'string') return { p: arg.p, name: arg.name, plan: arg.plan };
    const c = await changeRef(arg);
    if (!c) return undefined;
    const plans = c.p.change(c.name)?.plans.filter((x) => x.state === 'pending') ?? [];
    if (!plans.length) {
      void vscode.window.showInformationMessage(`${c.name} has no plan to implement.`);
      return undefined;
    }
    const pick = await vscode.window.showQuickPick(
      plans.map((x) => ({ label: x.plan, description: x.nodes.join(', '), plan: x.plan })),
      { placeHolder: `Plan of ${c.name}` },
    );
    return pick ? { ...c, plan: pick.plan } : undefined;
  };

  reg('uspec.agents.runImplementer', async (arg?: any) => {
    const pl = await planRef(arg);
    if (!pl) return;
    const next = await manager.json<NextJson>(pl.p, ['change', 'next', pl.name]);
    if (!next.implement.some((i) => i.plan === pl.plan)) {
      if (!(await confirmNotReady(`Plan ${pl.plan}`, 'documents of the change are unsettled, a node isn’t planned, the plans have errors, or it waits for another plan.'))) return;
    }
    await agents.runImplementer(pl.p, pl.name, pl.plan);
  });

  reg('uspec.change.openPlan', async (arg?: any) => {
    const pl = await planRef(arg);
    const path = pl && pl.p.change(pl.name)?.plans.find((x) => x.plan === pl.plan)?.path;
    if (pl && path) await open(pl.p.uriOf(path));
  });

  reg('uspec.agents.review', async (arg?: any) => {
    const n = await nodeRef(arg, 'Node to review');
    if (n) await agents.runReviewer(n.p, n.node);
  });

  reg('uspec.agents.showLog', async (arg?: any) => {
    const r = runArg(arg);
    if (r) await agents.showLog(r);
  });
  reg('uspec.agents.stopRun', (arg?: any) => {
    const r = runArg(arg);
    if (r) agents.stop(r);
  });
  reg('uspec.agents.approve', async (arg?: any) => {
    const r = runArg(arg);
    if (r) await agents.approve(r, runDocArg(arg));
  });
  reg('uspec.agents.reject', async (arg?: any) => {
    const r = runArg(arg);
    if (r) await agents.reject(r, runDocArg(arg));
  });
  reg('uspec.agents.showRunDiff', async (arg?: any) => {
    const r = runArg(arg);
    if (r) await agents.showDiff(r, runDocArg(arg));
  });
  reg('uspec.agents.openSession', (arg?: any) => {
    const r = runArg(arg);
    if (r) agents.openSession(r);
  });
  reg('uspec.agents.clearRuns', () => agents.clearFinished());

  // --- Claude Code in a terminal -----------------------------------------------------------------

  reg('uspec.claude.startChange', async () => {
    const p = await pickProject();
    if (!p) return;
    const what = await vscode.window.showInputBox({
      prompt: 'What should change, and why? Claude Code opens a change with /uspec-spec and writes change.md with you.',
      placeHolder: 'Refunds can be requested within 30 days instead of 14',
    });
    if (!what?.trim()) return;
    if (await ensureSkills(p, s.extensionPath, ['uspec-spec'])) openClaude(p, [`/uspec-spec ${what.trim()}`]);
  });

  reg('uspec.claude.continueChange', async (arg?: any) => {
    const c = await changeRef(arg);
    if (c && (await ensureSkills(c.p, s.extensionPath, ['uspec-spec']))) openClaude(c.p, [`/uspec-spec Continue the change ${c.name}.`], `Claude Code · ${c.name}`);
  });


}

function gitDiff(root: string, rev: string, rel: string): Promise<string> {
  return new Promise((resolve) => {
    execFile('git', ['diff', rev, '--', rel], { cwd: root, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => resolve(err ? `(git diff failed: ${err.message})` : stdout || '(no changes)'));
  });
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else out.push(f);
    }
  };
  walk(dir);
  return out.sort();
}
