use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{bail, Context, Result};
use indexmap::IndexMap;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::git;
use crate::graph::Graph;
use crate::plans::Plans;
use crate::project::{show_node, Project};
use crate::sections;
use crate::tree::{split_doc, Tree};
use crate::types::Types;
use crate::{columns, drift, validate, Out};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum DocState {
    Pending,
    Affected,
    NoChange,
    Updated,
}

impl DocState {
    pub fn parse(s: &str) -> Option<DocState> {
        Some(match s {
            "pending" => DocState::Pending,
            "affected" => DocState::Affected,
            "no-change" => DocState::NoChange,
            "updated" => DocState::Updated,
            _ => return None,
        })
    }

    pub fn as_str(self) -> &'static str {
        match self {
            DocState::Pending => "pending",
            DocState::Affected => "affected",
            DocState::NoChange => "no-change",
            DocState::Updated => "updated",
        }
    }

    pub fn settled(self) -> bool {
        matches!(self, DocState::NoChange | DocState::Updated)
    }
}

pub struct DocEntry {
    pub state: DocState,
    pub reason: Option<String>,
    /// The rules that reached the document.
    pub via: Vec<String>,
}

pub struct Status {
    pub baseline: String,
    pub created: u64,
    pub documents: IndexMap<String, DocEntry>,
    /// Node path ("." for the root) → done.
    pub implementation: IndexMap<String, bool>,
}

#[derive(Deserialize)]
struct RawStatus {
    baseline: String,
    #[serde(default)]
    created: u64,
    #[serde(default)]
    documents: Option<IndexMap<String, RawDoc>>,
    #[serde(default)]
    implementation: Option<IndexMap<String, String>>,
}

#[derive(Deserialize)]
struct RawDoc {
    state: String,
    reason: Option<String>,
    #[serde(default)]
    via: Vec<String>,
}

fn q(s: &str) -> String {
    serde_json::to_string(s).unwrap()
}

impl Status {
    fn parse(text: &str) -> Result<Status> {
        let raw: RawStatus = serde_yaml::from_str(text)?;
        let mut documents = IndexMap::new();
        for (k, d) in raw.documents.unwrap_or_default() {
            let state = DocState::parse(&d.state).with_context(|| format!("{k}: unknown state `{}`", d.state))?;
            documents.insert(k, DocEntry { state, reason: d.reason, via: d.via });
        }
        let mut implementation = IndexMap::new();
        for (k, s) in raw.implementation.unwrap_or_default() {
            let done = match s.as_str() {
                "pending" => false,
                "done" => true,
                _ => bail!("{k}: unknown implementation state `{s}`"),
            };
            implementation.insert(k, done);
        }
        Ok(Status { baseline: raw.baseline, created: raw.created, documents, implementation })
    }

    fn to_yaml(&self) -> String {
        let mut s = format!("baseline: {}\ncreated: {}\n", q(&self.baseline), self.created);
        if self.documents.is_empty() {
            s.push_str("documents: {}\n");
        } else {
            s.push_str("documents:\n");
            for (k, d) in &self.documents {
                let mut fields = vec![format!("state: {}", d.state.as_str())];
                if let Some(r) = &d.reason {
                    fields.push(format!("reason: {}", q(r)));
                }
                if !d.via.is_empty() {
                    let v: Vec<String> = d.via.iter().map(|v| q(v)).collect();
                    fields.push(format!("via: [{}]", v.join(", ")));
                }
                s.push_str(&format!("  {}: {{{}}}\n", q(k), fields.join(", ")));
            }
        }
        if self.implementation.is_empty() {
            s.push_str("implementation: {}\n");
        } else {
            s.push_str("implementation:\n");
            for (k, done) in &self.implementation {
                s.push_str(&format!("  {}: {}\n", q(k), if *done { "done" } else { "pending" }));
            }
        }
        s
    }

    fn count(&self, state: DocState) -> usize {
        self.documents.values().filter(|d| d.state == state).count()
    }

    fn summary(&self) -> Value {
        json!({
            "pending": self.count(DocState::Pending),
            "affected": self.count(DocState::Affected),
            "updated": self.count(DocState::Updated),
            "no_change": self.count(DocState::NoChange),
            "implementation_pending": self.implementation.values().filter(|d| !**d).count(),
            "implementation_done": self.implementation.values().filter(|d| **d).count(),
        })
    }
}

pub struct Change {
    pub name: String,
    pub dir: PathBuf,
    pub status: Status,
}

impl Change {
    pub fn load(project: &Project, name: &str) -> Result<Change> {
        let dir = project.changes_dir().join(name);
        let file = dir.join("status.yaml");
        if !file.exists() {
            let open: Vec<String> = list_names(project)?;
            if open.is_empty() {
                bail!("no open change `{name}`; no changes are open");
            }
            bail!("no open change `{name}`; open changes: {}", open.join(", "));
        }
        let status = Status::parse(&fs::read_to_string(&file)?).with_context(|| format!("invalid {}", project.rel(&file)))?;
        Ok(Change { name: name.to_string(), dir, status })
    }

    pub fn save(&self) -> Result<()> {
        fs::write(self.dir.join("status.yaml"), self.status.to_yaml())?;
        Ok(())
    }

    pub fn change_md(&self, project: &Project) -> String {
        project.rel(&self.dir.join("change.md"))
    }

    /// Documents recorded as updated.
    pub fn updated(&self) -> Vec<&String> {
        self.status.documents.iter().filter(|(_, d)| d.state == DocState::Updated).map(|(k, _)| k).collect()
    }
}

fn list_names(project: &Project) -> Result<Vec<String>> {
    let dir = project.changes_dir();
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut out = vec![];
    for e in fs::read_dir(dir)? {
        let e = e?;
        if e.path().join("status.yaml").exists() {
            out.push(e.file_name().to_string_lossy().to_string());
        }
    }
    out.sort();
    Ok(out)
}

/// The starting content of `change.md` (docs/cli/change/usage.md).
pub const CHANGE_TEMPLATE: &str = "# <Title: the change in a few words>

## Why

<The problem, and who has it.>

## What changes

<The new behaviour, rule by rule: every case it touches, and what stays as it is. The constraints that apply.>

## Worked example

<One or more concrete scenarios, step by step, with real values: what the user does, what the product does, what it shows and stores. Before and after, where behaviour changes.>

## Out of scope

<What this change doesn't do.>
";

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

pub fn cmd_new(project: &Project, name: &str, out: &Out) -> Result<()> {
    if name.is_empty() || !name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') {
        bail!("change name must be kebab-case (lowercase letters, digits and -), e.g. refund-window");
    }
    let dir = project.changes_dir().join(name);
    if dir.exists() {
        bail!("change `{name}` already exists");
    }
    let baseline = git::head(&project.root)?;
    fs::create_dir_all(&dir)?;
    fs::write(dir.join("change.md"), CHANGE_TEMPLATE)?;
    let change = Change {
        name: name.to_string(),
        dir: dir.clone(),
        status: Status { baseline: baseline.clone(), created: now(), documents: IndexMap::new(), implementation: IndexMap::new() },
    };
    change.save()?;
    if out.json {
        return out.print(json!({ "change": name, "path": project.rel(&dir), "baseline": baseline }));
    }
    println!("Created {}/", project.rel(&dir));
    println!("  change.md     template");
    println!("  status.yaml   baseline {}", git::short(&baseline));
    Ok(())
}

pub fn cmd_list(project: &Project, out: &Out) -> Result<()> {
    let mut changes = vec![];
    for name in list_names(project)? {
        changes.push(Change::load(project, &name)?);
    }
    changes.sort_by(|a, b| a.status.created.cmp(&b.status.created).then(a.name.cmp(&b.name)));
    if out.json {
        let v: Vec<Value> = changes
            .iter()
            .map(|c| json!({ "change": c.name, "baseline": c.status.baseline, "created": c.status.created, "counts": c.status.summary() }))
            .collect();
        return out.print(json!({ "changes": v }));
    }
    if changes.is_empty() {
        println!("No open changes.");
        return Ok(());
    }
    let rows: Vec<(String, String)> = changes
        .iter()
        .map(|c| {
            let s = &c.status;
            let impl_pending = s.implementation.values().filter(|d| !**d).count();
            (
                c.name.clone(),
                format!(
                    "{} pending, {} affected, {} updated, {} no-change; {} to implement",
                    s.count(DocState::Pending),
                    s.count(DocState::Affected),
                    s.count(DocState::Updated),
                    s.count(DocState::NoChange),
                    impl_pending
                ),
            )
        })
        .collect();
    print!("{}", columns(&rows, ""));
    Ok(())
}

pub fn cmd_status(project: &Project, tree: &Tree, name: &str, out: &Out) -> Result<()> {
    let c = Change::load(project, name)?;
    let s = &c.status;
    let plans = Plans::load(project, &c, tree);
    let plan_state = |p: &crate::plans::Plan| if plans.done(p, &c) { "done" } else { "pending" };
    if out.json {
        let docs: Vec<Value> = s
            .documents
            .iter()
            .map(|(k, d)| json!({ "document": k, "path": project.spec_file(k), "state": d.state.as_str(), "reason": d.reason, "via": d.via }))
            .collect();
        let imp: Vec<Value> = s
            .implementation
            .iter()
            .map(|(k, d)| json!({ "node": k, "state": if *d { "done" } else { "pending" } }))
            .collect();
        let pl: Vec<Value> = plans
            .plans
            .iter()
            .map(|p| json!({ "plan": p.id, "path": p.path, "nodes": p.nodes, "after": p.after, "state": plan_state(p) }))
            .collect();
        return out.print(json!({ "change": name, "baseline": s.baseline, "documents": docs, "implementation": imp, "plans": pl }));
    }
    println!("change:    {name}");
    println!("baseline:  {}", git::short(&s.baseline));
    println!("documents:{}", if s.documents.is_empty() { "  none" } else { "" });
    let rows: Vec<(String, String)> = s
        .documents
        .iter()
        .map(|(k, d)| {
            let note = match (&d.reason, d.state) {
                (Some(r), _) => format!("  {r}"),
                (None, DocState::Pending) if !d.via.is_empty() => format!("  {}", d.via.join("; ")),
                _ => String::new(),
            };
            (k.clone(), format!("{}{note}", d.state.as_str()))
        })
        .collect();
    print!("{}", columns(&rows, "  "));
    println!("implementation:{}", if s.implementation.is_empty() { "  none" } else { "" });
    let rows: Vec<(String, String)> =
        s.implementation.iter().map(|(k, d)| (k.clone(), (if *d { "done" } else { "pending" }).to_string())).collect();
    print!("{}", columns(&rows, "  "));
    println!("plans:{}", if plans.plans.is_empty() { "  none" } else { "" });
    let rows: Vec<(String, String)> = plans
        .plans
        .iter()
        .map(|p| {
            let after = if p.after.is_empty() { String::new() } else { format!("; after {}", p.after.join(", ")) };
            (p.id.clone(), format!("{}  {}{after}", plan_state(p), p.nodes.join(", ")))
        })
        .collect();
    print!("{}", columns(&rows, "  "));
    Ok(())
}

/// What can be done now in a change.
pub struct Next {
    /// The impact step is due: the change has no documents and nothing to implement.
    pub impact: bool,
    /// Updated documents whose diffs the triage batch reads.
    pub diffs: Vec<String>,
    /// Pending candidates ready for triage, with the rules that reached them.
    pub batch: Vec<(String, Vec<String>)>,
    /// Affected documents ready to be written, by node: one writer per entry.
    pub write: Vec<(String, Vec<String>)>,
    /// Nodes to implement that no plan holds, once every document is settled.
    pub plan: Vec<String>,
    /// Plans ready to be implemented: id, path, nodes.
    pub implement: Vec<(String, String, Vec<String>)>,
    pub plans: Plans,
}

pub fn compute_next(project: &Project, change: &Change, tree: &Tree, types: &Types) -> Next {
    let g = Graph::new(tree, types);
    let docs = &change.status.documents;
    let unsettled: Vec<&String> = docs.iter().filter(|(_, d)| !d.state.settled()).map(|(k, _)| k).collect();
    let reach: HashMap<&String, HashSet<String>> = unsettled.iter().map(|k| (*k, g.reach(k))).collect();
    // Down the tree, a document waits only for its parent: not for a document of a higher ancestor.
    let higher_ancestor = |u: &str, key: &str| {
        let ancestors = tree.ancestors(&split_doc(key).0);
        let above_parent = &ancestors[..ancestors.len().saturating_sub(1)];
        above_parent.iter().any(|a| a.path == split_doc(u).0)
    };
    // A document is ready when no unsettled document can still reach it.
    let ready = |key: &String| {
        !unsettled.iter().any(|u| {
            *u != key
                && reach[u].contains(key)
                && !reach.get(key).is_some_and(|r| r.contains(*u))
                && !higher_ancestor(u, key)
        })
    };
    let batch: Vec<(String, Vec<String>)> = docs
        .iter()
        .filter(|(k, d)| d.state == DocState::Pending && ready(k))
        .map(|(k, d)| (k.clone(), d.via.clone()))
        .collect();
    // A node's ready affected documents are written together, by one writer.
    let mut write: IndexMap<String, Vec<String>> = IndexMap::new();
    for (k, _) in docs.iter().filter(|(k, d)| d.state == DocState::Affected && ready(k)) {
        let (node, _) = split_doc(k);
        write.entry(show_node(&node).to_string()).or_default().push(k.clone());
    }
    let write: Vec<(String, Vec<String>)> = write.into_iter().collect();
    let batch_keys: HashSet<&String> = batch.iter().map(|(k, _)| k).collect();
    let diffs: Vec<String> = if batch.is_empty() {
        vec![]
    } else {
        change.updated().into_iter().filter(|u| g.reach(u).iter().any(|r| batch_keys.contains(r))).cloned().collect()
    };
    let plans = Plans::load(project, change, tree);
    let mut plan = vec![];
    let mut implement = vec![];
    if unsettled.is_empty() {
        plan = plans.unplanned(change);
        if plan.is_empty() && plans.errors.is_empty() {
            implement = plans.ready(change, tree).into_iter().map(|p| (p.id.clone(), p.path.clone(), p.nodes.clone())).collect();
        }
    }
    let impact = docs.is_empty() && change.status.implementation.is_empty();
    Next { impact, diffs, batch, write, plan, implement, plans }
}

pub fn cmd_next(project: &Project, types: &Types, tree: &Tree, name: &str, out: &Out) -> Result<()> {
    let c = Change::load(project, name)?;
    let n = compute_next(project, &c, tree, types);
    let base = git::short(&c.status.baseline);
    if out.json {
        let read: Vec<Value> = std::iter::once(json!({ "path": c.change_md(project) }))
            .chain(n.diffs.iter().map(|d| json!({ "path": project.spec_file(d), "document": d, "diff_since": c.status.baseline })))
            .collect();
        let triage = if n.batch.is_empty() {
            Value::Null
        } else {
            json!({
                "read": read,
                "batch": n.batch.iter().map(|(k, via)| json!({ "document": k, "path": project.spec_file(k), "via": via })).collect::<Vec<_>>(),
            })
        };
        let impact = if n.impact { json!({ "read": [{ "path": c.change_md(project) }] }) } else { Value::Null };
        let plan = if n.plan.is_empty() { Value::Null } else { json!({ "dir": n.plans.dir, "nodes": n.plan }) };
        return out.print(json!({
            "change": name,
            "baseline": c.status.baseline,
            "impact": impact,
            "triage": triage,
            "write": n.write.iter().map(|(node, docs)| json!({
                "node": node,
                "documents": docs.iter().map(|k| json!({ "document": k, "path": project.spec_file(k) })).collect::<Vec<_>>(),
            })).collect::<Vec<_>>(),
            "plan": plan,
            "plan_errors": n.plans.errors.iter().map(|e| json!({ "plan": e.plan, "message": e.message })).collect::<Vec<_>>(),
            "implement": n.implement.iter().map(|(id, path, nodes)| json!({ "plan": id, "path": path, "nodes": nodes })).collect::<Vec<_>>(),
        }));
    }
    if n.impact {
        println!("impact:");
        println!("  read:");
        println!("    {}", c.change_md(project));
    } else {
        println!("impact:     none");
    }
    if n.batch.is_empty() {
        println!("triage:     none");
    } else {
        println!("triage:");
        println!("  read:");
        let mut rows = vec![(c.change_md(project), String::new())];
        rows.extend(n.diffs.iter().map(|d| (project.spec_file(d), format!("diff since {base}"))));
        print!("{}", columns(&rows, "    "));
        println!("  batch:");
        let rows: Vec<(String, String)> = n.batch.iter().map(|(k, via)| (project.spec_file(k), via.join("; "))).collect();
        print!("{}", columns(&rows, "    "));
    }
    if n.write.is_empty() {
        println!("write:      none");
    } else {
        println!("write:");
        for (node, docs) in &n.write {
            println!("  {node}");
            for k in docs {
                println!("    {}", project.spec_file(k));
            }
        }
    }
    if n.plan.is_empty() {
        println!("plan:       none");
    } else {
        println!("plan:");
        println!("  in: {}", n.plans.dir);
        println!("  nodes:");
        for k in &n.plan {
            println!("    {k}");
        }
    }
    if n.implement.is_empty() {
        println!("implement:  none");
    } else {
        println!("implement:");
        let rows: Vec<(String, String)> = n.implement.iter().map(|(id, path, _)| (id.clone(), path.clone())).collect();
        let lines = columns(&rows, "  ");
        for ((_, _, nodes), line) in n.implement.iter().zip(lines.lines()) {
            println!("{line}");
            for k in nodes {
                println!("    {k}");
            }
        }
    }
    if !n.plans.errors.is_empty() {
        println!("plan errors:");
        for e in &n.plans.errors {
            match &e.plan {
                Some(p) => println!("  {p}: {}", e.message),
                None => println!("  {}", e.message),
            }
        }
    }
    Ok(())
}

pub fn cmd_set(
    project: &Project,
    types: &Types,
    tree: &Tree,
    name: &str,
    item: &str,
    state: &str,
    reason: Option<String>,
    out: &Out,
) -> Result<()> {
    let mut c = Change::load(project, name)?;
    if state == "done" {
        let node = project.to_spec_rel(item);
        let key = show_node(&node).to_string();
        match c.status.implementation.get_mut(&key) {
            None => bail!("{key} isn't in the change's implementation list"),
            Some(done) => *done = true,
        }
        c.save()?;
        if out.json {
            return out.print(json!({ "change": name, "node": key, "state": "done" }));
        }
        println!("{key}: done");
        return Ok(());
    }
    let Some(new_state) = DocState::parse(state) else {
        bail!("unknown state `{state}`; use updated, affected, no-change or done");
    };
    let mut key = project.to_spec_rel(item);
    if !key.ends_with(".md") {
        key.push_str(".md");
    }
    if !tree.doc_exists(&key) {
        bail!("no document {}", project.spec_file(&key));
    }
    let current = c.status.documents.get(&key).map(|d| d.state);
    match new_state {
        DocState::Pending => bail!("`pending` is set by propagation, not by hand"),
        DocState::Affected | DocState::NoChange => {
            if reason.as_deref().is_none_or(|r| r.trim().is_empty()) {
                bail!("`{state}` needs --reason");
            }
            let open = current == Some(DocState::Pending) || current == Some(DocState::Affected);
            let starting = new_state == DocState::Affected && current.is_none();
            if !open && !starting {
                let cur = current.map_or("not in the change", |s| s.as_str());
                let allowed = if new_state == DocState::Affected { "a pending or affected document, or one not yet in the change," } else { "a pending or affected document" };
                bail!("{key} is {cur}; only {allowed} can be set to {state}");
            }
            // A document set to affected that wasn't in the change is a starting document.
            let e = c.status.documents.entry(key.clone()).or_insert(DocEntry { state: new_state, reason: None, via: vec!["change.md".into()] });
            e.state = new_state;
            e.reason = reason;
            c.save()?;
            if out.json {
                return out.print(json!({ "change": name, "document": key, "state": state }));
            }
            println!("{}: {state}", project.spec_file(&key));
            Ok(())
        }
        DocState::Updated => {
            let entry = c.status.documents.entry(key.clone()).or_insert(DocEntry { state: DocState::Updated, reason, via: vec![] });
            entry.state = DocState::Updated;
            let g = Graph::new(tree, types);
            let mut added: Vec<(String, String, bool)> = vec![];
            // A section changed when its text differs from the baseline's, or it exists in only one of them.
            let before = git::show(&project.root, &c.status.baseline, &project.spec_file(&key));
            let now = tree.read_doc(project, &key);
            let changed = |_: &str, anchor: &str| {
                let sec = |t: &Option<String>| t.as_deref().and_then(|t| sections::section(t, anchor));
                sec(&before) != sec(&now)
            };
            for (target, via) in g.direct_with(&key, &changed) {
                match c.status.documents.get_mut(&target) {
                    None => {
                        c.status.documents.insert(target.clone(), DocEntry { state: DocState::Pending, reason: None, via: vec![via.clone()] });
                        added.push((target, via, false));
                    }
                    Some(e) => {
                        let mut reopened = false;
                        if e.state.settled() {
                            e.state = DocState::Pending;
                            e.reason = None;
                            reopened = true;
                        }
                        if !e.via.contains(&via) {
                            e.via.push(via.clone());
                        }
                        added.push((target, via, !reopened));
                    }
                }
            }
            let (node, _) = split_doc(&key);
            let mut impl_added = None;
            if tree.has_code(types, &node) {
                let nk = show_node(&node).to_string();
                let e = c.status.implementation.entry(nk.clone()).or_insert(false);
                *e = false;
                impl_added = Some(nk);
            }
            c.save()?;
            if out.json {
                return out.print(json!({
                    "change": name,
                    "document": key,
                    "state": "updated",
                    "propagated": added.iter().map(|(t, via, already)| json!({ "document": t, "path": project.spec_file(t), "via": via, "already_in_change": already })).collect::<Vec<_>>(),
                    "implementation": impl_added,
                }));
            }
            println!("propagated from {}:{}", project.spec_file(&key), if added.is_empty() { " nothing" } else { "" });
            let rows: Vec<(String, String)> = added
                .iter()
                .map(|(t, via, already)| {
                    let mark = if *already { "~" } else { "+" };
                    let note = if *already { format!("{via} (already in the change)") } else { via.clone() };
                    (format!("{mark} {}", project.spec_file(t)), note)
                })
                .collect();
            print!("{}", columns(&rows, "  "));
            if let Some(n) = impl_added {
                println!("+ implementation: {n}");
            }
            Ok(())
        }
    }
}

pub fn cmd_close(project: &Project, types: &Types, tree: &Tree, name: &str, out: &Out) -> Result<()> {
    let c = Change::load(project, name)?;
    let s = &c.status;
    let open = s.count(DocState::Pending) + s.count(DocState::Affected);
    let impl_open = s.implementation.values().filter(|d| !**d).count();
    if open > 0 || impl_open > 0 {
        bail!(
            "change `{name}` isn't finished: {} pending, {} affected, {} nodes to implement",
            s.count(DocState::Pending),
            s.count(DocState::Affected),
            impl_open
        );
    }
    let issues = validate::validate(project, types, tree);
    if !issues.is_empty() {
        for i in &issues {
            eprintln!("error: {}: {}", i.path, i.message);
        }
        bail!("validate found {} errors; fix them before closing", issues.len());
    }
    // Every document of the change is settled, and every node done: record them as checked.
    let docs: Vec<String> = s.documents.keys().filter(|k| tree.doc_exists(k)).cloned().collect();
    let nodes: Vec<String> = s
        .implementation
        .keys()
        .map(|k| project.to_spec_rel(k))
        .filter(|n| tree.has_code(types, n) && tree.get(n).is_some_and(|n| !n.code.is_empty()))
        .collect();
    let recorded = drift::record(project, types, tree, &docs, &nodes)?;
    fs::remove_dir_all(&c.dir)?;
    let (checked, verified) = drift::recorded_json(project, &recorded);
    if out.json {
        return out.print(json!({ "change": name, "closed": true, "checked": checked, "verified": verified }));
    }
    println!("validate: ok");
    println!(
        "recorded .uspec/checks.yaml: {} documents checked, {} nodes verified",
        checked.len(),
        verified.len()
    );
    println!("removed {}/", project.rel(&c.dir));
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;
    use crate::{tree, types};

    fn copy_dir(from: &Path, to: &Path) {
        fs::create_dir_all(to).unwrap();
        for e in fs::read_dir(from).unwrap() {
            let e = e.unwrap();
            let dst = to.join(e.file_name());
            if e.path().is_dir() {
                copy_dir(&e.path(), &dst);
            } else {
                fs::copy(e.path(), dst).unwrap();
            }
        }
    }

    /// The pending documents `next` lists in its triage batch, for a change with these documents.
    fn batch(root: &Path, documents: &str) -> Vec<String> {
        let dir = root.join(".uspec/changes/c");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("change.md"), "# c\n").unwrap();
        fs::write(dir.join("status.yaml"), format!("baseline: \"0123456789abcdef\"\ncreated: 0\ndocuments:\n{documents}")).unwrap();
        let project = Project::open(root).unwrap();
        let types = types::load(&project);
        let tree = tree::load(&project, &types).unwrap();
        let change = Change::load(&project, "c").unwrap();
        compute_next(&project, &change, &tree, &types).batch.into_iter().map(|(k, _)| k).collect()
    }

    #[test]
    fn a_document_waits_only_for_its_parent() {
        let root = std::env::temp_dir().join(format!("uspec-change-unit-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        copy_dir(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples/example_product"), &root);
        let _ = fs::remove_dir_all(root.join(".uspec/changes"));
        const API: &str = "system/services/payments/api.md";
        // A pending grandparent document doesn't hold back the grandchild.
        let higher = batch(
            &root,
            &format!("  system/overview.md: {{state: pending}}\n  system/services/overview.md: {{state: no-change, reason: r}}\n  {API}: {{state: pending}}\n"),
        );
        // A pending parent document does.
        let parent = batch(&root, &format!("  system/services/overview.md: {{state: pending}}\n  {API}: {{state: pending}}\n"));
        let _ = fs::remove_dir_all(&root);
        assert!(higher.contains(&API.to_string()), "{higher:?}");
        assert!(higher.contains(&"system/overview.md".to_string()));
        assert!(!parent.contains(&API.to_string()), "{parent:?}");
        assert!(parent.contains(&"system/services/overview.md".to_string()));
    }
}
