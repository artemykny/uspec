//! uspec: scaffolds, validates and tracks changes to a spec tree. See docs/cli/.
#![allow(clippy::too_many_arguments)]

mod change;
mod context;
mod drift;
mod git;
mod graph;
mod init;
mod node;
mod plans;
mod project;
mod sections;
mod tree;
mod types;
mod validate;

use anyhow::Result;
use clap::{Parser, Subcommand};
use serde::Serialize;
use serde_json::{json, Value};

use project::{show_node, Project};

#[derive(Clone, Serialize)]
pub struct Issue {
    pub path: String,
    pub message: String,
}

impl Issue {
    pub fn new(path: impl Into<String>, message: impl Into<String>) -> Issue {
        Issue { path: path.into(), message: message.into() }
    }
}

/// Where command output goes: text for people, or JSON for skills.
pub struct Out {
    pub json: bool,
}

impl Out {
    pub fn print(&self, v: Value) -> Result<()> {
        println!("{}", serde_json::to_string_pretty(&v)?);
        Ok(())
    }
}

/// Formats rows as two aligned columns, each line starting with `indent`.
pub fn columns(rows: &[(String, String)], indent: &str) -> String {
    let width = rows.iter().filter(|(_, b)| !b.is_empty()).map(|(a, _)| a.chars().count()).max().unwrap_or(0);
    let mut s = String::new();
    for (a, b) in rows {
        if b.is_empty() {
            s.push_str(&format!("{indent}{a}\n"));
        } else {
            s.push_str(&format!("{indent}{a:width$}   {b}\n"));
        }
    }
    s
}

#[derive(Parser)]
#[command(name = "uspec", version, about = "Scaffold, validate and track changes to a uspec spec tree")]
struct Cli {
    /// Print machine-readable JSON.
    #[arg(long, global = true)]
    json: bool,
    #[command(subcommand)]
    command: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Create .uspec/, the node types and the root node.
    Init {
        /// A local directory or github:<owner>/<repo>[/<path>][@<ref>] with node types.
        #[arg(long)]
        preset: Option<String>,
    },
    /// Check the tree's structure.
    Validate,
    /// Print the tree with node types.
    Tree { node: Option<String> },
    /// Print the node types with their documents.
    Types,
    /// Print what an agent reads to write a document or implement a node.
    Context {
        node: String,
        /// A document to write; give it more than once to write several together.
        #[arg(long, conflicts_with = "implement")]
        document: Vec<String>,
        #[arg(long)]
        implement: bool,
        /// Add the change's description and diffs.
        #[arg(long)]
        change: Option<String>,
    },
    /// Add, move and remove nodes.
    Node {
        #[command(subcommand)]
        cmd: NodeCmd,
    },
    /// Open, track and close changes.
    Change {
        #[command(subcommand)]
        cmd: ChangeCmd,
    },
    /// Find code changed without a spec change.
    Drift,
}

#[derive(Subcommand)]
enum NodeCmd {
    /// Create a node with its node.yaml and documents.
    New {
        path: String,
        #[arg(long = "type")]
        type_id: String,
        #[arg(long = "derives-from", num_args = 1..)]
        derives_from: Vec<String>,
        /// Code paths, for types with code: true.
        #[arg(long, num_args = 1..)]
        code: Vec<String>,
    },
    /// Move a node and rewrite every link to it.
    Move { from: String, to: String },
    /// Delete a node and its subtree.
    Remove { path: String },
}

#[derive(Subcommand)]
enum ChangeCmd {
    /// Open a change.
    New { name: String },
    /// List open changes, oldest first.
    List,
    /// Print every item in the change with its state.
    Status { name: String },
    /// Print what's ready: impact, triage, write, plan or implement.
    Next { name: String },
    /// Record an item's state (updated, affected, no-change, done) and propagate.
    Set {
        name: String,
        item: String,
        state: String,
        #[arg(long)]
        reason: Option<String>,
    },
    /// Validate and remove the change directory.
    Close { name: String },
}

fn main() {
    let cli = Cli::parse();
    let out = Out { json: cli.json };
    if let Err(e) = run(cli.command, &out) {
        if out.json {
            println!("{}", json!({ "error": format!("{e:#}") }));
        } else {
            eprintln!("error: {e:#}");
        }
        std::process::exit(1);
    }
}

fn run(cmd: Cmd, out: &Out) -> Result<()> {
    if let Cmd::Init { preset } = &cmd {
        return init::cmd_init(preset.as_deref(), out);
    }
    let project = Project::find()?;
    let types = types::load(&project);
    let tree = tree::load(&project, &types)?;
    match cmd {
        Cmd::Init { .. } => unreachable!(),
        Cmd::Validate => cmd_validate(&project, &types, &tree, out),
        Cmd::Tree { node } => cmd_tree(&project, &tree, node.as_deref(), out),
        Cmd::Types => cmd_types(&project, &types, out),
        Cmd::Context { node, document, implement, change } => context::cmd_context(
            &project,
            &types,
            &tree,
            &node,
            &document,
            implement,
            change.as_deref(),
            out,
        ),
        Cmd::Node { cmd } => match cmd {
            NodeCmd::New { path, type_id, derives_from, code } => {
                node::cmd_new(&project, &types, &tree, &path, &type_id, &derives_from, &code, out)
            }
            NodeCmd::Move { from, to } => node::cmd_move(&project, &types, &tree, &from, &to, out),
            NodeCmd::Remove { path } => node::cmd_remove(&project, &tree, &path, out),
        },
        Cmd::Change { cmd } => match cmd {
            ChangeCmd::New { name } => change::cmd_new(&project, &name, out),
            ChangeCmd::List => change::cmd_list(&project, out),
            ChangeCmd::Status { name } => change::cmd_status(&project, &tree, &name, out),
            ChangeCmd::Next { name } => change::cmd_next(&project, &types, &tree, &name, out),
            ChangeCmd::Set { name, item, state, reason } => {
                change::cmd_set(&project, &types, &tree, &name, &item, &state, reason, out)
            }
            ChangeCmd::Close { name } => change::cmd_close(&project, &types, &tree, &name, out),
        },
        Cmd::Drift => drift::cmd_drift(&project, &types, &tree, out),
    }
}

fn cmd_validate(project: &Project, types: &types::Types, tree: &tree::Tree, out: &Out) -> Result<()> {
    let issues = validate::validate(project, types, tree);
    if out.json {
        out.print(json!({ "valid": issues.is_empty(), "errors": issues }))?;
    } else if issues.is_empty() {
        println!("ok: {} node types, {} nodes", types.map.len(), tree.nodes.len());
    } else {
        for i in &issues {
            println!("error: {}: {}", i.path, i.message);
        }
        println!("{} errors", issues.len());
    }
    if !issues.is_empty() {
        std::process::exit(1);
    }
    Ok(())
}

fn cmd_tree(project: &Project, tree: &tree::Tree, node: Option<&str>, out: &Out) -> Result<()> {
    let base = node.map(|n| project.to_spec_rel(n)).unwrap_or_default();
    let start = tree.node(&base)?;
    let depth_of = |p: &str| if p.is_empty() { 0 } else { p.matches('/').count() + 1 };
    let base_depth = depth_of(&start.path);
    let nodes: Vec<&tree::Node> =
        tree.nodes.values().filter(|n| tree::is_under(&n.path, &start.path)).collect();
    if out.json {
        let v: Vec<Value> = nodes
            .iter()
            .map(|n| {
                json!({
                    "node": show_node(&n.path),
                    "type": n.type_id,
                    "depth": depth_of(&n.path) - base_depth,
                    "documents": n.docs,
                    "derives_from": n.deps.iter().map(|l| l.raw.clone()).chain(n.bad_links.iter().map(|(r, _)| r.clone())).collect::<Vec<_>>(),
                    "code": n.code,
                })
            })
            .collect();
        return out.print(json!({ "nodes": v }));
    }
    for n in nodes {
        let d = depth_of(&n.path) - base_depth;
        let name = if n.path.is_empty() {
            format!("{}/", project.spec_root)
        } else if d == 0 {
            format!("{}/", n.path)
        } else {
            format!("{}/", n.path.rsplit('/').next().unwrap())
        };
        let mut line = format!("{}{name}  {}", "  ".repeat(d), n.type_id.as_deref().unwrap_or("?"));
        if !n.code.is_empty() {
            line.push_str(&format!("  code: {}", n.code.join(", ")));
        }
        println!("{line}");
        for l in n.deps.iter().map(|l| &l.raw).chain(n.bad_links.iter().map(|(r, _)| r)) {
            println!("{}  → {l}", "  ".repeat(d));
        }
    }
    Ok(())
}

fn cmd_types(project: &Project, types: &types::Types, out: &Out) -> Result<()> {
    let dir = |id: &str| project.types_dir().join(id);
    if out.json {
        let v: Vec<Value> = types
            .map
            .values()
            .map(|t| {
                let docs: Vec<Value> = t
                    .documents
                    .iter()
                    .map(|d| match t.templates.get(d) {
                        Some(tpl) => json!({
                            "document": d,
                            "template": project.rel(&dir(&t.id).join(format!("{d}.md"))),
                            "description": tpl.description,
                            "required": tpl.required,
                            "derives_from": tpl.derives_from,
                            "exposed": tpl.exposed,
                            "extra": tpl.extra,
                        }),
                        None => json!({
                            "document": d,
                            "template": null,
                            "description": null,
                            "required": true,
                            "derives_from": [],
                            "exposed": true,
                            "extra": false,
                        }),
                    })
                    .collect();
                json!({
                    "type": t.id,
                    "name": t.name,
                    "description": t.description,
                    "path": project.rel(&dir(&t.id).join("node-type.yaml")),
                    "code": t.code,
                    "children": t.children,
                    "derives_from": t.derives_from,
                    "documents": docs,
                    "instructions": t.instructions,
                })
            })
            .collect();
        return out.print(json!({ "types": v }));
    }
    let list = |ids: &[String]| if ids.is_empty() { "none".to_string() } else { ids.join(", ") };
    for (i, t) in types.map.values().enumerate() {
        if i > 0 {
            println!();
        }
        println!("{}  {}{}", t.id, t.name, if t.code { "  code" } else { "" });
        if let Some(d) = &t.description {
            println!("  {}", d.trim());
        }
        let mut rows = vec![
            ("children:".to_string(), list(&t.children)),
            ("derives from:".to_string(), list(&t.derives_from)),
            ("documents:".to_string(), String::new()),
        ];
        rows.extend(t.documents.iter().map(|d| {
            let flags = match t.templates.get(d) {
                None => "no template".to_string(),
                Some(tpl) => {
                    let mut f: Vec<String> = vec![];
                    if !tpl.required {
                        f.push("optional".into());
                    }
                    if !tpl.exposed {
                        f.push("internal".into());
                    }
                    if tpl.extra {
                        f.push("extra".into());
                    }
                    if !tpl.derives_from.is_empty() {
                        f.push(format!("derives from {}", tpl.derives_from.join(", ")));
                    }
                    f.join(", ")
                }
            };
            (format!("  {d}.md"), flags)
        }));
        print!("{}", columns(&rows, "  "));
    }
    Ok(())
}
