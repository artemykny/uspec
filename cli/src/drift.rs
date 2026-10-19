use std::collections::HashSet;
use std::fs;

use anyhow::Result;
use serde_json::json;

use crate::change::Change;
use crate::git;
use crate::project::{show_node, Project};
use crate::tree::{doc_key, Tree};
use crate::types::Types;
use crate::Out;

/// Finds nodes whose code changed after their spec last did.
///
/// A heuristic: for each node with code paths, the last commit that touched its code is compared
/// with the last commit that touched its documents or node.yaml. Uncommitted code changes count
/// too. Nodes being implemented in an open change are skipped.
pub fn cmd_drift(project: &Project, types: &Types, tree: &Tree, out: &Out) -> Result<()> {
    let mut in_change: HashSet<String> = HashSet::new();
    if let Ok(rd) = fs::read_dir(project.changes_dir()) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if let Ok(c) = Change::load(project, &name) {
                in_change.extend(c.status.implementation.keys().cloned());
            }
        }
    }
    let mut drifted = vec![];
    for n in tree.nodes.values() {
        if !tree.has_code(types, &n.path) || n.code.is_empty() || in_change.contains(show_node(&n.path)) {
            continue;
        }
        let mut spec: Vec<String> = n.docs.iter().map(|d| project.spec_file(&doc_key(&n.path, d))).collect();
        spec.extend(n.extras.iter().map(|d| project.spec_file(&crate::tree::join(&n.path, &format!("{d}-extra")))));
        spec.push(project.spec_file(&crate::tree::join(&n.path, "node.yaml")));
        let code = n.code.clone();
        let reason = if git::dirty(&project.root, &code) && !git::dirty(&project.root, &spec) {
            Some("uncommitted code changes without a spec change".to_string())
        } else {
            match (git::last_commit(&project.root, &code), git::last_commit(&project.root, &spec)) {
                (Some((sha, ct)), Some((_, st))) if ct > st => {
                    Some(format!("code changed in {} after the spec last changed", git::short(&sha)))
                }
                (Some((sha, _)), None) => Some(format!("code changed in {}, spec never committed", git::short(&sha))),
                _ => None,
            }
        };
        if let Some(r) = reason {
            drifted.push((show_node(&n.path).to_string(), r));
        }
    }
    if out.json {
        let v: Vec<_> = drifted.iter().map(|(n, r)| json!({ "node": n, "reason": r })).collect();
        out.print(json!({ "drift": v }))?;
    } else if drifted.is_empty() {
        println!("No drift: every node's code matches a committed spec change.");
    } else {
        for (n, r) in &drifted {
            println!("{n}: {r}");
        }
    }
    if !drifted.is_empty() {
        std::process::exit(1);
    }
    Ok(())
}
