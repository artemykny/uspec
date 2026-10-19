//! The plans of a change (docs/method/changes/rules.md#plans): `plans/<id>.md`, each with frontmatter
//! naming its nodes and the plans it comes after.

use std::collections::{HashMap, HashSet};
use std::fs;

use indexmap::IndexMap;
use serde::Deserialize;

use crate::change::Change;
use crate::project::{show_node, Project};
use crate::tree::Tree;
use crate::types::split_frontmatter;
use crate::validate::find_cycle;

pub struct Plan {
    pub id: String,
    /// Project-relative path of the plan file.
    pub path: String,
    /// Node keys as in `status.yaml` ("." for the root).
    pub nodes: Vec<String>,
    pub after: Vec<String>,
}

pub struct PlanError {
    /// The plan it is about; `None` for an error about several plans.
    pub plan: Option<String>,
    pub message: String,
}

pub struct Plans {
    pub dir: String,
    pub plans: Vec<Plan>,
    pub errors: Vec<PlanError>,
}

#[derive(Deserialize)]
struct Front {
    #[serde(default)]
    nodes: Vec<String>,
    #[serde(default)]
    after: Vec<String>,
}

impl Plans {
    /// Reads the change's plans and checks them against its implementation list and the tree.
    pub fn load(project: &Project, change: &Change, tree: &Tree) -> Plans {
        let dir = change.dir.join("plans");
        let mut plans = Plans { dir: format!("{}/", project.rel(&dir)), plans: vec![], errors: vec![] };
        let mut files: Vec<_> = fs::read_dir(&dir)
            .map(|rd| rd.filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "md")).collect())
            .unwrap_or_default();
        files.sort();
        for file in files {
            let id = file.file_stem().unwrap().to_string_lossy().to_string();
            let mut err = |m: String| plans.errors.push(PlanError { plan: Some(id.clone()), message: m });
            let text = fs::read_to_string(&file).unwrap_or_default();
            let front: Front = match split_frontmatter(&text).0 {
                None => {
                    err("has no frontmatter with `nodes`".into());
                    continue;
                }
                Some(f) => match serde_yaml::from_str(f) {
                    Ok(f) => f,
                    Err(e) => {
                        err(format!("invalid frontmatter: {e}"));
                        continue;
                    }
                },
            };
            if front.nodes.is_empty() {
                err("lists no nodes".into());
            }
            let nodes: Vec<String> = front.nodes.iter().map(|n| show_node(&project.to_spec_rel(n)).to_string()).collect();
            plans.plans.push(Plan { id, path: project.rel(&file), nodes, after: front.after });
        }
        plans.check(change, tree);
        plans
    }

    fn check(&mut self, change: &Change, tree: &Tree) {
        let imp = &change.status.implementation;
        let ids: HashSet<&String> = self.plans.iter().map(|p| &p.id).collect();
        let mut holder: HashMap<&String, &String> = HashMap::new();
        let mut errors = vec![];
        for p in &self.plans {
            let mut err = |m: String| errors.push(PlanError { plan: Some(p.id.clone()), message: m });
            for n in &p.nodes {
                if !imp.contains_key(n) {
                    err(format!("{n} isn't under implementation"));
                }
                match holder.get(n) {
                    Some(other) if **other != p.id => err(format!("{n} is also in plan {other}")),
                    _ => {
                        holder.insert(n, &p.id);
                    }
                }
            }
            for a in &p.after {
                if !ids.contains(a) {
                    err(format!("comes after plan {a}, which doesn't exist"));
                }
            }
        }
        // Plans wait for the plans in their `after`, and for the plans holding pending nodes their nodes link to.
        let edges: HashMap<String, Vec<String>> = self.plans.iter().map(|p| (p.id.clone(), self.waits_for(p, change, tree))).collect();
        if let Some(cycle) = find_cycle(&edges) {
            errors.push(PlanError { plan: None, message: format!("plans wait for each other: {}", cycle.join(" → ")) });
        }
        self.errors.extend(errors);
    }

    /// The plans `p` waits for.
    fn waits_for(&self, p: &Plan, change: &Change, tree: &Tree) -> Vec<String> {
        let mut out: Vec<String> = p.after.iter().filter(|a| **a != p.id).cloned().collect();
        for target in self.pending_links(p, change, tree) {
            if let Some(q) = self.plans.iter().find(|q| q.id != p.id && q.nodes.contains(&target)) {
                if !out.contains(&q.id) {
                    out.push(q.id.clone());
                }
            }
        }
        out
    }

    /// Nodes under implementation, not done and not in `p`, that `p`'s nodes link to.
    fn pending_links(&self, p: &Plan, change: &Change, tree: &Tree) -> Vec<String> {
        let imp = &change.status.implementation;
        let mut out = vec![];
        for n in &p.nodes {
            let path = if n == "." { "" } else { n.as_str() };
            for l in tree.get(path).map(|n| n.links.as_slice()).unwrap_or_default() {
                let k = show_node(l).to_string();
                if imp.get(&k) == Some(&false) && !p.nodes.contains(&k) && !out.contains(&k) {
                    out.push(k);
                }
            }
        }
        out
    }

    pub fn done(&self, p: &Plan, change: &Change) -> bool {
        p.nodes.iter().all(|n| change.status.implementation.get(n) == Some(&true))
    }

    /// Nodes under implementation, not done, that no plan holds.
    pub fn unplanned(&self, change: &Change) -> Vec<String> {
        let held: HashSet<&String> = self.plans.iter().flat_map(|p| &p.nodes).collect();
        change.status.implementation.iter().filter(|(n, done)| !**done && !held.contains(n)).map(|(n, _)| n.clone()).collect()
    }

    /// Plans that can be implemented now.
    pub fn ready(&self, change: &Change, tree: &Tree) -> Vec<&Plan> {
        let by_id: IndexMap<&String, &Plan> = self.plans.iter().map(|p| (&p.id, p)).collect();
        self.plans
            .iter()
            .filter(|p| !self.done(p, change))
            .filter(|p| p.after.iter().all(|a| by_id.get(a).is_some_and(|q| self.done(q, change))))
            .filter(|p| self.pending_links(p, change, tree).is_empty())
            .collect()
    }
}
