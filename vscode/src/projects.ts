// Finds the uspec projects in the workspace, loads them from the CLI and keeps them fresh
// (docs/vscode/overview.md#projects-and-the-cli).
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { CliNotFoundError, Lock, resolveCli, runJson, runText } from './core/cli';
import { parseDrift } from './core/drift';
import type {
  ChangeCounts,
  ChangeListJson,
  DocState,
  DriftJson,
  Issue,
  NextJson,
  NodeTypeJson,
  PlanJson,
  StatusDocJson,
  StatusJson,
  TreeJson,
  TypeDocJson,
  TypesJson,
  ValidateJson,
} from './core/model';
import {
  classifySpecPath,
  codeOwner,
  docKey,
  join,
  nodeKey,
  normaliseCodePath,
  parentOf,
  projectToSpec,
  specRootFromConfig,
  specToProject,
  type SpecFile,
} from './core/paths';
import { parseLink, type Link } from './core/links';
import { isUnwritten, splitFrontmatter } from './core/templates';

export interface NodeInfo {
  /** Spec-relative path, "" for the root. */
  path: string;
  type: string | null;
  /** Documents present, in the type's order. */
  documents: string[];
  /** Upstream nodes, each once. */
  links: string[];
  /** The links as written, parsed; a link that can't be parsed is left out (validate reports it). */
  deps: Link[];
  code: string[];
  parent?: string;
  children: string[];
  /** Documents that have an `-extra/` folder. */
  extras: string[];
}

export interface ChangeData {
  name: string;
  baseline: string;
  created: number;
  counts: ChangeCounts;
  status?: StatusJson;
  next?: NextJson;
  error?: string;
  docs: Map<string, StatusDocJson>;
  impl: Map<string, 'pending' | 'done'>;
  plans: PlanJson[];
}

/** What a file is to a project: a part of the spec, or code under a node's code paths. */
export interface FileTarget {
  node: string;
  doc?: string;
  spec?: SpecFile;
  code?: boolean;
}

/** A drifting node (without `doc`) or document, with every reason `uspec drift` gives for it. */
export interface DriftItem {
  node: string;
  doc?: string;
  reasons: string[];
}

export class Project {
  readonly uri: vscode.Uri;
  readonly name: string;
  readonly lock = new Lock();
  specRoot = 'docs';
  nodes = new Map<string, NodeInfo>();
  types = new Map<string, NodeTypeJson>();
  changes: ChangeData[] = [];
  issues: Issue[] = [];
  /** Code and spec drift, by node. */
  nodeDrift = new Map<string, string[]>();
  /** Dependency drift, by document key. */
  docDrift = new Map<string, string[]>();
  /** Template bodies by `<type>/<document>`. */
  templateBodies = new Map<string, string>();
  /** Documents nobody has written yet, by document key. */
  unwritten = new Set<string>();
  downstream = new Map<string, string[]>();
  error?: string;
  loaded = false;
  /** The change the user made active; the oldest open change otherwise. */
  chosenChange?: string;

  constructor(readonly root: string) {
    this.uri = vscode.Uri.file(root);
    this.name = path.basename(root);
  }

  get activeChange(): ChangeData | undefined {
    return this.changes.find((c) => c.name === this.chosenChange) ?? this.changes[0];
  }

  change(name: string): ChangeData | undefined {
    return this.changes.find((c) => c.name === name);
  }

  /** The label of the root node: the spec root's name. */
  get rootLabel(): string {
    return this.specRoot || this.name;
  }

  abs(rel: string): string {
    return rel ? path.join(this.root, ...rel.split('/')) : this.root;
  }

  uriOf(rel: string): vscode.Uri {
    return vscode.Uri.file(this.abs(rel));
  }

  rel(fsPath: string): string {
    return path.relative(this.root, fsPath).split(path.sep).join('/');
  }

  contains(fsPath: string): boolean {
    return fsPath === this.root || fsPath.startsWith(this.root + path.sep);
  }

  /** Project-relative directory of a node. */
  nodeDir(node: string): string {
    return specToProject(this.specRoot, node);
  }

  nodeYaml(node: string): string {
    return join(this.nodeDir(node), 'node.yaml');
  }

  /** Project-relative path of a document key. */
  docFile(key: string): string {
    return specToProject(this.specRoot, key);
  }

  typeOf(node: string): NodeTypeJson | undefined {
    const t = this.nodes.get(node)?.type;
    return t ? this.types.get(t) : undefined;
  }

  typeDoc(node: string, doc: string): TypeDocJson | undefined {
    return this.typeOf(node)?.documents.find((d) => d.document === doc);
  }

  hasCode(node: string): boolean {
    return Boolean(this.typeOf(node)?.code);
  }

  /** What a file or directory is in this project. */
  target(fsPath: string): FileTarget | undefined {
    const rel = this.rel(fsPath);
    const specRel = projectToSpec(this.specRoot, rel);
    if (specRel !== undefined && !rel.startsWith('.uspec/')) {
      const spec = classifySpecPath(
        specRel,
        (n) => this.nodes.has(n),
        (n, d) => Boolean(this.typeOf(n)?.documents.some((x) => x.document === d)),
      );
      if (spec) return { node: spec.node, doc: spec.kind === 'doc' || spec.kind === 'extra' ? spec.doc : undefined, spec };
    }
    const owner = codeOwner(
      [...this.nodes.values()].filter((n) => n.code.length && this.hasCode(n.path)),
      rel,
    );
    return owner !== undefined ? { node: owner, code: true } : undefined;
  }

  /** A document's state in the active change. */
  docState(key: string): StatusDocJson | undefined {
    return this.activeChange?.docs.get(key);
  }

  /** A node's drifting items: the node itself, then its documents in its type's order. */
  drifts(node: string): DriftItem[] {
    const out: DriftItem[] = [];
    const own = this.nodeDrift.get(node);
    if (own) out.push({ node, reasons: own });
    for (const doc of this.nodes.get(node)?.documents ?? []) {
      const reasons = this.docDrift.get(docKey(node, doc));
      if (reasons) out.push({ node, doc, reasons });
    }
    return out;
  }

  /** Validation errors about a node: its directory, its node.yaml, or a file or folder directly in it that isn't a node. */
  nodeIssues(node: string): Issue[] {
    const dir = this.nodeDir(node);
    return this.issues.filter((i) => {
      const p = i.path.replace(/\/+$/, '');
      if (p === dir) return true;
      const rest = dir ? (p.startsWith(`${dir}/`) ? p.slice(dir.length + 1) : undefined) : p;
      return rest !== undefined && !rest.includes('/') && !this.nodes.has(join(node, rest));
    });
  }
}

export class ProjectManager implements vscode.Disposable {
  projects: Project[] = [];
  loaded = false;
  cliMissing = false;
  readonly output = vscode.window.createOutputChannel('uspec');
  private readonly emitter = new vscode.EventEmitter<Project | undefined>();
  readonly onDidChange = this.emitter.event;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly loading = new Map<Project, Promise<void>>();
  private readonly dirty = new Set<Project>();
  private readonly watchers = new Map<string, vscode.Disposable>();
  private readonly disposables: vscode.Disposable[] = [];
  private cliWarned = false;

  constructor() {
    const w = vscode.workspace.createFileSystemWatcher('**/.uspec/{config.yaml,node-types/*/node-type.yaml}');
    this.disposables.push(
      w,
      w.onDidCreate(() => this.schedule('discover', 500, () => this.discover())),
      w.onDidDelete(() => this.schedule('discover', 500, () => this.discover())),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.discover()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('uspec')) {
          this.cliWarned = false;
          this.refreshAll();
        }
      }),
      this.emitter,
      this.output,
    );
  }

  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    for (const w of this.watchers.values()) w.dispose();
    for (const d of this.disposables) d.dispose();
  }

  private config() {
    return vscode.workspace.getConfiguration('uspec');
  }

  get cliPath(): string {
    return resolveCli(this.config().get<string>('cliPath', 'uspec'));
  }

  private schedule(key: string, delay: number, task: () => unknown): void {
    clearTimeout(this.timers.get(key));
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        task();
      }, delay),
    );
  }

  /** Finds every directory holding `.uspec/` in the workspace, nested ones included. */
  async discover(): Promise<void> {
    const exclude = '{**/node_modules/**,**/target/**,**/.git/**}';
    const files = [
      ...(await vscode.workspace.findFiles('**/.uspec/node-types/*/node-type.yaml', exclude)),
      ...(await vscode.workspace.findFiles('**/.uspec/config.yaml', exclude)),
    ];
    const roots = new Set<string>();
    for (const f of files) {
      const i = f.fsPath.lastIndexOf(`${path.sep}.uspec${path.sep}`);
      if (i >= 0) roots.add(f.fsPath.slice(0, i));
    }
    const sorted = [...roots].sort();
    const kept = this.projects.filter((p) => roots.has(p.root));
    for (const p of this.projects) {
      if (!roots.has(p.root)) {
        this.watchers.get(p.root)?.dispose();
        this.watchers.delete(p.root);
      }
    }
    this.projects = sorted.map((r) => kept.find((p) => p.root === r) ?? new Project(r));
    for (const p of this.projects) if (!this.watchers.has(p.root)) this.watch(p);
    await Promise.all(this.projects.map((p) => this.load(p)));
    this.loaded = true;
    this.emitter.fire(undefined);
  }

  private watch(p: Project): void {
    const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(p.uri, '**/*'));
    const on = (uri: vscode.Uri) => {
      const rel = p.rel(uri.fsPath);
      // A file of a nested project belongs to that project.
      if (this.projectFor(uri) !== p && !rel.startsWith('.git/')) return;
      if (rel.startsWith('.git/')) {
        if (rel === '.git/index' || rel === '.git/HEAD') this.schedule(`drift:${p.root}`, 1500, () => this.reloadDrift(p));
        return;
      }
      if (rel.startsWith('node_modules/') || rel.includes('/node_modules/')) return;
      if (rel.startsWith('.uspec/') || projectToSpec(p.specRoot, rel) !== undefined) {
        this.refresh(p);
      } else if (p.target(uri.fsPath)?.code) {
        this.schedule(`drift:${p.root}`, 1500, () => this.reloadDrift(p));
      }
    };
    this.watchers.set(p.root, vscode.Disposable.from(w, w.onDidChange(on), w.onDidCreate(on), w.onDidDelete(on)));
  }

  /** The project a file belongs to: the nearest one above it. */
  projectFor(uri: vscode.Uri | undefined): Project | undefined {
    if (!uri || uri.scheme !== 'file') return undefined;
    let best: Project | undefined;
    for (const p of this.projects) if (p.contains(uri.fsPath) && (!best || p.root.length > best.root.length)) best = p;
    return best;
  }

  /** Reloads a project soon; repeated calls within the delay load it once. */
  refresh(p: Project, delay = 300): void {
    this.schedule(`load:${p.root}`, delay, () => this.load(p));
  }

  refreshAll(): void {
    for (const p of this.projects) this.refresh(p, 0);
  }

  /** Tells the views that something about a project changed without reloading it. */
  notify(p?: Project): void {
    this.emitter.fire(p);
  }

  /** Runs `uspec --json <args>` in the project. */
  async json<T>(p: Project, args: string[]): Promise<T> {
    try {
      const v = await runJson<T>(this.cliPath, p.root, args);
      this.setCliMissing(false);
      return v;
    } catch (e) {
      if (e instanceof CliNotFoundError) this.setCliMissing(true);
      throw e;
    }
  }

  /** Runs `uspec <args>` in the project for its text output. */
  async text(p: Project, args: string[]): Promise<string> {
    try {
      return await runText(this.cliPath, p.root, args);
    } catch (e) {
      if (e instanceof CliNotFoundError) this.setCliMissing(true);
      throw e;
    }
  }

  /** Runs a command that changes files: one at a time per project, then reloads. */
  async mutate<T>(p: Project, args: string[]): Promise<T> {
    try {
      return await p.lock.run(() => this.json<T>(p, args));
    } finally {
      this.refresh(p, 50);
    }
  }

  private setCliMissing(missing: boolean): void {
    if (this.cliMissing === missing) return;
    this.cliMissing = missing;
    void vscode.commands.executeCommand('setContext', 'uspec.cliMissing', missing);
    if (missing && !this.cliWarned) {
      this.cliWarned = true;
      void vscode.window
        .showErrorMessage(`The uspec CLI couldn't be started (${this.cliPath}). Install it or set uspec.cliPath.`, 'Open Settings')
        .then((a) => a && vscode.commands.executeCommand('workbench.action.openSettings', 'uspec.cliPath'));
    }
  }

  /**
   * Loads a project. A load requested while one runs starts again when it ends, and the caller waits
   * for that second load: the running one may have read the files before the caller changed them.
   */
  load(p: Project): Promise<void> {
    const running = this.loading.get(p);
    if (running) {
      this.dirty.add(p);
      return running.then(() => this.loading.get(p));
    }
    const task = this.doLoad(p)
      .catch((e) => {
        p.error = e instanceof Error ? e.message : String(e);
        this.output.appendLine(`${p.root}: ${p.error}`);
      })
      .finally(() => {
        this.loading.delete(p);
        p.loaded = true;
        this.emitter.fire(p);
        if (this.dirty.delete(p)) void this.load(p);
      });
    this.loading.set(p, task);
    return task;
  }

  private async doLoad(p: Project): Promise<void> {
    p.specRoot = specRootFromConfig(await readText(path.join(p.root, '.uspec', 'config.yaml')));
    const [tree, types, list] = await Promise.all([
      this.json<TreeJson>(p, ['tree']),
      this.json<TypesJson>(p, ['types']).catch((e) => {
        this.output.appendLine(`uspec types: ${e.message ?? e} (is the CLI older than the extension?)`);
        return { types: [] } as TypesJson;
      }),
      this.json<ChangeListJson>(p, ['change', 'list']),
    ]);
    p.error = undefined;
    p.types = new Map(types.types.map((t) => [t.type, t]));
    p.nodes = new Map();
    for (const n of tree.nodes) {
      const key = nodeKey(n.node);
      const deps = n.derives_from.map(parseLink).filter((l): l is Link => l !== undefined);
      p.nodes.set(key, {
        path: key,
        type: n.type,
        documents: n.documents,
        links: [...new Set(deps.map((l) => l.node))],
        deps,
        code: n.code,
        parent: parentOf(key),
        children: [],
        extras: [],
      });
    }
    // Directories that aren't nodes (no node.yaml) are still listed; parents always come first.
    for (const n of p.nodes.values()) if (n.parent !== undefined) p.nodes.get(n.parent)?.children.push(n.path);
    p.downstream = new Map();
    for (const n of p.nodes.values()) {
      for (const l of n.links) p.downstream.set(l, [...(p.downstream.get(l) ?? []), n.path]);
    }

    p.changes = await Promise.all(
      list.changes.map(async (c) => {
        const data: ChangeData = { name: c.change, baseline: c.baseline, created: c.created, counts: c.counts, docs: new Map(), impl: new Map(), plans: [] };
        try {
          const [status, next] = await Promise.all([
            this.json<StatusJson>(p, ['change', 'status', c.change]),
            this.json<NextJson>(p, ['change', 'next', c.change]),
          ]);
          data.status = status;
          data.next = next;
          data.docs = new Map(status.documents.map((d) => [d.document, d]));
          data.impl = new Map(status.implementation.map((i) => [nodeKey(i.node), i.state]));
          data.plans = status.plans ?? [];
        } catch (e) {
          data.error = e instanceof Error ? e.message : String(e);
        }
        return data;
      }),
    );
    if (p.chosenChange && !p.change(p.chosenChange)) p.chosenChange = undefined;

    const cfg = this.config();
    const [validate, drift] = await Promise.all([
      cfg.get('validateOnChange', true) ? this.json<ValidateJson>(p, ['validate']).catch(() => undefined) : undefined,
      cfg.get('drift.enabled', true) ? this.json<DriftJson>(p, ['drift']).catch(() => undefined) : undefined,
    ]);
    p.issues = validate?.errors ?? [];
    if (drift) setDrift(p, drift);
    else if (!cfg.get('drift.enabled', true)) setDrift(p, { drift: [] });

    await this.loadFiles(p);
  }

  /** Template bodies, `-extra/` folders and unwritten documents: what only the files tell. */
  private async loadFiles(p: Project): Promise<void> {
    p.templateBodies = new Map();
    await Promise.all(
      [...p.types.values()].flatMap((t) =>
        t.documents
          .filter((d) => d.template)
          .map(async (d) => {
            const text = await readText(p.abs(d.template!));
            if (text !== undefined) p.templateBodies.set(`${t.type}/${d.document}`, splitFrontmatter(text).body);
          }),
      ),
    );
    const unwritten = new Set<string>();
    await Promise.all(
      [...p.nodes.values()].map(async (n) => {
        const t = n.type ? p.types.get(n.type) : undefined;
        if (!t) return;
        const dir = p.abs(p.nodeDir(n.path));
        n.extras = [];
        let entries: fs.Dirent[] = [];
        try {
          entries = await fs.promises.readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          if (e.isDirectory() && e.name.endsWith('-extra')) {
            const doc = e.name.slice(0, -'-extra'.length);
            if (t.documents.some((d) => d.document === doc)) n.extras.push(doc);
          }
        }
        await Promise.all(
          n.documents.map(async (doc) => {
            const text = await readText(path.join(dir, `${doc}.md`));
            if (text !== undefined && isUnwritten(text, p.templateBodies.get(`${t.type}/${doc}`))) unwritten.add(docKey(n.path, doc));
          }),
        );
      }),
    );
    p.unwritten = unwritten;
  }

  private async reloadDrift(p: Project): Promise<void> {
    if (!this.config().get('drift.enabled', true)) return;
    try {
      setDrift(p, await this.json<DriftJson>(p, ['drift']));
      this.emitter.fire(p);
    } catch {
      // Reported by the next full load.
    }
  }

  /** Every node of every project, for pickers. */
  allNodes(): { project: Project; node: NodeInfo }[] {
    return this.projects.flatMap((p) => [...p.nodes.values()].map((node) => ({ project: p, node })));
  }
}

function setDrift(p: Project, json: DriftJson): void {
  const { nodes, docs } = parseDrift(json);
  p.nodeDrift = nodes;
  p.docDrift = docs;
}

export async function readText(file: string): Promise<string | undefined> {
  try {
    return await fs.promises.readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}

export function readTextSync(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

export const STATE_LABEL: Record<DocState, string> = {
  pending: 'pending',
  affected: 'affected',
  updated: 'updated',
  'no-change': 'no change',
};

/** The code paths of a node that exist, with whether each is a directory. */
export function codePaths(p: Project, node: string): { path: string; dir: boolean }[] {
  return (p.nodes.get(node)?.code ?? []).map((c) => {
    const rel = normaliseCodePath(c);
    let dir = c.endsWith('/');
    try {
      dir = fs.statSync(p.abs(rel)).isDirectory();
    } catch {
      // A code path that doesn't exist yet: trust its trailing slash.
    }
    return { path: rel, dir };
  });
}
