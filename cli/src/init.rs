use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{bail, Context, Result};
use serde_json::json;

use crate::project::Project;
use crate::types;
use crate::Out;

const BASIC_TYPE: &str = "name: Basic
description: A part of the product.
children: [basic]
documents:
  - overview
";

const BASIC_TEMPLATE: &str = "---
description: |
  What this part of the product is, who it's for and what it covers.
---

# <Name>
";

fn copy_dir(from: &Path, to: &Path) -> Result<()> {
    fs::create_dir_all(to)?;
    for e in fs::read_dir(from)? {
        let e = e?;
        let name = e.file_name();
        if name.to_string_lossy().starts_with('.') {
            continue;
        }
        let (src, dst) = (e.path(), to.join(&name));
        if src.is_dir() {
            copy_dir(&src, &dst)?;
        } else {
            fs::copy(&src, &dst)?;
        }
    }
    Ok(())
}

/// Resolves a preset to a local directory of node types.
/// A preset is a local directory or `github:<owner>/<repo>[/<path>][@<ref>]`.
fn fetch_preset(preset: &str, tmp: &Path) -> Result<PathBuf> {
    let src = if let Some(spec) = preset.strip_prefix("github:") {
        let (spec, git_ref) = match spec.split_once('@') {
            Some((s, r)) => (s, Some(r)),
            None => (spec, None),
        };
        let mut parts = spec.splitn(3, '/');
        let (Some(owner), Some(repo)) = (parts.next(), parts.next()) else {
            bail!("a GitHub preset is github:<owner>/<repo>[/<path>][@<ref>]");
        };
        let sub = parts.next().unwrap_or("");
        let url = format!("https://github.com/{owner}/{repo}.git");
        let mut cmd = Command::new("git");
        cmd.args(["clone", "--quiet", "--depth", "1"]);
        if let Some(r) = git_ref {
            cmd.args(["--branch", r]);
        }
        let status = cmd.arg(&url).arg(tmp).status().context("failed to run git")?;
        if !status.success() {
            bail!("couldn't download preset from {url}");
        }
        tmp.join(sub)
    } else {
        PathBuf::from(preset)
    };
    for candidate in [src.join(".uspec/node-types"), src.join("node-types"), src.clone()] {
        if candidate.is_dir()
            && fs::read_dir(&candidate)?.filter_map(|e| e.ok()).any(|e| e.path().join("node-type.yaml").exists())
        {
            return Ok(candidate);
        }
    }
    bail!("no node types found in preset {preset}")
}

pub fn cmd_init(preset: Option<&str>, out: &Out) -> Result<()> {
    let root = std::env::current_dir()?;
    if root.join(".uspec").exists() {
        bail!(".uspec/ already exists");
    }
    let spec_dir = root.join("docs");
    if spec_dir.join("node.yaml").exists() {
        bail!("docs/node.yaml already exists");
    }
    let types_dir = root.join(".uspec/node-types");
    let tmp = std::env::temp_dir().join(format!("uspec-preset-{}", std::process::id()));
    let result = (|| -> Result<()> {
        match preset {
            Some(p) => {
                let src = fetch_preset(p, &tmp)?;
                copy_dir(&src, &types_dir)?;
            }
            None => {
                fs::create_dir_all(types_dir.join("basic"))?;
                fs::write(types_dir.join("basic/node-type.yaml"), BASIC_TYPE)?;
                fs::write(types_dir.join("basic/overview.md"), BASIC_TEMPLATE)?;
            }
        }
        Ok(())
    })();
    let _ = fs::remove_dir_all(&tmp);
    if let Err(e) = result {
        let _ = fs::remove_dir_all(root.join(".uspec"));
        return Err(e);
    }
    let result = create_root(&root, &spec_dir, out);
    if result.is_err() {
        let _ = fs::remove_dir_all(root.join(".uspec"));
    }
    result
}

fn create_root(root: &Path, spec_dir: &Path, out: &Out) -> Result<()> {
    fs::write(root.join(".uspec/config.yaml"), "spec_root: docs\n")?;
    fs::create_dir_all(root.join(".uspec/changes"))?;

    let project = Project::open(root)?;
    let types = types::load(&project);
    if !types.errors.is_empty() {
        let list: Vec<String> = types.errors.iter().map(|i| format!("{}: {}", i.path, i.message)).collect();
        bail!("the node types have errors:\n  {}", list.join("\n  "));
    }
    // The root type is the one no other type lists as a child.
    let mut roots: Vec<&str> = types
        .map
        .values()
        .filter(|t| !types.map.values().any(|o| o.id != t.id && o.children.contains(&t.id)))
        .map(|t| t.id.as_str())
        .collect();
    if roots.len() > 1 && roots.contains(&"root") {
        roots = vec!["root"];
    }
    let root_type = match roots.as_slice() {
        [one] => types.get(one).unwrap(),
        [] => bail!("the preset has no root type: every type is some other type's child"),
        many => bail!("the preset has several possible root types: {}", many.join(", ")),
    };
    // Check every destination before creating any part of the root node.
    for name in std::iter::once("node.yaml".to_string())
        .chain(root_type.templates.keys().map(|doc| format!("{doc}.md")))
    {
        let dest = spec_dir.join(&name);
        if dest.symlink_metadata().is_ok() {
            bail!("{} already exists; refusing to overwrite it", dest.display());
        }
    }
    fs::create_dir_all(spec_dir)?;
    fs::write(spec_dir.join("node.yaml"), format!("type: {}\n", root_type.id))?;
    let mut created = vec!["docs/node.yaml".to_string()];
    for (doc, tpl) in &root_type.templates {
        fs::write(spec_dir.join(format!("{doc}.md")), &tpl.body)?;
        created.push(format!("docs/{doc}.md"));
    }
    if out.json {
        return out.print(json!({ "types": types.map.keys().collect::<Vec<_>>(), "root_type": root_type.id, "created": created }));
    }
    println!("Created .uspec/ with {} node types", types.map.len());
    println!("Created the root node ({}):", root_type.id);
    for f in created {
        println!("  {f}");
    }
    Ok(())
}
