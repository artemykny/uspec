//! Markdown sections (docs/method/spec-tree/rules.md#sections): a heading and everything under it,
//! up to the next heading of the same or a higher level, named by the heading's anchor.

/// A heading's anchor, as Markdown renderers link to it: lowercase, without characters other than
/// letters, digits, spaces, `-` and `_`, and with spaces turned into `-`.
pub fn anchor(text: &str) -> String {
    text.trim()
        .to_lowercase()
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == ' ' || *c == '-' || *c == '_')
        .map(|c| if c == ' ' { '-' } else { c })
        .collect()
}

pub struct Heading {
    pub level: usize,
    pub anchor: String,
    /// The heading's line, counted from 0.
    pub line: usize,
}

/// An ATX heading's level and text, if the line is one.
fn heading(line: &str) -> Option<(usize, &str)> {
    let indent = line.len() - line.trim_start_matches(' ').len();
    if indent > 3 {
        return None;
    }
    let rest = &line[indent..];
    let level = rest.len() - rest.trim_start_matches('#').len();
    if !(1..=6).contains(&level) {
        return None;
    }
    let text = &rest[level..];
    if !text.is_empty() && !text.starts_with([' ', '\t']) {
        return None;
    }
    // A closing sequence of `#`s isn't part of the text.
    let text = text.trim();
    let text = match text.trim_end_matches('#') {
        t if t.len() < text.len() && (t.is_empty() || t.ends_with([' ', '\t'])) => t.trim_end(),
        _ => text,
    };
    Some((level, text))
}

/// The document's headings in order, outside fenced code blocks.
pub fn headings(text: &str) -> Vec<Heading> {
    let mut out = vec![];
    let mut fence: Option<&str> = None;
    for (i, line) in text.lines().enumerate() {
        let t = line.trim_start();
        if let Some(f) = fence {
            if t.starts_with(f) {
                fence = None;
            }
            continue;
        }
        if t.starts_with("```") {
            fence = Some("```");
            continue;
        }
        if t.starts_with("~~~") {
            fence = Some("~~~");
            continue;
        }
        if let Some((level, h)) = heading(line) {
            out.push(Heading { level, anchor: anchor(h), line: i });
        }
    }
    out
}

/// The text of the section named `anchor`: its heading line and everything up to the next heading of
/// the same or a higher level. The first heading with that anchor is meant.
pub fn section(text: &str, anchor: &str) -> Option<String> {
    let hs = headings(text);
    let at = hs.iter().position(|h| h.anchor == anchor)?;
    let start = hs[at].line;
    let end = hs[at + 1..].iter().find(|h| h.level <= hs[at].level).map(|h| h.line);
    let lines: Vec<&str> = text.lines().collect();
    let end = end.unwrap_or(lines.len());
    Some(lines[start..end].join("\n").trim_end().to_string())
}

pub fn has(text: &str, anchor: &str) -> bool {
    headings(text).iter().any(|h| h.anchor == anchor)
}

/// Splits a document reference `<id>` or `<id>#<anchor>`.
pub fn split_ref(r: &str) -> (&str, Option<&str>) {
    match r.split_once('#') {
        Some((d, s)) => (d, Some(s)),
        None => (r, None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DOC: &str = "# Refunds\n\nIntro.\n\n## Refund window\n\nA refund can be requested for 14 days.\n\n### Exceptions\n\nNone.\n\n## Payout\n\nTo the card.\n\n```\n## Not a heading\n```\n";

    #[test]
    fn anchors() {
        assert_eq!(anchor("Refund window"), "refund-window");
        assert_eq!(anchor("  POST /refunds: errors (v2)! "), "post-refunds-errors-v2");
        assert_eq!(anchor("snake_case and-dash"), "snake_case-and-dash");
    }

    #[test]
    fn finds_headings_outside_code() {
        let hs: Vec<(usize, String)> = headings(DOC).into_iter().map(|h| (h.level, h.anchor)).collect();
        assert_eq!(
            hs,
            vec![(1, "refunds".into()), (2, "refund-window".into()), (3, "exceptions".into()), (2, "payout".into())]
        );
        assert!(heading("#hashtag").is_none());
        assert!(heading("    # indented code").is_none());
        assert_eq!(heading("## Closed ##"), Some((2, "Closed")));
    }

    #[test]
    fn sections_include_subsections() {
        let s = section(DOC, "refund-window").unwrap();
        assert!(s.starts_with("## Refund window"));
        assert!(s.contains("### Exceptions"));
        assert!(!s.contains("Payout"));
        assert_eq!(section(DOC, "payout").unwrap(), "## Payout\n\nTo the card.\n\n```\n## Not a heading\n```");
        assert!(section(DOC, "not-a-heading").is_none());
        assert!(has(DOC, "exceptions"));
    }
}
