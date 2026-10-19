use std::fs;
use std::path::Path;

use indexmap::IndexMap;
use serde::Deserialize;

use crate::project::Project;
use crate::Issue;

#[derive(Deserialize)]
struct NodeTypeFile {
    name: Option<String>,
    description: Option<String>,
    #[serde(default)]
    code: bool,
    #[serde(default)]
    children: Vec<String>,
    #[serde(default)]
    derives_from: Vec<String>,
    #[serde(default)]
    documents: Vec<String>,
    instructions: Option<String>,
}

#[derive(Deserialize, Default)]
struct TemplateFront {
    description: Option<String>,
    required: Option<bool>,
    derives_from: Option<Vec<String>>,
    exposed: Option<bool>,
    extra: Option<bool>,
}

pub struct Template {
    pub description: Option<String>,
    pub required: bool,
    pub derives_from: Vec<String>,
    pub exposed: bool,
    pub extra: bool,
    /// The starting content of a new document.
    pub body: String,
}

pub struct NodeType {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub code: bool,
    pub children: Vec<String>,
    pub derives_from: Vec<String>,
    pub documents: Vec<String>,
    pub instructions: Option<String>,
    pub templates: IndexMap<String, Template>,
}

pub struct Types {
    pub map: IndexMap<String, NodeType>,
    /// Problems found while loading, reported by `validate`.
    pub errors: Vec<Issue>,
}

impl Types {
    pub fn get(&self, id: &str) -> Option<&NodeType> {
        self.map.get(id)
    }

    pub fn template(&self, type_id: &str, doc: &str) -> Option<&Template> {
        self.map.get(type_id).and_then(|t| t.templates.get(doc))
    }
}

/// Splits a Markdown file into its YAML frontmatter and body.
pub fn split_frontmatter(text: &str) -> (Option<&str>, &str) {
    let rest = match text.strip_prefix("---\n").or_else(|| text.strip_prefix("---\r\n")) {
        Some(r) => r,
        None => return (None, text),
    };
    let mut offset = 0;
    for line in rest.split_inclusive('\n') {
        if line.trim_end() == "---" {
            let front = &rest[..offset];
            let body = &rest[offset + line.len()..];
            return (Some(front), body.trim_start_matches(['\n', '\r']));
        }
        offset += line.len();
    }
    (None, text)
}

pub fn load(project: &Project) -> Types {
    let dir = project.types_dir();
    let mut types = Types { map: IndexMap::new(), errors: Vec::new() };
    let mut entries: Vec<_> = match fs::read_dir(&dir) {
        Ok(rd) => rd.filter_map(|e| e.ok()).collect(),
        Err(_) => {
            types.errors.push(Issue::new(project.rel(&dir), "node types directory is missing"));
            return types;
        }
    };
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let path = entry.path();
        let id = entry.file_name().to_string_lossy().to_string();
        if !path.is_dir() || id.starts_with('.') {
            continue;
        }
        if let Some(t) = load_type(project, &path, &id, &mut types.errors) {
            types.map.insert(id, t);
        }
    }
    types
}

fn load_type(project: &Project, dir: &Path, id: &str, errors: &mut Vec<Issue>) -> Option<NodeType> {
    let file = dir.join("node-type.yaml");
    let rel = project.rel(&file);
    let text = match fs::read_to_string(&file) {
        Ok(t) => t,
        Err(_) => {
            errors.push(Issue::new(project.rel(dir), "type directory has no node-type.yaml"));
            return None;
        }
    };
    let def: NodeTypeFile = match serde_yaml::from_str(&text) {
        Ok(d) => d,
        Err(e) => {
            errors.push(Issue::new(rel, format!("invalid YAML: {e}")));
            return None;
        }
    };
    if def.name.is_none() {
        errors.push(Issue::new(rel.clone(), "`name` is required"));
    }
    if def.description.is_none() {
        errors.push(Issue::new(rel.clone(), "`description` is required"));
    }
    if def.documents.is_empty() {
        errors.push(Issue::new(rel.clone(), "`documents` must list at least one document"));
    }
    let mut templates = IndexMap::new();
    for doc in &def.documents {
        let tpath = dir.join(format!("{doc}.md"));
        let trel = project.rel(&tpath);
        let text = match fs::read_to_string(&tpath) {
            Ok(t) => t,
            Err(_) => {
                errors.push(Issue::new(rel.clone(), format!("document `{doc}` has no template {doc}.md")));
                continue;
            }
        };
        let (front, body) = split_frontmatter(&text);
        let front: TemplateFront = match front {
            Some(f) => match serde_yaml::from_str::<Option<TemplateFront>>(f) {
                Ok(f) => f.unwrap_or_default(),
                Err(e) => {
                    errors.push(Issue::new(trel, format!("invalid frontmatter: {e}")));
                    continue;
                }
            },
            None => TemplateFront::default(),
        };
        if front.description.is_none() {
            errors.push(Issue::new(trel.clone(), "template frontmatter needs a `description`"));
        }
        templates.insert(
            doc.clone(),
            Template {
                description: front.description,
                required: front.required.unwrap_or(true),
                derives_from: front.derives_from.unwrap_or_default(),
                exposed: front.exposed.unwrap_or(true),
                extra: front.extra.unwrap_or(false),
                body: body.to_string(),
            },
        );
    }
    Some(NodeType {
        id: id.to_string(),
        name: def.name.unwrap_or_else(|| id.to_string()),
        description: def.description,
        code: def.code,
        children: def.children,
        derives_from: def.derives_from,
        documents: def.documents,
        instructions: def.instructions,
        templates,
    })
}
