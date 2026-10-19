use std::collections::{HashSet, VecDeque};

use crate::project::show_node;
use crate::tree::{doc_key, split_doc, Tree};
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

    /// Documents an update to `key` reaches directly, each with the rule that reached it.
    pub fn direct(&self, key: &str) -> Vec<(String, String)> {
        let (node_path, id) = split_doc(key);
        let Some(node) = self.tree.get(&node_path) else { return vec![] };
        let type_id = node.type_id.as_deref().unwrap_or("");
        let mut out: Vec<(String, String)> = vec![];
        let mut push = |k: String, via: String| {
            if k != key && !out.iter().any(|(o, _)| *o == k) {
                out.push((k, via));
            }
        };
        // The node's own documents that derive from the updated one.
        for d in &node.docs {
            if self.types.template(type_id, d).is_some_and(|t| t.derives_from.contains(&id)) {
                push(doc_key(&node_path, d), format!("derives from {id}.md"));
            }
        }
        // The node's descendants.
        for m in self.tree.descendants(&node_path) {
            for d in &m.docs {
                push(doc_key(&m.path, d), format!("descendant of {}", show_node(&node_path)));
            }
        }
        // Every document of the nodes that link to it, if the document is exposed.
        if self.types.template(type_id, &id).is_none_or(|t| t.exposed) {
            for l in self.tree.linkers(&node_path) {
                for d in &l.docs {
                    push(doc_key(&l.path, d), format!("links to {}", show_node(&node_path)));
                }
            }
        }
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
