//! Drift (docs/method/drift/rules.md): what changed since it was last checked. `.uspec/checks.yaml`
//! records, for each document, a hash of every upstream unit it was last checked against, and for each
//! node with code paths, a hash of its spec and of its code when its code was last verified. An item
//! drifts when what is there now differs from its record.

use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::Path;

use anyhow::{bail, Context, Result};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::change::Change;
use crate::git;
use crate::graph::Graph;
use crate::project::{show_node, Project};
use crate::sections;
use crate::tree::{doc_key, join, split_doc, Node, Tree};
use crate::types::Types;
use crate::Out;

const CHECKS: &str = ".uspec/checks.yaml";

const FNV_OFFSET: u64 = 0xcbf29ce484222325;
const FNV_PRIME: u64 = 0x100000001b3;

/// A running 64-bit FNV-1a hash.
struct Fnv(u64);

impl Fnv {
    fn new() -> Fnv {
        Fnv(FNV_OFFSET)
    }

    fn feed(&mut self, bytes: &[u8]) {
        for b in bytes {
            self.0 ^= u64::from(*b);
            self.0 = self.0.wrapping_mul(FNV_PRIME);
        }
    }

    fn hex(&self) -> String {
        format!("{:016x}", self.0)
    }
}

/// A hash of exact content: 16 lowercase hexadecimal digits.
pub fn hash(bytes: &[u8]) -> String {
    let mut h = Fnv::new();
    h.feed(bytes);
    h.hex()
}

/// The hash of a set of files, each given by its project-relative path and content, in path order. The
/// path and length are hashed with the content, so adding, removing or renaming a file changes it.
fn hash_files(files: &[(String, Vec<u8>)]) -> String {
    let mut h = Fnv::new();
    for (path, content) in files {
        h.feed(path.as_bytes());
        h.feed(b"\0");
        h.feed(&(content.len() as u64).to_le_bytes());
        h.feed(content);
    }
    h.hex()
}

/// What a node's code was last verified against.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct NodeCheck {
    pub spec: String,
    pub code: String,
}

/// The records file, `.uspec/checks.yaml`.
#[derive(Default, Debug, PartialEq)]
pub struct Checks {
    /// Document key → unit → hash of the unit when the document was last checked.
    pub documents: BTreeMap<String, BTreeMap<String, String>>,
    /// Node (`.` for the root) → its spec and code hashes when its code was last verified.
    pub nodes: BTreeMap<String, NodeCheck>,
}

#[derive(Deserialize)]
struct RawChecks {
    #[serde(default)]
    documents: Option<BTreeMap<String, Option<BTreeMap<String, String>>>>,
    #[serde(default)]
    nodes: Option<BTreeMap<String, NodeCheck>>,
}

/// A key or hash as YAML: plain when YAML reads it back as the same string, JSON-quoted otherwise. A
/// string that reads as a number is quoted too, since some YAML readers take `1e10…` for one.
fn scalar(s: &str) -> String {
    let plain = !s.is_empty()
        && s.trim() == s
        && s.parse::<f64>().is_err()
        && !s.contains(['\n', '\r', '\t', '"', '\''])
        && matches!(serde_yaml::from_str::<serde_yaml::Value>(s), Ok(serde_yaml::Value::String(v)) if v == s);
    if plain {
        s.to_string()
    } else {
        serde_json::to_string(s).unwrap()
    }
}

impl Checks {
    fn parse(text: &str) -> Result<Checks> {
        let raw: Option<RawChecks> = serde_yaml::from_str(text)?;
        let Some(raw) = raw else { return Ok(Checks::default()) };
        Ok(Checks {
            documents: raw.documents.unwrap_or_default().into_iter().map(|(k, u)| (k, u.unwrap_or_default())).collect(),
            nodes: raw.nodes.unwrap_or_default(),
        })
    }

    /// Reads `.uspec/checks.yaml`; a missing file means no records.
    pub fn load(project: &Project) -> Result<Checks> {
        let path = project.root.join(CHECKS);
        if !path.exists() {
            return Ok(Checks::default());
        }
        let text = fs::read_to_string(&path).with_context(|| format!("invalid {CHECKS}"))?;
        Checks::parse(&text).with_context(|| format!("invalid {CHECKS}"))
    }

    /// One line per document–unit pair and per node, sorted by path.
    fn to_yaml(&self) -> String {
        let mut s = String::new();
        if self.documents.is_empty() {
            s.push_str("documents: {}\n");
        } else {
            s.push_str("documents:\n");
            for (k, units) in &self.documents {
                if units.is_empty() {
                    s.push_str(&format!("  {}: {{}}\n", scalar(k)));
                    continue;
                }
                s.push_str(&format!("  {}:\n", scalar(k)));
                for (u, h) in units {
                    s.push_str(&format!("    {}: {}\n", scalar(u), scalar(h)));
                }
            }
        }
        if self.nodes.is_empty() {
            s.push_str("nodes: {}\n");
        } else {
            s.push_str("nodes:\n");
            for (k, n) in &self.nodes {
                s.push_str(&format!("  {}: {{spec: {}, code: {}}}\n", scalar(k), scalar(&n.spec), scalar(&n.code)));
            }
        }
        s
    }

    /// Writes `<root>/.uspec/checks.yaml`.
    pub fn save(&self, root: &Path) -> Result<()> {
        fs::write(root.join(CHECKS), self.to_yaml())?;
        Ok(())
    }
}

/// Current hashes, each computed once per run.
struct Hashes<'a> {
    project: &'a Project,
    graph: Graph<'a>,
    units: RefCell<HashMap<String, Option<String>>>,
}

impl<'a> Hashes<'a> {
    fn new(project: &'a Project, types: &'a Types, tree: &'a Tree) -> Self {
        Hashes { project, graph: Graph::new(tree, types), units: RefCell::new(HashMap::new()) }
    }

    /// A unit's current hash: of the document's file, or of the section's text. `None` when the
    /// document or the section is missing.
    fn unit(&self, unit: &str) -> Option<String> {
        if let Some(h) = self.units.borrow().get(unit) {
            return h.clone();
        }
        let file = |k: &str| self.project.spec_dir().join(k);
        let h = match unit.split_once('#') {
            None => fs::read(file(unit)).ok().map(|b| hash(&b)),
            Some((k, anchor)) => fs::read_to_string(file(k)).ok().and_then(|t| sections::section(&t, anchor)).map(|s| hash(s.as_bytes())),
        };
        self.units.borrow_mut().insert(unit.to_string(), h.clone());
        h
    }

    /// The document's current upstream units that have a current value, with their hashes.
    fn doc_record(&self, key: &str) -> BTreeMap<String, String> {
        self.graph.upstream(key).into_iter().filter_map(|u| self.unit(&u).map(|h| (u, h))).collect()
    }

    /// The node's current spec and code hashes.
    fn node_record(&self, node: &Node) -> NodeCheck {
        let root = &self.project.root;
        let mut spec: Vec<String> = vec![];
        if node.has_node_yaml {
            spec.push(self.project.spec_file(&join(&node.path, "node.yaml")));
        }
        spec.extend(node.docs.iter().map(|d| self.project.spec_file(&doc_key(&node.path, d))));
        for d in &node.extras {
            let dir = self.project.spec_dir().join(join(&node.path, &format!("{d}-extra")));
            files_under(&dir, &mut |p| spec.push(self.project.rel(p)));
        }
        let code: Vec<String> = git::files(root, &node.code)
            .into_iter()
            .filter(|p| fs::symlink_metadata(root.join(p)).is_ok_and(|m| m.is_file()))
            .collect();
        NodeCheck { spec: self.hash_paths(spec), code: self.hash_paths(code) }
    }

    /// The hash of a set of project-relative files, read from disk.
    fn hash_paths(&self, mut paths: Vec<String>) -> String {
        paths.sort();
        paths.dedup();
        let files: Vec<(String, Vec<u8>)> = paths
            .into_iter()
            .filter_map(|p| fs::read(self.project.root.join(&p)).ok().map(|c| (p, c)))
            .collect();
        hash_files(&files)
    }
}

/// Every file under `dir`, recursively.
fn files_under(dir: &Path, f: &mut dyn FnMut(&Path)) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            files_under(&p, f);
        } else if p.is_file() {
            f(&p);
        }
    }
}

/// An item drift is checked for: a node with code paths (by path, "" for the root), or a document (by key).
#[derive(Clone, PartialEq, Eq, Hash)]
pub enum Item {
    Node(String),
    Doc(String),
}

/// Every item in tree order: each node with code paths, then its documents in its type's order.
fn items(types: &Types, tree: &Tree) -> Vec<Item> {
    let mut out = vec![];
    for n in tree.nodes.values() {
        if has_code_paths(types, tree, &n.path) {
            out.push(Item::Node(n.path.clone()));
        }
        out.extend(n.docs.iter().map(|d| Item::Doc(doc_key(&n.path, d))));
    }
    out
}

fn has_code_paths(types: &Types, tree: &Tree, path: &str) -> bool {
    tree.has_code(types, path) && tree.get(path).is_some_and(|n| !n.code.is_empty())
}

struct Drift {
    kind: &'static str,
    /// The node, or the document's node.
    node: String,
    document: Option<String>,
    unit: Option<String>,
    reason: String,
}

/// Finds every item not in an open change that changed since it was last checked.
pub fn cmd_drift(project: &Project, types: &Types, tree: &Tree, out: &Out) -> Result<()> {
    let checks = Checks::load(project)?;
    let mut skip_docs: HashSet<String> = HashSet::new();
    let mut skip_nodes: HashSet<String> = HashSet::new();
    if let Ok(rd) = fs::read_dir(project.changes_dir()) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if let Ok(c) = Change::load(project, &name) {
                skip_docs.extend(c.status.documents.keys().cloned());
                skip_nodes.extend(c.status.implementation.keys().cloned());
            }
        }
    }
    let hashes = Hashes::new(project, types, tree);
    let mut drift: Vec<Drift> = vec![];
    for item in items(types, tree) {
        match item {
            Item::Node(path) => {
                let node = show_node(&path).to_string();
                if skip_nodes.contains(&node) {
                    continue;
                }
                let mut push = |kind, reason: &str| {
                    drift.push(Drift { kind, node: node.clone(), document: None, unit: None, reason: reason.into() })
                };
                let now = hashes.node_record(&tree.nodes[&path]);
                match checks.nodes.get(&node) {
                    None => push("code", "never checked"),
                    Some(rec) => {
                        if rec.code != now.code {
                            push("code", "code changed since it was last verified");
                        }
                        if rec.spec != now.spec {
                            push("spec", "spec changed since its code was last verified");
                        }
                    }
                }
            }
            Item::Doc(key) => {
                if skip_docs.contains(&key) {
                    continue;
                }
                let node = show_node(&split_doc(&key).0).to_string();
                let mut push = |unit: Option<&str>, reason: String| {
                    drift.push(Drift { kind: "dependency", node: node.clone(), document: Some(key.clone()), unit: unit.map(str::to_string), reason })
                };
                let Some(rec) = checks.documents.get(&key) else {
                    push(None, "never checked".into());
                    continue;
                };
                let now = hashes.doc_record(&key);
                let units: BTreeSet<&String> = rec.keys().chain(now.keys()).collect();
                for u in units {
                    let what = match (rec.get(u), now.get(u)) {
                        (Some(a), Some(b)) if a != b => "changed",
                        (None, Some(_)) => "added",
                        (Some(_), None) => "removed",
                        _ => continue,
                    };
                    push(Some(u), format!("{u} {what} since it was last checked"));
                }
            }
        }
    }
    if out.json {
        let v: Vec<Value> = drift
            .iter()
            .map(|d| {
                json!({
                    "kind": d.kind,
                    "node": d.node,
                    "document": d.document,
                    "path": d.document.as_deref().map(|k| project.spec_file(k)),
                    "unit": d.unit,
                    "reason": d.reason,
                })
            })
            .collect();
        out.print(json!({ "drift": v }))?;
    } else if drift.is_empty() {
        println!("No drift: everything matches what it was last checked against.");
    } else {
        for d in &drift {
            println!("{}: {}", d.document.as_deref().unwrap_or(&d.node), d.reason);
        }
    }
    if !drift.is_empty() {
        std::process::exit(1);
    }
    Ok(())
}

/// Records the given documents (by key) and nodes (by path, "" for the root) as checked, as they are
/// now, keeping every other record, and writes `.uspec/checks.yaml`. Returns the items recorded, in tree
/// order.
pub fn record(project: &Project, types: &Types, tree: &Tree, docs: &[String], nodes: &[String]) -> Result<Vec<Item>> {
    let mut checks = Checks::load(project)?;
    let hashes = Hashes::new(project, types, tree);
    let wanted: HashSet<Item> =
        docs.iter().map(|d| Item::Doc(d.clone())).chain(nodes.iter().map(|n| Item::Node(n.clone()))).collect();
    let recorded: Vec<Item> = items(types, tree).into_iter().filter(|i| wanted.contains(i)).collect();
    for item in &recorded {
        match item {
            Item::Doc(key) => {
                checks.documents.insert(key.clone(), hashes.doc_record(key));
            }
            Item::Node(path) => {
                checks.nodes.insert(show_node(path).to_string(), hashes.node_record(&tree.nodes[path]));
            }
        }
    }
    checks.save(&project.root)?;
    Ok(recorded)
}

/// The recorded items as JSON: `checked` documents and `verified` nodes.
pub fn recorded_json(project: &Project, recorded: &[Item]) -> (Vec<Value>, Vec<Value>) {
    let mut checked = vec![];
    let mut verified = vec![];
    for item in recorded {
        match item {
            Item::Doc(k) => checked.push(json!({ "document": k, "path": project.spec_file(k) })),
            Item::Node(n) => verified.push(json!({ "node": show_node(n) })),
        }
    }
    (checked, verified)
}

/// Records documents or nodes as checked, as they are now; every item without arguments.
pub fn cmd_accept(project: &Project, types: &Types, tree: &Tree, args: &[String], out: &Out) -> Result<()> {
    let mut docs = vec![];
    let mut nodes = vec![];
    if args.is_empty() {
        for item in items(types, tree) {
            match item {
                Item::Doc(k) => docs.push(k),
                Item::Node(n) => nodes.push(n),
            }
        }
    }
    for arg in args {
        let k = project.to_spec_rel(arg);
        if k.ends_with(".md") && tree.doc_exists(&k) {
            docs.push(k);
        } else if has_code_paths(types, tree, &k) {
            nodes.push(k);
        } else {
            bail!("{arg} is neither a document nor a node with code paths");
        }
    }
    let recorded = record(project, types, tree, &docs, &nodes)?;
    if out.json {
        let (checked, verified) = recorded_json(project, &recorded);
        return out.print(json!({ "checked": checked, "verified": verified }));
    }
    for item in &recorded {
        match item {
            Item::Node(n) => println!("verified: {}", show_node(n)),
            Item::Doc(k) => println!("checked: {k}"),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fnv_vectors() {
        assert_eq!(hash(b""), "cbf29ce484222325");
        assert_eq!(hash(b"a"), "af63dc4c8601ec8c");
    }

    #[test]
    fn file_sets_cover_paths() {
        let a = hash_files(&[("src/a.rs".into(), b"x".to_vec())]);
        let renamed = hash_files(&[("src/b.rs".into(), b"x".to_vec())]);
        let added = hash_files(&[("src/a.rs".into(), b"x".to_vec()), ("src/b.rs".into(), vec![])]);
        assert_ne!(a, renamed);
        assert_ne!(a, added);
        assert_eq!(hash_files(&[]), hash(b""));
    }

    #[test]
    fn checks_round_trip() {
        let mut c = Checks::default();
        c.documents.insert("overview.md".into(), BTreeMap::new());
        c.documents.insert(
            "b/states.md".into(),
            BTreeMap::from([
                ("a/rules.md#refund-window".to_string(), "1234567890123456".to_string()),
                ("overview.md".to_string(), "1e10000000000000".to_string()),
            ]),
        );
        c.documents.insert("x: y/#a.md".into(), BTreeMap::from([("true".to_string(), "00000000000000ff".to_string())]));
        c.nodes.insert(".".into(), NodeCheck { spec: "0123456789abcdef".into(), code: "1e10000000000000".into() });
        c.nodes.insert("cli/drift".into(), NodeCheck { spec: "af63dc4c8601ec8c".into(), code: "9999999999999999".into() });
        let text = c.to_yaml();
        assert_eq!(Checks::parse(&text).unwrap(), c);
        assert_eq!(
            text,
            "documents:\n  b/states.md:\n    a/rules.md#refund-window: \"1234567890123456\"\n    overview.md: \"1e10000000000000\"\n  overview.md: {}\n  \"x: y/#a.md\":\n    \"true\": 00000000000000ff\n\
             nodes:\n  .: {spec: 0123456789abcdef, code: \"1e10000000000000\"}\n  cli/drift: {spec: af63dc4c8601ec8c, code: \"9999999999999999\"}\n"
        );
        assert_eq!(Checks::default().to_yaml(), "documents: {}\nnodes: {}\n");
    }

    #[test]
    fn loads_empty_records() {
        for text in ["", "{}", "documents: {}", "nodes:\n", "documents: {}\nnodes: {}\n"] {
            assert_eq!(Checks::parse(text).unwrap(), Checks::default(), "{text:?}");
        }
        assert!(Checks::parse("documents: [").is_err());
        assert!(Checks::parse("documents: [a]").is_err());
    }
}
