use anyhow::{bail, Result};
use serde_json::{json, Value};

use crate::change::Change;
use crate::git;
use crate::project::{show_node, Project};
use crate::tree::{doc_key, Node, Tree};
use crate::types::Types;
use crate::{columns, Out};

/// One group of files under `# Files`.
struct Section {
    name: &'static str,
    /// Spec-relative document keys, or project-relative paths for files outside the tree.
    files: Vec<File>,
}

struct File {
    path: String,
    note: Option<String>,
}

fn file(path: String) -> File {
    File { path, note: None }
}

/// The document files of a node (with their -extra folders) for the given ids.
fn doc_files(project: &Project, node: &Node, ids: &[&String]) -> Vec<File> {
    let mut out = vec![];
    for id in ids {
        out.push(file(project.spec_file(&doc_key(&node.path, id))));
        if node.extras.contains(id) {
            out.push(file(project.spec_file(&crate::tree::join(&node.path, &format!("{id}-extra/")))));
        }
    }
    out
}

pub fn cmd_context(
    project: &Project,
    types: &Types,
    tree: &Tree,
    node_arg: &str,
    document: Option<&str>,
    implement: bool,
    change: Option<&str>,
    out: &Out,
) -> Result<()> {
    let path = project.to_spec_rel(node_arg);
    let node = tree.node(&path)?;
    let Some(type_id) = node.type_id.as_deref() else { bail!("{} has no type", show_node(&path)) };
    let Some(t) = types.get(type_id) else { bail!("{} has unknown type `{type_id}`", show_node(&path)) };
    let change = match change {
        Some(name) => Some(Change::load(project, name)?),
        None => None,
    };

    let ancestors: Vec<File> = tree
        .ancestors(&path)
        .into_iter()
        .flat_map(|a| doc_files(project, a, &a.docs.iter().collect::<Vec<_>>()))
        .collect();
    // Exposed documents of linked nodes.
    let mut upstream: Vec<File> = vec![];
    for link in &node.links {
        let Some(l) = tree.get(link) else { continue };
        let lt = l.type_id.as_deref().unwrap_or("");
        let exposed: Vec<&String> = l.docs.iter().filter(|d| types.template(lt, d).is_none_or(|t| t.exposed)).collect();
        upstream.extend(doc_files(project, l, &exposed));
    }

    let mut sections: Vec<Section> = vec![];
    let mut target: Option<String> = None;
    match (document, implement) {
        (Some(id), false) => {
            if !t.documents.iter().any(|d| d == id) {
                bail!("type `{type_id}` has no document `{id}`; its documents are {}", t.documents.join(", "));
            }
            let id = id.to_string();
            target = Some(id.clone());
            let deps: Vec<&String> = types
                .template(type_id, &id)
                .map(|tpl| node.docs.iter().filter(|d| tpl.derives_from.contains(d)).collect())
                .unwrap_or_default();
            upstream.extend(doc_files(project, node, &deps));
            sections.push(Section { name: "document", files: doc_files(project, node, &[&id]) });
            sections.push(Section { name: "ancestors", files: ancestors });
            sections.push(Section { name: "upstream", files: upstream });
        }
        (None, true) => {
            if !t.code {
                bail!("{} has no code paths: its type `{type_id}` doesn't have code: true", show_node(&path));
            }
            sections.push(Section { name: "ancestors", files: ancestors });
            sections.push(Section { name: "upstream", files: upstream });
            sections.push(Section { name: "documents", files: doc_files(project, node, &node.docs.iter().collect::<Vec<_>>()) });
        }
        _ => bail!("give either --document <id> or --implement"),
    }

    if let Some(c) = &change {
        // change.md, plus the diffs of updated documents among the files above.
        let listed: Vec<String> = sections.iter().flat_map(|s| s.files.iter().map(|f| f.path.clone())).collect();
        let mut files = vec![file(c.change_md(project))];
        for u in c.updated() {
            let p = project.spec_file(u);
            if listed.contains(&p) && target.as_ref().is_none_or(|id| *u != doc_key(&path, id)) {
                files.push(File { path: p, note: Some(format!("diff since {}", git::short(&c.status.baseline))) });
            }
        }
        sections.push(Section { name: "change", files });
    }
    match &target {
        Some(id) => sections.push(Section {
            name: "template",
            files: vec![file(project.rel(&project.types_dir().join(type_id).join(format!("{id}.md"))))],
        }),
        None => sections.push(Section { name: "code", files: node.code.iter().map(|c| file(c.clone())).collect() }),
    }

    if out.json {
        let mut files = serde_json::Map::new();
        for s in &sections {
            let v: Vec<Value> = s.files.iter().map(|f| json!({ "path": f.path, "note": f.note })).collect();
            files.insert(s.name.to_string(), Value::Array(v));
        }
        return out.print(json!({
            "node": show_node(&path),
            "type": type_id,
            "document": target,
            "instructions": { "type": t.name, "text": t.instructions },
            "files": files,
            "baseline": change.as_ref().map(|c| c.status.baseline.clone()),
        }));
    }

    println!("# Instructions\n");
    match &t.instructions {
        Some(text) => println!("{} type:\n{}\n", t.name, text.trim_end()),
        None => println!("{} type: no instructions.\n", t.name),
    }
    println!("# Files\n");
    for s in &sections {
        if s.files.is_empty() {
            continue;
        }
        println!("{}:", s.name);
        let rows: Vec<(String, String)> =
            s.files.iter().map(|f| (f.path.clone(), f.note.clone().unwrap_or_default())).collect();
        print!("{}", columns(&rows, "  "));
    }
    Ok(())
}
