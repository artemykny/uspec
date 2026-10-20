use std::collections::{HashSet, VecDeque};

use crate::project::show_node;
use crate::sections::split_ref;
use crate::tree::{doc_key, split_doc, Link, Tree};
use crate::types::Types;

/// How a change to one document reaches others (docs/method/changes/rules.md).
pub struct Graph<'a> {
    pub tree: &'a Tree,
    pub types: &'a Types,
}

impl<'a> Graph<'a> {
    pub fn new(tree: &'a Tree, types: &'a Types) -> Self {
        Graph { tree, types }
    }

    /// Documents an update to `key` reaches directly, each with the rule that reached it, when every
    /// section it depends on may have changed.
    pub fn direct(&self, key: &str) -> Vec<(String, String)> {
        self.direct_with(key, &|_, _| true)
    }

    /// Documents an update to `key` reaches directly, each with the rule that reached it. A dependency
    /// on a section of `key` reaches only when `changed(key, anchor)` says the section changed. The
    /// inverse of `upstream`: keep the two in step.
    pub fn direct_with(&self, key: &str, changed: &dyn Fn(&str, &str) -> bool) -> Vec<(String, String)> {
        let (node_path, id) = split_doc(key);
        let Some(node) = self.tree.get(&node_path) else { return vec![] };
        let type_id = node.type_id.as_deref().unwrap_or("");
        let mut out: Vec<(String, String)> = vec![];
        let mut push = |k: String, via: String| {
            if k != key && !out.iter().any(|(o, _)| *o == k) {
                out.push((k, via));
            }
        };
        // The node's own documents that derive from the updated one, or from a section of it that changed.
        for d in &node.docs {
            let Some(t) = self.types.template(type_id, d) else { continue };
            let via = t.derives_from.iter().find_map(|dep| match split_ref(dep) {
                (did, None) if did == id => Some(format!("derives from {id}.md")),
                (did, Some(s)) if did == id && changed(key, s) => Some(format!("derives from {id}.md#{s}")),
                _ => None,
            });
            if let Some(via) = via {
                push(doc_key(&node_path, d), via);
            }
        }
        // The node's descendants.
        for m in self.tree.descendants(&node_path) {
            for d in &m.docs {
                push(doc_key(&m.path, d), format!("descendant of {}", show_node(&node_path)));
            }
        }
        // Every document of the nodes that link to it: to the node if the document is exposed, to the
        // document itself, or to a section of it that changed.
        if self.types.template(type_id, &id).is_none_or(|t| t.exposed) {
            for l in self.tree.linkers(&node_path) {
                let via = l.deps.iter().filter(|dep| dep.node == node_path).find_map(|dep| reaches(dep, &id, key, changed));
                if let Some(via) = via {
                    for d in &l.docs {
                        push(doc_key(&l.path, d), via.clone());
                    }
                }
            }
        }
        out
    }

    /// The units whose update reaches document `key` directly, when every section may have changed: the
    /// inverse of `direct_with`. A unit is a document key, or `<key>#<anchor>` for a section; the list is
    /// sorted and never holds `key` itself.
    pub fn upstream(&self, key: &str) -> Vec<String> {
        let (node_path, id) = split_doc(key);
        let Some(node) = self.tree.get(&node_path) else { return vec![] };
        let type_id = node.type_id.as_deref().unwrap_or("");
        let exposed = |n: &crate::tree::Node, d: &str| {
            n.docs.iter().any(|x| x == d) && self.types.template(n.type_id.as_deref().unwrap_or(""), d).is_none_or(|t| t.exposed)
        };
        let mut out: Vec<String> = vec![];
        // The node's own documents it derives from, or sections of them.
        if let Some(t) = self.types.template(type_id, &id) {
            for dep in &t.derives_from {
                let (did, s) = split_ref(dep);
                if node.docs.iter().any(|d| d == did) {
                    let k = doc_key(&node_path, did);
                    out.push(match s {
                        Some(s) => format!("{k}#{s}"),
                        None => k,
                    });
                }
            }
        }
        // Every document of the node's ancestors.
        for a in self.tree.ancestors(&node_path) {
            out.extend(a.docs.iter().map(|d| doc_key(&a.path, d)));
        }
        // The exposed documents of the nodes it links to: all of them for a node link, else the one
        // document or section linked to.
        for dep in &node.deps {
            let Some(target) = self.tree.get(&dep.node) else { continue };
            match (dep.doc.as_deref(), dep.section.as_deref()) {
                (None, _) => {
                    out.extend(target.docs.iter().filter(|d| exposed(target, d)).map(|d| doc_key(&target.path, d)));
                }
                (Some(d), None) if exposed(target, d) => out.push(doc_key(&target.path, d)),
                (Some(d), Some(s)) if exposed(target, d) => out.push(format!("{}#{s}", doc_key(&target.path, d))),
                _ => {}
            }
        }
        out.retain(|u| u != key);
        out.sort();
        out.dedup();
        out
    }

    /// Every document an update to `key` can reach, directly or through other updates.
    pub fn reach(&self, key: &str) -> HashSet<String> {
        let mut seen = HashSet::new();
        let mut queue = VecDeque::from([key.to_string()]);
        while let Some(k) = queue.pop_front() {
            for (t, _) in self.direct(&k) {
                if seen.insert(t.clone()) {
                    queue.push_back(t);
                }
            }
        }
        seen.remove(key);
        seen
    }
}

/// The rule by which an update to document `id` (key `key`) of a link's node reaches the linking node.
fn reaches(dep: &Link, id: &str, key: &str, changed: &dyn Fn(&str, &str) -> bool) -> Option<String> {
    match (dep.doc.as_deref(), dep.section.as_deref()) {
        (None, _) => Some(format!("links to {}", show_node(&dep.node))),
        (Some(d), None) if d == id => Some(format!("links to {}", Link::format(&dep.node, Some(d), None))),
        (Some(d), Some(s)) if d == id && changed(key, s) => Some(format!("links to {}", Link::format(&dep.node, Some(d), Some(s)))),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;
    use crate::project::Project;
    use crate::{tree, types};

    #[test]
    fn upstream_inverts_direct() {
        let project = Project::open(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples/example_product")).unwrap();
        let types = types::load(&project);
        let tree = tree::load(&project, &types).unwrap();
        let g = Graph::new(&tree, &types);
        let keys: Vec<String> = tree.nodes.values().flat_map(|n| n.docs.iter().map(|d| doc_key(&n.path, d))).collect();
        let doc_of = |u: &str| u.split_once('#').map_or(u, |(d, _)| d).to_string();
        for k in &keys {
            for (d, _) in g.direct(k) {
                assert!(g.upstream(&d).iter().any(|u| doc_of(u) == *k), "{k} reaches {d}, but isn't upstream of it");
            }
        }
        for d in &keys {
            let up = g.upstream(d);
            assert!(!up.contains(d));
            for u in up {
                assert!(g.direct(&doc_of(&u)).iter().any(|(t, _)| t == d), "{u} is upstream of {d}, but doesn't reach it");
            }
        }
        assert!(g
            .upstream("experience/ops-console/refunds/states.md")
            .contains(&"product/support/refunds/rules.md#refund-window".to_string()));
    }
}
