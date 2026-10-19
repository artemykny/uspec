use std::collections::{HashMap, HashSet};

use crate::project::{show_node, Project};
use crate::sections::{self, split_ref};
use crate::tree::{doc_key, Link, Tree};
use crate::types::Types;
use crate::Issue;

/// Checks every rule in docs/method/node-types/rules.md.
pub fn validate(project: &Project, types: &Types, tree: &Tree) -> Vec<Issue> {
    let mut out: Vec<Issue> = types.errors.clone();
    check_types(project, types, &mut out);
    check_nodes(project, types, tree, &mut out);
    out
}

fn check_types(project: &Project, types: &Types, out: &mut Vec<Issue>) {
    for t in types.map.values() {
        let rel = project.rel(&project.types_dir().join(&t.id).join("node-type.yaml"));
        for c in &t.children {
            if types.get(c).is_none() {
                out.push(Issue::new(rel.clone(), format!("`children` references unknown type `{c}`")));
            }
        }
        for d in &t.derives_from {
            if types.get(d).is_none() {
                out.push(Issue::new(rel.clone(), format!("`derives_from` references unknown type `{d}`")));
            }
        }
        for (doc, tpl) in &t.templates {
            for dep in &tpl.derives_from {
                let (dep, _) = split_ref(dep);
                if !t.documents.iter().any(|d| d == dep) {
                    out.push(Issue::new(
                        project.rel(&project.types_dir().join(&t.id).join(format!("{doc}.md"))),
                        format!("`derives_from` references document `{dep}`, which type `{}` doesn't declare", t.id),
                    ));
                }
            }
        }
        let doc_edges: HashMap<String, Vec<String>> = t
            .templates
            .iter()
            .map(|(d, tpl)| (d.clone(), tpl.derives_from.iter().map(|r| split_ref(r).0.to_string()).collect()))
            .collect();
        if let Some(cycle) = find_cycle(&doc_edges) {
            out.push(Issue::new(rel.clone(), format!("document dependencies form a cycle: {}", cycle.join(" → "))));
        }
    }
    let child_edges: HashMap<String, Vec<String>> = types
        .map
        .values()
        .map(|t| (t.id.clone(), t.children.iter().filter(|c| **c != t.id).cloned().collect()))
        .collect();
    if let Some(cycle) = find_cycle(&child_edges) {
        out.push(Issue::new(
            project.rel(&project.types_dir()),
            format!("types form a cycle through `children`: {}", cycle.join(" → ")),
        ));
    }
}

fn check_nodes(project: &Project, types: &Types, tree: &Tree, out: &mut Vec<Issue>) {
    for node in tree.nodes.values() {
        let at = project.spec_file(&node.path);
        if !node.has_node_yaml {
            out.push(Issue::new(at, "node has no node.yaml"));
            continue;
        }
        if let Some(e) = &node.yaml_error {
            out.push(Issue::new(format!("{at}node.yaml"), format!("invalid YAML: {e}")));
            continue;
        }
        let Some(type_id) = node.type_id.as_deref() else {
            out.push(Issue::new(at, "node.yaml has no `type`"));
            continue;
        };
        let Some(t) = types.get(type_id) else {
            out.push(Issue::new(at, format!("unknown type `{type_id}`")));
            continue;
        };
        for child in &node.children {
            if let Some(ct) = tree.get(child).and_then(|c| c.type_id.as_deref()) {
                if types.get(ct).is_some() && !t.children.iter().any(|c| c == ct) {
                    out.push(Issue::new(
                        project.spec_file(child),
                        format!("type `{ct}` isn't allowed as a child of `{type_id}`"),
                    ));
                }
            }
        }
        for (doc, tpl) in &t.templates {
            if tpl.required && !node.docs.contains(doc) {
                out.push(Issue::new(at.clone(), format!("missing required document {doc}.md")));
            }
        }
        for f in &node.stray_files {
            out.push(Issue::new(
                format!("{}{f}", dir_prefix(&at)),
                format!("file isn't node.yaml or a document of type `{type_id}`"),
            ));
        }
        for doc in &node.extras {
            if !t.templates.get(doc).is_some_and(|tpl| tpl.extra) {
                out.push(Issue::new(
                    format!("{}{doc}-extra/", dir_prefix(&at)),
                    format!("document `{doc}` doesn't allow extra files"),
                ));
            }
        }
        if t.code && node.code.is_empty() {
            out.push(Issue::new(at.clone(), format!("type `{type_id}` has code: true, but the node lists no code paths")));
        }
        if !t.code && !node.code.is_empty() {
            out.push(Issue::new(at.clone(), format!("lists code paths, but type `{type_id}` doesn't have code: true")));
        }
        // Sections the node's documents derive from exist in its documents.
        for d in &node.docs {
            for dep in t.templates.get(d).map(|tpl| tpl.derives_from.as_slice()).unwrap_or_default() {
                let (did, Some(sec)) = split_ref(dep) else { continue };
                if !node.docs.iter().any(|x| x == did) {
                    continue;
                }
                if !tree.read_doc(project, &doc_key(&node.path, did)).is_some_and(|text| sections::has(&text, sec)) {
                    out.push(Issue::new(
                        project.spec_file(&doc_key(&node.path, d)),
                        format!("derives from {did}.md#{sec}, which has no such section"),
                    ));
                }
            }
        }
        for (raw, why) in &node.bad_links {
            out.push(Issue::new(at.clone(), format!("invalid link `{raw}`: {why}")));
        }
        for link in &node.deps {
            match tree.get(&link.node) {
                None => out.push(Issue::new(at.clone(), format!("links to {}, which doesn't exist", link.raw))),
                Some(target) => {
                    if let Some(tt) = target.type_id.as_deref().filter(|tt| types.get(tt).is_some()) {
                        if !t.derives_from.iter().any(|d| d == tt) {
                            out.push(Issue::new(
                                at.clone(),
                                format!("links to {} of type `{tt}`, which isn't in `{type_id}`'s derives_from", link.raw),
                            ));
                        }
                    }
                    if let Some(problem) = link_problem(project, types, tree, link) {
                        out.push(Issue::new(at.clone(), format!("links to {}, which {problem}", link.raw)));
                    }
                }
            }
        }
    }
    let link_edges: HashMap<String, Vec<String>> =
        tree.nodes.values().map(|n| (n.path.clone(), n.links.clone())).collect();
    if let Some(cycle) = find_cycle(&link_edges) {
        let shown: Vec<&str> = cycle.iter().map(|p| show_node(p)).collect();
        out.push(Issue::new(project.spec_file(""), format!("links form a cycle: {}", shown.join(" → "))));
    }
}

/// What is wrong with the document or section a link narrows to, if anything; the target node exists.
/// Worded to follow "which": `doesn't exist`, `is internal`, `has no such section`.
pub fn link_problem(project: &Project, types: &Types, tree: &Tree, link: &Link) -> Option<String> {
    let doc = link.doc.as_deref()?;
    let target = tree.get(&link.node)?;
    let tt = target.type_id.as_deref().unwrap_or("");
    if !target.docs.iter().any(|d| d == doc) {
        return Some("doesn't exist".into());
    }
    if types.template(tt, doc).is_some_and(|t| !t.exposed) {
        return Some(format!("is internal to {}", show_node(&link.node)));
    }
    let sec = link.section.as_deref()?;
    let text = tree.read_doc(project, &doc_key(&link.node, doc)).unwrap_or_default();
    (!sections::has(&text, sec)).then(|| "has no such section".into())
}

fn dir_prefix(at: &str) -> String {
    if at.is_empty() || at.ends_with('/') {
        at.to_string()
    } else {
        format!("{at}/")
    }
}

/// Finds one cycle in a directed graph, returned as a path that starts and ends at the same vertex.
pub fn find_cycle(edges: &HashMap<String, Vec<String>>) -> Option<Vec<String>> {
    let mut done: HashSet<String> = HashSet::new();
    let mut keys: Vec<&String> = edges.keys().collect();
    keys.sort();
    for start in keys {
        let mut stack: Vec<String> = vec![];
        if let Some(c) = dfs(start, edges, &mut stack, &mut done) {
            return Some(c);
        }
    }
    None
}

fn dfs(v: &str, edges: &HashMap<String, Vec<String>>, stack: &mut Vec<String>, done: &mut HashSet<String>) -> Option<Vec<String>> {
    if let Some(i) = stack.iter().position(|s| s == v) {
        let mut c = stack[i..].to_vec();
        c.push(v.to_string());
        return Some(c);
    }
    if done.contains(v) {
        return None;
    }
    stack.push(v.to_string());
    for next in edges.get(v).into_iter().flatten() {
        if let Some(c) = dfs(next, edges, stack, done) {
            return Some(c);
        }
    }
    stack.pop();
    done.insert(v.to_string());
    None
}
