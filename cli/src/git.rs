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

/// The last commit that touched any of `paths`: its hash and commit time.
pub fn last_commit(root: &Path, paths: &[String]) -> Option<(String, i64)> {
    if paths.is_empty() {
        return None;
    }
    let mut args = vec!["log", "-1", "--format=%H %ct", "--"];
    args.extend(paths.iter().map(String::as_str));
    let out = git(root, &args).ok()?;
    let (sha, time) = out.split_once(' ')?;
    Some((sha.to_string(), time.parse().ok()?))
}

/// Whether any of `paths` has uncommitted changes.
pub fn dirty(root: &Path, paths: &[String]) -> bool {
    if paths.is_empty() {
        return false;
    }
    let mut args = vec!["status", "--porcelain", "--"];
    args.extend(paths.iter().map(String::as_str));
    git(root, &args).is_ok_and(|o| !o.is_empty())
}
