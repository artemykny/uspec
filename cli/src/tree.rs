use std::fs;
use std::path::Path;

use anyhow::{bail, Result};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

use crate::project::{show_node, Project};
use crate::types::Types;

#[derive(Deserialize, Serialize, Default)]
pub struct NodeYaml {
    #[serde(rename = "type")]
    pub type_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub derives_from: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub code: Vec<String>,
}

impl NodeYaml {
    pub fn to_yaml(&self) -> String {
        let mut s = format!("type: {}\n", self.type_id.as_deref().unwrap_or(""));
        if !self.derives_from.is_empty() {
            s.push_str("derives_from:\n");
            for l in &self.derives_from {
                s.push_str(&format!("  - {l}\n"));
            }
        }
        if !self.code.is_empty() {
            s.push_str("code:\n");
            for c in &self.code {
                s.push_str(&format!("  - {c}\n"));
            }
        }
        s
    }
}

pub struct Node {
    /// Path relative to the spec root; "" for the root.
    pub path: String,
    pub has_node_yaml: bool,
    pub yaml_error: Option<String>,
    pub type_id: Option<String>,
    pub links: Vec<String>,
    pub code: Vec<String>,
    /// Ids of the documents present in the node, in the type's order.
    pub docs: Vec<String>,
    /// Document ids that have an `-extra` folder.
    pub extras: Vec<String>,
    /// Files that are neither node.yaml nor a declared document.
    pub stray_files: Vec<String>,
    pub children: Vec<String>,
    pub parent: Option<String>,
}

pub struct Tree {
    /// Nodes in depth-first order, the root first.
    pub nodes: IndexMap<String, Node>,
}

pub fn join(node: &str, name: &str) -> String {
    if node.is_empty() {
        name.to_string()
    } else {
        format!("{node}/{name}")
    }
}

/// A document's key: its path relative to the spec root, e.g. `system/services/payments/api.md`.
pub fn doc_key(node: &str, id: &str) -> String {
    join(node, &format!("{id}.md"))
}

/// Splits a document key into its node path and document id.
pub fn split_doc(key: &str) -> (String, String) {
    let key = key.strip_suffix(".md").unwrap_or(key);
    match key.rsplit_once('/') {
        Some((n, id)) => (n.to_string(), id.to_string()),
        None => (String::new(), key.to_string()),
    }
}

pub fn load(project: &Project, types: &Types) -> Result<Tree> {
    let dir = project.spec_dir();
    if !dir.join("node.yaml").exists() && !dir.is_dir() {
        bail!("spec root {} does not exist", project.rel(&dir));
    }
    let mut tree = Tree { nodes: IndexMap::new() };
    visit(&mut tree, types, &dir, String::new(), None)?;
    Ok(tree)
}

fn visit(tree: &mut Tree, types: &Types, dir: &Path, path: String, parent: Option<String>) -> Result<()> {
    let yaml_path = dir.join("node.yaml");
    let mut node = Node {
        path: path.clone(),
        has_node_yaml: yaml_path.exists(),
        yaml_error: None,
        type_id: None,
        links: vec![],
        code: vec![],
        docs: vec![],
        extras: vec![],
        stray_files: vec![],
        children: vec![],
        parent,
    };
    if node.has_node_yaml {
        match serde_yaml::from_str::<Option<NodeYaml>>(&fs::read_to_string(&yaml_path)?) {
            Ok(y) => {
                let y = y.unwrap_or_default();
                node.type_id = y.type_id;
                node.links = y.derives_from.iter().map(|l| l.trim_end_matches('/').to_string()).collect();
                node.code = y.code;
            }
            Err(e) => node.yaml_error = Some(e.to_string()),
        }
    }
    let declared: Vec<String> = node
        .type_id
        .as_deref()
        .and_then(|t| types.get(t))
        .map(|t| t.documents.clone())
        .unwrap_or_default();

    let mut entries: Vec<_> = fs::read_dir(dir)?.filter_map(|e| e.ok()).collect();
    entries.sort_by_key(|e| e.file_name());
    let mut present = vec![];
    let mut child_dirs = vec![];
    for entry in entries {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let p = entry.path();
        if p.is_dir() {
            match name.strip_suffix("-extra") {
                Some(doc) if declared.iter().any(|d| d == doc) => node.extras.push(doc.to_string()),
                _ => child_dirs.push((name, p)),
            }
        } else if name == "node.yaml" {
            continue;
        } else if let Some(stem) = name.strip_suffix(".md").filter(|s| declared.iter().any(|d| d == s)) {
            present.push(stem.to_string());
        } else {
            node.stray_files.push(name);
        }
    }
    node.docs = declared.into_iter().filter(|d| present.contains(d)).collect();
    node.children = child_dirs.iter().map(|(n, _)| join(&path, n)).collect();
    tree.nodes.insert(path.clone(), node);
    for (name, p) in child_dirs {
        visit(tree, types, &p, join(&path, &name), Some(path.clone()))?;
    }
    Ok(())
}

impl Tree {
    pub fn get(&self, path: &str) -> Option<&Node> {
        self.nodes.get(path)
    }

    pub fn node(&self, path: &str) -> Result<&Node> {
        match self.nodes.get(path) {
            Some(n) => Ok(n),
            None => bail!("no node at {}", show_node(path)),
        }
    }

    /// Ancestors of a node, the root first.
    pub fn ancestors(&self, path: &str) -> Vec<&Node> {
        let mut out = vec![];
        let mut cur = self.nodes.get(path).and_then(|n| n.parent.clone());
        while let Some(p) = cur {
            let n = &self.nodes[&p];
            cur = n.parent.clone();
            out.push(n);
        }
        out.reverse();
        out
    }

    /// Descendants of a node in depth-first order, without the node itself.
    pub fn descendants(&self, path: &str) -> Vec<&Node> {
        self.nodes
            .values()
            .filter(|n| is_under(&n.path, path) && n.path != path)
            .collect()
    }

    /// Nodes that link to `path`.
    pub fn linkers(&self, path: &str) -> Vec<&Node> {
        self.nodes.values().filter(|n| n.links.iter().any(|l| l == path)).collect()
    }

    pub fn doc_exists(&self, key: &str) -> bool {
        let (node, id) = split_doc(key);
        self.nodes.get(&node).is_some_and(|n| n.docs.contains(&id))
    }

    pub fn has_code(&self, types: &Types, path: &str) -> bool {
        self.nodes
            .get(path)
            .and_then(|n| n.type_id.as_deref())
            .and_then(|t| types.get(t))
            .is_some_and(|t| t.code)
    }
}

/// Whether `path` is `root` or inside it.
pub fn is_under(path: &str, root: &str) -> bool {
    root.is_empty() || path == root || path.starts_with(&format!("{root}/"))
}
