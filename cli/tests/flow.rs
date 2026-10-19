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

/// Replaces text in a file of the project.
fn edit(p: &Project, file: &str, from: &str, to: &str) {
    let path = p.dir.join(file);
    let text = fs::read_to_string(&path).unwrap();
    assert!(text.contains(from), "{file} has no {from:?}");
    fs::write(&path, text.replacen(from, to, 1)).unwrap();
}

const RULES: &str = "docs/product/support/refunds/rules.md";

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
    edit(&p, RULES, "14 days", "30 days");
    let set = p.json(&["change", "set", c, "product/support/refunds/rules.md", "updated"]);
    let reached: Vec<&str> = set["propagated"].as_array().unwrap().iter().map(|x| x["document"].as_str().unwrap()).collect();
    assert!(reached.contains(&"system/services/payments/api.md"));
    assert!(reached.contains(&"experience/ops-console/refunds/states.md"), "the refund window section changed");
    let via = set["propagated"].as_array().unwrap().iter().find(|x| x["document"] == "experience/ops-console/refunds/states.md").unwrap();
    assert_eq!(via["via"], "links to product/support/refunds/rules.md#refund-window");

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
    // The code is planned before it is implemented.
    let next = p.json(&["change", "next", c]);
    assert!(next["implement"].as_array().unwrap().is_empty());
    assert_eq!(next["plan"]["nodes"], serde_json::json!(["system/services/payments"]));
    assert_eq!(next["plan"]["dir"], ".uspec/changes/refund-window/plans/");
    fs::create_dir_all(p.dir.join(".uspec/changes/refund-window/plans")).unwrap();
    fs::write(p.dir.join(".uspec/changes/refund-window/plans/payments.md"), "---\nnodes: [system/services/payments]\n---\n\n# Payments\n").unwrap();
    let next = p.json(&["change", "next", c]);
    assert!(next["plan"].is_null());
    assert_eq!(next["implement"], serde_json::json!([{ "plan": "payments", "path": ".uspec/changes/refund-window/plans/payments.md", "nodes": ["system/services/payments"] }]));
    assert!(p.ok(&["change", "next", c]).contains("implement:\n  payments   .uspec/changes/refund-window/plans/payments.md\n    system/services/payments\n"));
    assert!(p.ok(&["change", "status", c]).contains("plans:\n  payments   pending  system/services/payments"));

    // The writer's context lists the document, its upstream and the diff.
    let ctx = p.ok(&["context", "system/services/payments", "--document", "storage", "--change", c]);
    assert!(ctx.starts_with("# Instructions"));
    assert!(ctx.contains("docs/system/services/payments/logic.md"));
    assert!(ctx.contains("diff since"));

    assert!(!p.run(&["change", "close", c]).0, "close must fail while a node is pending");
    p.ok(&["change", "set", c, "system/services/payments", "done"]);
    assert!(p.json(&["change", "next", c])["implement"].as_array().unwrap().is_empty(), "the plan is done");
    assert_eq!(p.json(&["change", "status", c])["plans"][0]["state"], "done");
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
    edit(&p, RULES, "14 days", "30 days");
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

#[test]
fn impact_records_starting_documents() {
    let p = Project::example("impact");
    let c = "refund-window";
    p.ok(&["change", "new", c]);
    let md = fs::read_to_string(p.dir.join(".uspec/changes/refund-window/change.md")).unwrap();
    assert!(md.contains("## Worked example"), "change.md starts from the template");

    // The impact step is due while the change has no documents.
    let next = p.json(&["change", "next", c]);
    assert_eq!(next["impact"]["read"][0]["path"], ".uspec/changes/refund-window/change.md");
    assert!(p.ok(&["change", "next", c]).starts_with("impact:\n  read:\n    .uspec/changes/refund-window/change.md\n"));

    // A starting document is affected, reached via change.md, and gets a writer.
    let rules = "product/support/refunds/rules.md";
    assert!(!p.run(&["change", "set", c, rules, "affected"]).0, "a reason is required");
    p.ok(&["change", "set", c, rules, "affected", "--reason", "The window section says 14 days"]);
    let status = p.json(&["change", "status", c]);
    assert_eq!(status["documents"][0]["via"], serde_json::json!(["change.md"]));
    assert_eq!(status["documents"][0]["state"], "affected");
    let next = p.json(&["change", "next", c]);
    assert!(next["impact"].is_null());
    assert_eq!(write_entries(&next), vec![("product/support/refunds".to_string(), vec![rules.to_string()])]);

    // no-change still needs a candidate.
    assert!(!p.run(&["change", "set", c, "product/support/refunds/user-story.md", "no-change", "--reason", "x"]).0);
}

#[test]
fn sections_limit_propagation() {
    let p = Project::example("sections");
    let c = "payout";
    p.ok(&["change", "new", c]);
    // Only the payout section changes: the screen that links to the refund window isn't reached.
    edit(&p, RULES, "original payment method", "customer's wallet");
    let set = p.json(&["change", "set", c, "product/support/refunds/rules.md", "updated"]);
    let reached: Vec<&str> = set["propagated"].as_array().unwrap().iter().map(|x| x["document"].as_str().unwrap()).collect();
    assert!(reached.contains(&"system/services/payments/api.md"), "payments links to the whole feature");
    assert!(!reached.iter().any(|d| d.starts_with("experience/ops-console/refunds/")), "{reached:?}");

    // The screen's context reads only the section.
    let ctx = p.ok(&["context", "experience/ops-console/refunds", "--document", "states"]);
    assert!(ctx.contains("  docs/product/support/refunds/rules.md#refund-window\n"), "{ctx}");
    let j = p.json(&["context", "experience/ops-console/refunds", "--document", "states"]);
    let up = j["files"]["upstream"].as_array().unwrap();
    assert_eq!(up[0], serde_json::json!({ "path": "docs/product/support/refunds/rules.md", "section": "refund-window", "note": null }));
}

#[test]
fn section_links_are_validated_and_kept() {
    let p = Project::example("section-links");
    let screen = "docs/experience/ops-console/refunds/node.yaml";
    edit(&p, screen, "#refund-window", "#window");
    let (ok, text) = p.run(&["validate"]);
    assert!(!ok);
    assert!(text.contains("links to product/support/refunds/rules.md#window, which has no such section"), "{text}");
    edit(&p, screen, "rules.md#window", "logic.md");
    assert!(p.run(&["validate"]).1.contains("links to product/support/refunds/logic.md, which doesn't exist"));
    edit(&p, screen, "product/support/refunds/logic.md", "system/services/payments/logic.md");
    assert!(p.run(&["validate"]).1.contains("links to system/services/payments/logic.md, which is internal to system/services/payments"));
    edit(&p, screen, "system/services/payments/logic.md", "product/support/refunds#x");
    assert!(p.run(&["validate"]).1.contains("invalid link `product/support/refunds#x`"));
    edit(&p, screen, "product/support/refunds#x", "product/support/refunds/rules.md#refund-window");
    p.ok(&["validate"]);

    // Moving the feature keeps the document and section; removing it is blocked by the section link.
    p.ok(&["node", "move", "product/support/refunds", "product/ordering/refunds"]);
    let yaml = fs::read_to_string(p.dir.join(screen)).unwrap();
    assert!(yaml.contains("  - product/ordering/refunds/rules.md#refund-window\n"), "{yaml}");
    let (ok, text) = p.run(&["node", "remove", "product/ordering/refunds"]);
    assert!(!ok && text.contains("experience/ops-console/refunds links to product/ordering/refunds/rules.md#refund-window"), "{text}");
    p.ok(&["validate"]);

    // A new node can link to a section, and not to one that doesn't exist.
    p.ok(&["node", "new", "product/support/disputes", "--type", "feature"]);
    let (ok, text) = p.run(&[
        "node", "new", "system/services/disputes", "--type", "service",
        "--derives-from", "product/ordering/refunds/rules.md#nope", "--code", "services/disputes/",
    ]);
    assert!(!ok && text.contains("can't link to product/ordering/refunds/rules.md#nope: it has no such section"), "{text}");
    p.ok(&[
        "node", "new", "system/services/disputes", "--type", "service",
        "--derives-from", "product/ordering/refunds/rules.md#payout", "--code", "services/disputes/",
    ]);
    p.ok(&["validate"]);
}

#[test]
fn plans_are_checked() {
    let p = Project::example("plans");
    let c = "plans";
    p.ok(&["change", "new", c]);
    // Two nodes to implement: the payments service and the ops console screen, which links to it.
    p.ok(&["change", "set", c, "system/services/payments/logic.md", "updated"]);
    p.ok(&["change", "set", c, "experience/ops-console/refunds/states.md", "updated"]);
    loop {
        let next = p.json(&["change", "next", c]);
        let batch = if next["triage"].is_null() { vec![] } else { docs(&next["triage"], "batch") };
        if batch.is_empty() {
            break;
        }
        for d in batch {
            p.ok(&["change", "set", c, &d, "no-change", "--reason", "test"]);
        }
    }
    let next = p.json(&["change", "next", c]);
    assert_eq!(next["plan"]["nodes"], serde_json::json!(["system/services/payments", "experience/ops-console/refunds"]));
    let dir = p.dir.join(".uspec/changes/plans/plans");
    fs::create_dir_all(&dir).unwrap();
    let plan = |id: &str, body: &str| fs::write(dir.join(format!("{id}.md")), body).unwrap();
    let errors = |p: &Project| -> Vec<String> {
        p.json(&["change", "next", c])["plan_errors"].as_array().unwrap().iter().map(|e| e["message"].as_str().unwrap().to_string()).collect()
    };

    // Independent plans: the screen's plan waits for the service's through the link.
    plan("payments", "---\nnodes: [system/services/payments]\n---\n# Payments\n");
    let next = p.json(&["change", "next", c]);
    assert_eq!(next["plan"]["nodes"], serde_json::json!(["experience/ops-console/refunds"]), "only the unplanned node is left");
    assert!(next["implement"].as_array().unwrap().is_empty(), "nothing is implemented until everything is planned");
    plan("screen", "---\nnodes: [docs/experience/ops-console/refunds]\n---\n# Screen\n");
    let ready = |p: &Project| -> Vec<String> {
        p.json(&["change", "next", c])["implement"].as_array().unwrap().iter().map(|x| x["plan"].as_str().unwrap().to_string()).collect()
    };
    assert_eq!(ready(&p), vec!["payments"]);
    p.ok(&["change", "set", c, "system/services/payments", "done"]);
    assert_eq!(ready(&p), vec!["screen"]);

    // Errors block implementation.
    plan("bad", "# no frontmatter\n");
    assert_eq!(errors(&p), vec!["has no frontmatter with `nodes`"]);
    assert!(p.json(&["change", "next", c])["implement"].as_array().unwrap().is_empty());
    assert!(p.ok(&["change", "next", c]).contains("plan errors:\n  bad: has no frontmatter with `nodes`\n"));
    plan("bad", "---\nnodes: [experience/ops-console/refunds, product/support]\nafter: [nope]\n---\n");
    let e = errors(&p);
    assert!(e.contains(&"product/support isn't under implementation".to_string()), "{e:?}");
    assert!(e.contains(&"experience/ops-console/refunds is also in plan screen".to_string()) || e.contains(&"experience/ops-console/refunds is also in plan bad".to_string()), "{e:?}");
    assert!(e.contains(&"comes after plan nope, which doesn't exist".to_string()), "{e:?}");
    fs::remove_file(dir.join("bad.md")).unwrap();

    // A cycle through `after` and links.
    p.ok(&["change", "set", c, "system/services/payments/logic.md", "updated"]);
    plan("payments", "---\nnodes: [system/services/payments]\nafter: [screen]\n---\n");
    assert!(errors(&p).iter().any(|m| m.starts_with("plans wait for each other: ")), "{:?}", errors(&p));
}

#[test]
fn templates_derive_from_sections() {
    let p = Project::example("template-sections");
    let tpl = ".uspec/node-types/service/logic.md";
    edit(&p, tpl, "derives_from: [api]", "derives_from: [api#post-authorizations]");
    // Every service must have the section; only payments' api.md is written in the example.
    let text = p.run(&["validate"]).1;
    assert!(text.contains("docs/system/services/orders/logic.md: derives from api.md#post-authorizations, which has no such section"), "{text}");
    assert!(!text.contains("services/payments/"), "{text}");
    // The writer of logic.md reads only that section of api.md.
    let ctx = p.ok(&["context", "system/services/payments", "--document", "logic"]);
    assert!(ctx.contains("  docs/system/services/payments/api.md#post-authorizations\n"), "{ctx}");

    // A change elsewhere in api.md doesn't reach logic.md; a change in the section does.
    let c = "capture";
    p.ok(&["change", "new", c]);
    let api = "docs/system/services/payments/api.md";
    edit(&p, api, "## POST /authorizations/{id}/capture", "## POST /authorizations/{id}/capture\n\nCaptures in full.");
    let set = p.json(&["change", "set", c, "system/services/payments/api.md", "updated"]);
    let reached: Vec<&str> = set["propagated"].as_array().unwrap().iter().map(|x| x["document"].as_str().unwrap()).collect();
    assert!(!reached.contains(&"system/services/payments/logic.md"), "{reached:?}");
    edit(&p, api, "### Request", "### Request\n\nIdempotent.");
    let set = p.json(&["change", "set", c, "system/services/payments/api.md", "updated"]);
    let logic = set["propagated"].as_array().unwrap().iter().find(|x| x["document"] == "system/services/payments/logic.md").unwrap();
    assert_eq!(logic["via"], "derives from api.md#post-authorizations");

    edit(&p, tpl, "api#post-authorizations", "api#nope");
    let (ok, text) = p.run(&["validate"]);
    assert!(!ok && text.contains("docs/system/services/payments/logic.md: derives from api.md#nope, which has no such section"), "{text}");
}
