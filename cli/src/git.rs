use std::path::Path;
use std::process::Command;

use anyhow::{bail, Context, Result};

fn git(root: &Path, args: &[&str]) -> Result<String> {
    let out = Command::new("git")
        .current_dir(root)
        .args(args)
        .output()
        .context("failed to run git")?;
    if !out.status.success() {
        bail!("git {}: {}", args.join(" "), String::from_utf8_lossy(&out.stderr).trim());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// The current commit, used as a change's baseline.
pub fn head(root: &Path) -> Result<String> {
    git(root, &["rev-parse", "HEAD"]).context("a change needs a git repository with at least one commit")
}

pub fn short(sha: &str) -> &str {
    &sha[..sha.len().min(7)]
}

/// The files under `paths` that git tracks or that are untracked but not ignored, relative to `root`,
/// sorted. Empty when `paths` is empty or git fails.
pub fn files(root: &Path, paths: &[String]) -> Vec<String> {
    if paths.is_empty() {
        return vec![];
    }
    let out = Command::new("git")
        .current_dir(root)
        .args(["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--"])
        .args(paths)
        .output();
    let Ok(out) = out else { return vec![] };
    if !out.status.success() {
        return vec![];
    }
    let mut files: Vec<String> =
        String::from_utf8_lossy(&out.stdout).split('\0').filter(|p| !p.is_empty()).map(str::to_string).collect();
    files.sort();
    files.dedup();
    files
}

/// A file's content at `commit`, by its path relative to `root`; `None` if it didn't exist.
pub fn show(root: &Path, commit: &str, path: &str) -> Option<String> {
    let out = Command::new("git").current_dir(root).args(["show", &format!("{commit}:./{path}")]).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).to_string())
}
