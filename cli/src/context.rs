use anyhow::{bail, Result};
use serde_json::{json, Value};

use crate::change::Change;
use crate::git;
use crate::project::{show_node, Project};
use crate::sections::split_ref;
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
    /// The anchor of the one section of the document that is read.
    section: Option<String>,
    note: Option<String>,
}

fn file(path: String) -> File {
    File { path, section: None, note: None }
}

impl File {
    fn shown(&self) -> String {
        match &self.section {
            Some(s) => format!("{}#{s}", self.path),
            None => self.path.clone(),
        }
    }
}

/// Upstream documents in the order they are first needed, each whole or by its sections.
#[derive(Default)]
struct Needs {
    /// (node path, document id) → `None` for the whole document, else its sections in order.
    docs: indexmap::IndexMap<(String, String), Option<Vec<String>>>,
}

impl Needs {
    fn add(&mut self, node: &str, doc: &str, section: Option<&str>) {
        let e = self.docs.entry((node.to_string(), doc.to_string())).or_insert_with(|| Some(vec![]));
        match (e.as_mut(), section) {
            (Some(_), None) => *e = None,
            (Some(secs), Some(s)) if !secs.iter().any(|x| x == s) => secs.push(s.to_string()),
            _ => {}
        }
    }

    fn files(&self, project: &Project, tree: &Tree) -> Vec<File> {
        let mut out = vec![];
        for ((node, doc), secs) in &self.docs {
            let Some(n) = tree.get(node) else { continue };
            let path = project.spec_file(&doc_key(node, doc));
            match secs {
                None => out.push(file(path)),
                Some(secs) => out.extend(secs.iter().map(|s| File { path: path.clone(), section: Some(s.clone()), note: None })),
            }
            if n.extras.contains(doc) {
                out.push(file(project.spec_file(&crate::tree::join(node, &format!("{doc}-extra/")))));
            }
        }
        out
    }
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

/// The context of one job, ready to print.
struct Context {
    node: String,
    type_id: String,
    type_name: String,
    instructions: Option<String>,
    /// The ids of the documents being written, in the order given; empty when implementing.
    documents: Vec<String>,
    sections: Vec<Section>,
    baseline: Option<String>,
}

fn build(
    project: &Project,
    types: &Types,
    tree: &Tree,
    node_arg: &str,
    documents: &[String],
    implement: bool,
    change: Option<&str>,
) -> Result<Context> {
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
    // What the links name: the exposed documents of a linked node, or one document or section of it.
    let mut needs = Needs::default();
    for link in &node.deps {
        let Some(l) = tree.get(&link.node) else { continue };
        let lt = l.type_id.as_deref().unwrap_or("");
        match &link.doc {
            None => {
                for d in l.docs.iter().filter(|d| types.template(lt, d).is_none_or(|t| t.exposed)) {
                    needs.add(&l.path, d, None);
                }
            }
            Some(d) if l.docs.contains(d) => needs.add(&l.path, d, link.section.as_deref()),
            Some(_) => {}
        }
    }

    let mut sections: Vec<Section> = vec![];
    // The documents being written, in the order given, without repeats.
    let mut targets: Vec<String> = vec![];
    match (!documents.is_empty(), implement) {
        (true, false) => {
            for id in documents {
                if !t.documents.iter().any(|d| d == id) {
                    bail!("type `{type_id}` has no document `{id}`; its documents are {}", t.documents.join(", "));
                }
                if !targets.contains(id) {
                    targets.push(id.clone());
                }
            }
            // Same-node documents, or sections of them, that any written document derives from, except the written ones.
            for id in &targets {
                for dep in types.template(type_id, id).map(|t| t.derives_from.as_slice()).unwrap_or_default() {
                    let (did, sec) = split_ref(dep);
                    if node.docs.iter().any(|d| d == did) && !targets.iter().any(|t| t == did) {
                        needs.add(&path, did, sec);
                    }
                }
            }
            sections.push(Section { name: "document", files: doc_files(project, node, &targets.iter().collect::<Vec<_>>()) });
            sections.push(Section { name: "ancestors", files: ancestors });
            sections.push(Section { name: "upstream", files: needs.files(project, tree) });
        }
        (false, true) => {
            if !t.code {
                bail!("{} has no code paths: its type `{type_id}` doesn't have code: true", show_node(&path));
            }
            sections.push(Section { name: "ancestors", files: ancestors });
            sections.push(Section { name: "upstream", files: needs.files(project, tree) });
            sections.push(Section { name: "documents", files: doc_files(project, node, &node.docs.iter().collect::<Vec<_>>()) });
        }
        _ => bail!("give either --document <id> or --implement"),
    }

    if let Some(c) = &change {
        // change.md, plus the diffs of updated documents among the files above.
        let listed: Vec<String> = sections.iter().flat_map(|s| s.files.iter().map(|f| f.path.clone())).collect();
        let written: Vec<String> = targets.iter().map(|id| doc_key(&path, id)).collect();
        let mut files = vec![file(c.change_md(project))];
        for u in c.updated() {
            let p = project.spec_file(u);
            if listed.contains(&p) && !written.contains(u) {
                files.push(File { path: p, section: None, note: Some(format!("diff since {}", git::short(&c.status.baseline))) });
            }
        }
        sections.push(Section { name: "change", files });
    }
    if implement {
        sections.push(Section { name: "code", files: node.code.iter().map(|c| file(c.clone())).collect() });
    } else {
        let templates = targets
            .iter()
            .map(|id| file(project.rel(&project.types_dir().join(type_id).join(format!("{id}.md")))))
            .collect();
        sections.push(Section { name: "template", files: templates });
    }

    Ok(Context {
        node: show_node(&path).to_string(),
        type_id: type_id.to_string(),
        type_name: t.name.clone(),
        instructions: t.instructions.clone(),
        documents: targets,
        sections,
        baseline: change.map(|c| c.status.baseline),
    })
}

pub fn cmd_context(
    project: &Project,
    types: &Types,
    tree: &Tree,
    node_arg: &str,
    documents: &[String],
    implement: bool,
    change: Option<&str>,
    out: &Out,
) -> Result<()> {
    let ctx = build(project, types, tree, node_arg, documents, implement, change)?;

    if out.json {
        let mut files = serde_json::Map::new();
        for s in &ctx.sections {
            let v: Vec<Value> = s.files.iter().map(|f| json!({ "path": f.path, "section": f.section, "note": f.note })).collect();
            files.insert(s.name.to_string(), Value::Array(v));
        }
        return out.print(json!({
            "node": ctx.node,
            "type": ctx.type_id,
            "documents": ctx.documents,
            "instructions": { "type": ctx.type_name, "text": ctx.instructions },
            "files": files,
            "baseline": ctx.baseline,
        }));
    }

    println!("# Instructions\n");
    match &ctx.instructions {
        Some(text) => println!("{} type:\n{}\n", ctx.type_name, text.trim_end()),
        None => println!("{} type: no instructions.\n", ctx.type_name),
    }
    println!("# Files\n");
    for s in &ctx.sections {
        if s.files.is_empty() {
            continue;
        }
        println!("{}:", s.name);
        let rows: Vec<(String, String)> =
            s.files.iter().map(|f| (f.shown(), f.note.clone().unwrap_or_default())).collect();
        print!("{}", columns(&rows, "  "));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};

    use super::*;
    use crate::{tree, types};

    fn example() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples/example_product")
    }

    fn paths(ctx: &Context, group: &str) -> Vec<String> {
        ctx.sections.iter().find(|s| s.name == group).unwrap().files.iter().map(|f| f.path.clone()).collect()
    }

    fn notes(ctx: &Context, group: &str) -> Vec<(String, Option<String>)> {
        ctx.sections.iter().find(|s| s.name == group).unwrap().files.iter().map(|f| (f.path.clone(), f.note.clone())).collect()
    }

    fn ids(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    const NODE: &str = "system/services/payments";
    const P: &str = "docs/system/services/payments";

    fn build_at(root: &Path, documents: &[&str], implement: bool, change: Option<&str>) -> Result<Context> {
        let project = Project::open(root).unwrap();
        let types = types::load(&project);
        let tree = tree::load(&project, &types).unwrap();
        build(&project, &types, &tree, NODE, &ids(documents), implement, change)
    }

    #[test]
    fn one_document() {
        let ctx = build_at(&example(), &["logic"], false, None).unwrap();
        assert_eq!(ctx.documents, ids(&["logic"]));
        assert_eq!(paths(&ctx, "document"), vec![format!("{P}/logic.md")]);
        let up = paths(&ctx, "upstream");
        assert!(up.contains(&format!("{P}/api.md")));
        assert!(up.contains(&format!("{P}/api-extra/")));
        assert_eq!(paths(&ctx, "template"), vec![".uspec/node-types/service/logic.md".to_string()]);
        let names: Vec<&str> = ctx.sections.iter().map(|s| s.name).collect();
        assert_eq!(names, vec!["document", "ancestors", "upstream", "template"]);
    }

    #[test]
    fn several_documents_share_one_context() {
        // storage derives from logic, logic from api.
        let ctx = build_at(&example(), &["storage", "logic", "storage"], false, None).unwrap();
        assert_eq!(ctx.documents, ids(&["storage", "logic"]));
        assert_eq!(paths(&ctx, "document"), vec![format!("{P}/storage.md"), format!("{P}/logic.md")]);
        let up = paths(&ctx, "upstream");
        assert!(up.contains(&format!("{P}/api.md")), "api is derived from by logic");
        assert!(!up.contains(&format!("{P}/logic.md")), "a written document isn't upstream");
        assert!(!up.contains(&format!("{P}/storage.md")));
        assert_eq!(
            paths(&ctx, "template"),
            vec![".uspec/node-types/service/storage.md".to_string(), ".uspec/node-types/service/logic.md".to_string()]
        );
    }

    #[test]
    fn implement_has_no_documents_being_written() {
        let ctx = build_at(&example(), &[], true, None).unwrap();
        assert!(ctx.documents.is_empty());
        let names: Vec<&str> = ctx.sections.iter().map(|s| s.name).collect();
        assert_eq!(names, vec!["ancestors", "upstream", "documents", "code"]);
    }

    #[test]
    fn errors() {
        let e = build_at(&example(), &["logic", "nope"], false, None).err().unwrap().to_string();
        assert!(e.starts_with("type `service` has no document `nope`; its documents are api, logic"), "{e}");
        let e = build_at(&example(), &[], false, None).err().unwrap().to_string();
        assert_eq!(e, "give either --document <id> or --implement");
    }

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

    #[test]
    fn change_diffs_skip_the_documents_being_written() {
        let root = std::env::temp_dir().join(format!("uspec-context-unit-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        copy_dir(&example(), &root);
        let dir = root.join(".uspec/changes/c");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("change.md"), "# c\n").unwrap();
        fs::write(
            dir.join("status.yaml"),
            format!(
                "baseline: \"0123456789abcdef\"\ncreated: 0\ndocuments:\n  {NODE}/api.md: {{state: updated}}\n  {NODE}/logic.md: {{state: updated}}\n  {NODE}/storage.md: {{state: updated}}\n"
            ),
        )
        .unwrap();
        let ctx = build_at(&root, &["logic", "storage"], false, Some("c"));
        let _ = fs::remove_dir_all(&root);
        let ctx = ctx.unwrap();
        assert_eq!(
            notes(&ctx, "change"),
            vec![
                (".uspec/changes/c/change.md".to_string(), None),
                (format!("{P}/api.md"), Some("diff since 0123456".to_string())),
            ]
        );
        assert_eq!(ctx.baseline.as_deref(), Some("0123456789abcdef"));
    }
}
