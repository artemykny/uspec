//! Runs the uspec binary against a copy of examples/example_product.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::Value;

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

fn git(dir: &Path, args: &[&str]) {
    let ok = Command::new("git")
        .current_dir(dir)
        .args(["-c", "user.email=test@example.com", "-c", "user.name=test"])
        .args(args)
        .output()
        .unwrap()
        .status
        .success();
    assert!(ok, "git {args:?}");
}

struct Project {
    dir: PathBuf,
}

impl Project {
    fn example(name: &str) -> Project {
        let dir = std::env::temp_dir().join(format!("uspec-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        copy_dir(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples/example_product"), &dir);
        git(&dir, &["init", "-q"]);
        git(&dir, &["add", "-A"]);
        git(&dir, &["commit", "-qm", "init"]);
        Project { dir }
    }

    fn run(&self, args: &[&str]) -> (bool, String) {
        let out = Command::new(env!("CARGO_BIN_EXE_uspec")).current_dir(&self.dir).args(args).output().unwrap();
        let text = String::from_utf8_lossy(&out.stdout).to_string() + &String::from_utf8_lossy(&out.stderr);
        (out.status.success(), text)
    }

    fn ok(&self, args: &[&str]) -> String {
        let (ok, text) = self.run(args);
        assert!(ok, "uspec {args:?} failed:\n{text}");
        text
    }

    fn json(&self, args: &[&str]) -> Value {
        let mut a = vec!["--json"];
        a.extend_from_slice(args);
        serde_json::from_str(&self.ok(&a)).unwrap()
    }
}

impl Drop for Project {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn docs(v: &Value, key: &str) -> Vec<String> {
    v[key].as_array().unwrap().iter().map(|x| x["document"].as_str().unwrap().to_string()).collect()
}

#[test]
fn example_is_valid() {
    let p = Project::example("valid");
    assert!(p.ok(&["validate"]).starts_with("ok: 16 node types, 72 nodes"));
}

#[test]
fn change_flow() {
    let p = Project::example("flow");
    let c = "refund-window";
    p.ok(&["change", "new", c]);
    fs::write(p.dir.join("docs/product/support/refunds/rules.md"), "30 days\n").unwrap();
    let set = p.json(&["change", "set", c, "product/support/refunds/rules.md", "updated"]);
    let reached: Vec<&str> = set["propagated"].as_array().unwrap().iter().map(|x| x["document"].as_str().unwrap()).collect();
    assert!(reached.contains(&"system/services/payments/api.md"));
    assert!(reached.contains(&"experience/ops-console/refunds/states.md"));

    // First batch: payments/api.md is ready, logic.md waits for it, screens wait for payments.
    let next = p.json(&["change", "next", c]);
    let batch = docs(&next["triage"], "batch");
    assert!(batch.contains(&"system/services/payments/api.md".to_string()));
    assert!(!batch.contains(&"system/services/payments/logic.md".to_string()));
    assert!(!batch.contains(&"experience/ops-console/refunds/states.md".to_string()));

    // A reason is required.
    assert!(!p.run(&["change", "set", c, "system/services/payments/api.md", "no-change"]).0);

    // Settle everything: mark payments/logic.md affected, everything else no-change.
    let mut rounds = 0;
    loop {
        rounds += 1;
        assert!(rounds < 20, "change never settled");
        let next = p.json(&["change", "next", c]);
        if next["triage"].is_null() && next["write"].as_array().unwrap().is_empty() {
            break;
        }
        if !next["triage"].is_null() {
            for d in docs(&next["triage"], "batch") {
                let state = if d == "system/services/payments/logic.md" { "affected" } else { "no-change" };
                p.ok(&["change", "set", c, &d, state, "--reason", "test"]);
            }
        }
        for w in next["write"].as_array().unwrap() {
            for d in docs(w, "documents") {
                p.ok(&["change", "set", c, &d, "updated"]);
            }
        }
    }
    let next = p.json(&["change", "next", c]);
    let implement: Vec<&str> = next["implement"].as_array().unwrap().iter().map(|x| x["node"].as_str().unwrap()).collect();
    assert_eq!(implement, vec!["system/services/payments"]);

    // The writer's context lists the document, its upstream and the diff.
    let ctx = p.ok(&["context", "system/services/payments", "--document", "storage", "--change", c]);
    assert!(ctx.starts_with("# Instructions"));
    assert!(ctx.contains("docs/system/services/payments/logic.md"));
    assert!(ctx.contains("diff since"));

    assert!(!p.run(&["change", "close", c]).0, "close must fail while a node is pending");
    p.ok(&["change", "set", c, "system/services/payments", "done"]);
    p.ok(&["change", "close", c]);
    assert!(p.ok(&["change", "list"]).contains("No open changes"));
}

fn write_entries(next: &Value) -> Vec<(String, Vec<String>)> {
    next["write"]
        .as_array()
        .unwrap()
        .iter()
        .map(|w| (w["node"].as_str().unwrap().to_string(), docs(w, "documents")))
        .collect()
}

#[test]
fn change_next_writes_by_node() {
    let p = Project::example("write-by-node");
    let c = "refund-window";
    p.ok(&["change", "new", c]);
    fs::write(p.dir.join("docs/product/support/refunds/rules.md"), "30 days\n").unwrap();
    p.ok(&["change", "set", c, "product/support/refunds/rules.md", "updated"]);

    // api.md and compliance.md are ready together; logic.md derives from api.md and waits.
    let api = "system/services/payments/api.md";
    let compliance = "system/services/payments/compliance.md";
    let next = p.json(&["change", "next", c]);
    let batch = docs(&next["triage"], "batch");
    assert!(batch.contains(&api.to_string()) && batch.contains(&compliance.to_string()));
    for d in &batch {
        let state = if d == api || d == compliance { "affected" } else { "no-change" };
        p.ok(&["change", "set", c, d, state, "--reason", "test"]);
    }

    // One writer for both documents of the node.
    let next = p.json(&["change", "next", c]);
    let write = write_entries(&next);
    let payments: Vec<&(String, Vec<String>)> = write.iter().filter(|(n, _)| n == "system/services/payments").collect();
    assert_eq!(payments.len(), 1, "one entry per node: {write:?}");
    assert_eq!(payments[0].1, vec![api.to_string(), compliance.to_string()]);
    assert!(next["write"][0]["documents"][0]["path"].as_str().unwrap().starts_with("docs/"));
    let text = p.ok(&["change", "next", c]);
    assert!(text.contains("write:\n  system/services/payments\n    docs/system/services/payments/api.md\n"), "{text}");

    // logic.md becomes ready once api.md is written: a second writer for the same node.
    p.ok(&["change", "set", c, api, "updated"]);
    p.ok(&["change", "set", c, compliance, "updated"]);
    let next = p.json(&["change", "next", c]);
    let batch = docs(&next["triage"], "batch");
    let logic = "system/services/payments/logic.md";
    assert!(batch.contains(&logic.to_string()));
    p.ok(&["change", "set", c, logic, "affected", "--reason", "test"]);
    let next = p.json(&["change", "next", c]);
    let write = write_entries(&next);
    assert!(write.contains(&("system/services/payments".to_string(), vec![logic.to_string()])), "{write:?}");
}

#[test]
fn node_commands() {
    let p = Project::example("node");
    p.ok(&["node", "new", "product/support/disputes", "--type", "feature"]);
    assert!(!p.run(&["node", "new", "product/support/x", "--type", "service"]).0);
    p.ok(&[
        "node", "new", "system/services/disputes", "--type", "service",
        "--derives-from", "product/support/disputes", "--code", "services/disputes/",
    ]);
    p.ok(&["node", "move", "product/support/disputes", "product/ordering/disputes"]);
    let yaml = fs::read_to_string(p.dir.join("docs/system/services/disputes/node.yaml")).unwrap();
    assert!(yaml.contains("product/ordering/disputes"));
    assert!(!p.run(&["node", "remove", "product/ordering/disputes"]).0, "remove must fail while linked");
    p.ok(&["node", "remove", "system/services/disputes"]);
    p.ok(&["node", "remove", "product/ordering/disputes"]);
    p.ok(&["validate"]);
}

#[test]
fn validate_reports_errors() {
    let p = Project::example("errors");
    fs::write(p.dir.join("docs/product/stray.txt"), "x").unwrap();
    fs::remove_file(p.dir.join("docs/product/ordering/cart/user-story.md")).unwrap();
    let v = p.run(&["--json", "validate"]);
    assert!(!v.0);
    let j: Value = serde_json::from_str(&v.1).unwrap();
    let msgs: Vec<&str> = j["errors"].as_array().unwrap().iter().map(|e| e["message"].as_str().unwrap()).collect();
    assert!(msgs.iter().any(|m| m.contains("isn't node.yaml or a document")));
    assert!(msgs.iter().any(|m| m.contains("missing required document user-story.md")));
}

#[test]
fn types_lists_documents() {
    let p = Project::example("types");
    let v = p.json(&["types"]);
    let types = v["types"].as_array().unwrap();
    assert_eq!(types.len(), 16);
    let service = types.iter().find(|t| t["type"] == "service").unwrap();
    assert_eq!(service["code"], true);
    assert_eq!(service["path"], ".uspec/node-types/service/node-type.yaml");
    let docs = service["documents"].as_array().unwrap();
    let ids: Vec<&str> = docs.iter().map(|d| d["document"].as_str().unwrap()).collect();
    assert_eq!(ids, vec!["api", "logic", "storage", "events", "compliance"]);
    let logic = &docs[1];
    assert_eq!(logic["exposed"], false);
    assert_eq!(logic["derives_from"][0], "api");
    assert_eq!(logic["template"], ".uspec/node-types/service/logic.md");
    assert_eq!(docs[0]["extra"], true);
    assert_eq!(docs[2]["required"], false);
    assert!(p.ok(&["types"]).contains("logic.md        internal, derives from api"));
}
