use std::fs;

use anyhow::{bail, Result};
use serde_json::json;

use crate::project::{show_node, Project};
use crate::tree::{is_under, join, Link, NodeYaml, Tree};
use crate::types::Types;
use crate::Out;

fn parent_and_name(path: &str) -> (String, String) {
    match path.rsplit_once('/') {
        Some((p, n)) => (p.to_string(), n.to_string()),
        None => (String::new(), path.to_string()),
    }
}

/// Checks that a node of `type_id` may sit at `path` under its parent.
fn check_place(tree: &Tree, types: &Types, path: &str, type_id: &str) -> Result<()> {
    if path.is_empty() {
        bail!("the root node already exists");
    }
    let (parent, name) = parent_and_name(path);
    let p = tree.node(&parent).map_err(|_| anyhow::anyhow!("parent {} doesn't exist", show_node(&parent)))?;
    let pt_id = p.type_id.as_deref().unwrap_or("");
    let Some(pt) = types.get(pt_id) else { bail!("parent {} has unknown type `{pt_id}`", show_node(&parent)) };
    if !pt.children.iter().any(|c| c == type_id) {
        let allowed = if pt.children.is_empty() { "none".to_string() } else { pt.children.join(", ") };
        bail!("type `{type_id}` isn't allowed under {} (`{pt_id}`); allowed: {allowed}", show_node(&parent));
    }
    if let Some(doc) = name.strip_suffix("-extra") {
        if pt.documents.iter().any(|d| d == doc) {
            bail!("`{name}` is reserved for the extra files of {doc}.md");
        }
    }
    if name.is_empty() || name.starts_with('.') {
        bail!("invalid node name `{name}`");
    }
    Ok(())
}

pub fn cmd_new(
    project: &Project,
    types: &Types,
    tree: &Tree,
    path_arg: &str,
    type_id: &str,
    links: &[String],
    code: &[String],
    out: &Out,
) -> Result<()> {
    let path = project.to_spec_rel(path_arg);
    if tree.get(&path).is_some() {
        bail!("{} already exists", show_node(&path));
    }
    let Some(t) = types.get(type_id) else {
        bail!("unknown type `{type_id}`; types: {}", types.map.keys().cloned().collect::<Vec<_>>().join(", "));
    };
    check_place(tree, types, &path, type_id)?;
    let links: Vec<String> = links.iter().map(|l| project.to_spec_rel(l)).collect();
    for l in &links {
        let link = Link::parse(l).map_err(|e| anyhow::anyhow!("invalid link `{l}`: {e}"))?;
        let Some(target) = tree.get(&link.node) else { bail!("can't link to {l}: it doesn't exist") };
        let tt = target.type_id.as_deref().unwrap_or("");
        if !t.derives_from.iter().any(|d| d == tt) {
            bail!("can't link to {l}: type `{tt}` isn't in `{type_id}`'s derives_from");
        }
        if let Some(problem) = crate::validate::link_problem(project, types, tree, &link) {
            bail!("can't link to {l}: it {problem}");
        }
    }
    if t.code && code.is_empty() {
        bail!("type `{type_id}` has code: true; give its code paths with --code");
    }
    if !t.code && !code.is_empty() {
        bail!("type `{type_id}` doesn't have code: true, so the node can't list code paths");
    }
    let dir = project.spec_dir().join(&path);
    fs::create_dir_all(&dir)?;
    let yaml = NodeYaml { type_id: Some(type_id.to_string()), derives_from: links, code: code.to_vec() };
    fs::write(dir.join("node.yaml"), yaml.to_yaml())?;
    let mut created = vec![project.rel(&dir.join("node.yaml"))];
    for (doc, tpl) in &t.templates {
        let f = dir.join(format!("{doc}.md"));
        fs::write(&f, &tpl.body)?;
        created.push(project.rel(&f));
    }
    if out.json {
        return out.print(json!({ "node": path, "type": type_id, "created": created }));
    }
    println!("Created {}", project.spec_file(&path));
    for f in created {
        println!("  {f}");
    }
    Ok(())
}

pub fn cmd_move(project: &Project, types: &Types, tree: &Tree, from_arg: &str, to_arg: &str, out: &Out) -> Result<()> {
    let from = project.to_spec_rel(from_arg);
    let to = project.to_spec_rel(to_arg);
    if from.is_empty() {
        bail!("the root node can't be moved");
    }
    let node = tree.node(&from)?;
    if tree.get(&to).is_some() {
        bail!("{to} already exists");
    }
    if is_under(&to, &from) {
        bail!("can't move {from} into itself");
    }
    check_place(tree, types, &to, node.type_id.as_deref().unwrap_or(""))?;
    fs::rename(project.spec_dir().join(&from), project.spec_dir().join(&to))?;

    let rename = |p: &str| -> Option<String> {
        if p == from {
            Some(to.clone())
        } else {
            p.strip_prefix(&format!("{from}/")).map(|rest| join(&to, rest))
        }
    };
    // Rewrite links in every node, at its path after the move.
    let mut rewritten = vec![];
    for n in tree.nodes.values() {
        if !n.links.iter().any(|l| rename(l).is_some()) {
            continue;
        }
        let new_path = rename(&n.path).unwrap_or_else(|| n.path.clone());
        let file = project.spec_dir().join(&new_path).join("node.yaml");
        let mut y: NodeYaml = serde_yaml::from_str(&fs::read_to_string(&file)?)?;
        // The link keeps the document and section it narrows to.
        y.derives_from = y
            .derives_from
            .iter()
            .map(|raw| match Link::parse(raw) {
                Ok(l) => match rename(&l.node) {
                    Some(to) => Link::format(&to, l.doc.as_deref(), l.section.as_deref()),
                    None => raw.clone(),
                },
                Err(_) => raw.clone(),
            })
            .collect();
        fs::write(&file, y.to_yaml())?;
        rewritten.push(show_node(&new_path).to_string());
    }
    if out.json {
        return out.print(json!({ "from": from, "to": to, "links_rewritten": rewritten }));
    }
    println!("Moved {} → {}", project.spec_file(&from), project.spec_file(&to));
    if !rewritten.is_empty() {
        println!("Rewrote links in:");
        for r in rewritten {
            println!("  {r}");
        }
    }
    Ok(())
}

pub fn cmd_remove(project: &Project, tree: &Tree, path_arg: &str, out: &Out) -> Result<()> {
    let path = project.to_spec_rel(path_arg);
    if path.is_empty() {
        bail!("the root node can't be removed");
    }
    tree.node(&path)?;
    let mut blockers = vec![];
    for n in tree.nodes.values() {
        if is_under(&n.path, &path) {
            continue;
        }
        for l in &n.deps {
            if is_under(&l.node, &path) {
                blockers.push(format!("{} links to {}", show_node(&n.path), l.raw));
            }
        }
    }
    if !blockers.is_empty() {
        bail!("can't remove {path} while other nodes link to it:\n  {}", blockers.join("\n  "));
    }
    let removed: Vec<String> = tree.nodes.values().filter(|n| is_under(&n.path, &path)).map(|n| n.path.clone()).collect();
    fs::remove_dir_all(project.spec_dir().join(&path))?;
    if out.json {
        return out.print(json!({ "removed": removed }));
    }
    println!("Removed {} ({} nodes)", project.spec_file(&path), removed.len());
    Ok(())
}
