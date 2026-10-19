use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use serde::Deserialize;

/// A uspec project: the directory that holds `.uspec/`.
pub struct Project {
    pub root: PathBuf,
    /// The spec tree's directory, relative to the project root (`docs` by default).
    pub spec_root: String,
}

#[derive(Deserialize, Default)]
struct Config {
    spec_root: Option<String>,
}

impl Project {
    /// Finds the project by walking up from the current directory to the first `.uspec/`.
    pub fn find() -> Result<Project> {
        let cwd = std::env::current_dir()?;
        let mut dir: &Path = &cwd;
        loop {
            if dir.join(".uspec").is_dir() {
                return Project::open(dir);
            }
            match dir.parent() {
                Some(p) => dir = p,
                None => bail!("no .uspec/ directory found here or in any parent; run `uspec init`"),
            }
        }
    }

    pub fn open(root: &Path) -> Result<Project> {
        let config_path = root.join(".uspec/config.yaml");
        let config: Config = if config_path.exists() {
            let text = fs::read_to_string(&config_path)?;
            serde_yaml::from_str::<Option<Config>>(&text)
                .with_context(|| format!("invalid {}", config_path.display()))?
                .unwrap_or_default()
        } else {
            Config::default()
        };
        let spec_root = config
            .spec_root
            .unwrap_or_else(|| "docs".into())
            .trim_end_matches('/')
            .to_string();
        Ok(Project { root: root.to_path_buf(), spec_root })
    }

    pub fn uspec_dir(&self) -> PathBuf {
        self.root.join(".uspec")
    }

    pub fn types_dir(&self) -> PathBuf {
        self.uspec_dir().join("node-types")
    }

    pub fn changes_dir(&self) -> PathBuf {
        self.uspec_dir().join("changes")
    }

    pub fn spec_dir(&self) -> PathBuf {
        if self.spec_root.is_empty() || self.spec_root == "." {
            self.root.clone()
        } else {
            self.root.join(&self.spec_root)
        }
    }

    /// A path relative to the project root, with `/` separators.
    pub fn rel(&self, path: &Path) -> String {
        let p = path.strip_prefix(&self.root).unwrap_or(path);
        p.to_string_lossy().replace('\\', "/")
    }

    /// Turns a spec-relative path (a document or node) into a project-relative one.
    pub fn spec_file(&self, spec_rel: &str) -> String {
        if self.spec_root.is_empty() || self.spec_root == "." {
            spec_rel.to_string()
        } else if spec_rel.is_empty() {
            format!("{}/", self.spec_root)
        } else {
            format!("{}/{}", self.spec_root, spec_rel)
        }
    }

    /// Accepts a spec-relative or project-relative path and returns it spec-relative.
    pub fn to_spec_rel(&self, input: &str) -> String {
        let s = input.trim().trim_start_matches("./").trim_end_matches('/');
        if s == "." {
            return String::new();
        }
        if !self.spec_root.is_empty() && self.spec_root != "." {
            if s == self.spec_root {
                return String::new();
            }
            if let Some(rest) = s.strip_prefix(&format!("{}/", self.spec_root)) {
                return rest.to_string();
            }
        }
        s.to_string()
    }
}

/// Shows a node path; the root is ".".
pub fn show_node(path: &str) -> &str {
    if path.is_empty() {
        "."
    } else {
        path
    }
}
