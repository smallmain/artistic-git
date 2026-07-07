use std::borrow::Cow;
use std::collections::BTreeMap;

use serde::Serialize;
use specta::Type;

pub const OVERSIZED_TEXT_BYTES: usize = 1024 * 1024;
pub const OVERSIZED_TEXT_CHANGED_LINES: usize = 5000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum DiffChangeKind {
    Added,
    Modified,
    Deleted,
    Renamed,
    Copied,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum DiffFileKind {
    Text,
    Binary,
    Image,
    LfsPointer,
    OversizedText,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DiffClassification {
    pub old_path: Option<String>,
    pub new_path: String,
    pub change_kind: DiffChangeKind,
    pub file_kind: DiffFileKind,
    pub pure_rename: bool,
    pub metadata: BTreeMap<String, String>,
}

#[derive(Debug, Clone)]
pub struct DiffFileProbe<'a> {
    pub old_path: Option<Cow<'a, str>>,
    pub new_path: Cow<'a, str>,
    pub change_kind: DiffChangeKind,
    pub old_content: Option<&'a [u8]>,
    pub new_content: Option<&'a [u8]>,
    pub old_display_content: Option<&'a [u8]>,
    pub new_display_content: Option<&'a [u8]>,
    pub git_binary_patch: bool,
    pub changed_lines: usize,
}

impl<'a> DiffFileProbe<'a> {
    pub fn new(new_path: impl Into<Cow<'a, str>>, change_kind: DiffChangeKind) -> Self {
        Self {
            old_path: None,
            new_path: new_path.into(),
            change_kind,
            old_content: None,
            new_content: None,
            old_display_content: None,
            new_display_content: None,
            git_binary_patch: false,
            changed_lines: 0,
        }
    }
}

pub fn classify_diff_file(probe: DiffFileProbe<'_>) -> DiffClassification {
    let representative_content = probe
        .new_display_content
        .or(probe.old_display_content)
        .or(probe.new_content)
        .or(probe.old_content)
        .unwrap_or_default();
    let representative_pointer = probe
        .new_content
        .and_then(parse_lfs_pointer)
        .or_else(|| probe.old_content.and_then(parse_lfs_pointer));
    let mut metadata = BTreeMap::new();

    if let Some(old_content) = probe.old_content {
        let old_bytes = probe.old_display_content.unwrap_or(old_content).len();
        metadata.insert("oldBytes".to_owned(), old_bytes.to_string());
    }

    if let Some(new_content) = probe.new_content {
        let new_bytes = probe.new_display_content.unwrap_or(new_content).len();
        metadata.insert("newBytes".to_owned(), new_bytes.to_string());
    }

    metadata.insert("changedLines".to_owned(), probe.changed_lines.to_string());

    let pure_rename = probe.change_kind == DiffChangeKind::Renamed
        && probe.old_content.is_some()
        && probe.new_content.is_some()
        && probe.old_content == probe.new_content;

    metadata.insert("contentChanged".to_owned(), (!pure_rename).to_string());

    let file_kind = if let Some(pointer) = representative_pointer {
        metadata.insert("lfsOid".to_owned(), pointer.oid);
        metadata.insert("lfsSize".to_owned(), pointer.size.to_string());
        let resolved = probe.new_display_content.or(probe.old_display_content);
        metadata.insert("lfsResolved".to_owned(), resolved.is_some().to_string());
        if let Some(resolved_content) = resolved {
            add_image_metadata(resolved_content, &mut metadata);
            classify_resolved_content(
                resolved_content,
                probe.git_binary_patch,
                probe.changed_lines,
            )
        } else {
            DiffFileKind::LfsPointer
        }
    } else if let Some(image) = detect_image(representative_content) {
        insert_image_metadata(image, &mut metadata);
        DiffFileKind::Image
    } else {
        classify_resolved_content(
            representative_content,
            probe.git_binary_patch,
            probe.changed_lines,
        )
    };

    DiffClassification {
        old_path: probe.old_path.map(Cow::into_owned),
        new_path: probe.new_path.into_owned(),
        change_kind: probe.change_kind,
        file_kind,
        pure_rename,
        metadata,
    }
}

fn add_image_metadata(content: &[u8], metadata: &mut BTreeMap<String, String>) {
    if let Some(image) = detect_image(content) {
        insert_image_metadata(image, metadata);
    }
}

fn insert_image_metadata(image: ImageInfo, metadata: &mut BTreeMap<String, String>) {
    metadata.insert("mimeType".to_owned(), image.mime_type.to_owned());
    if let Some((width, height)) = image.dimensions {
        metadata.insert("imageWidth".to_owned(), width.to_string());
        metadata.insert("imageHeight".to_owned(), height.to_string());
    }
}

fn classify_resolved_content(
    content: &[u8],
    git_binary_patch: bool,
    changed_lines: usize,
) -> DiffFileKind {
    if parse_lfs_pointer(content).is_some() {
        DiffFileKind::LfsPointer
    } else if detect_image(content).is_some() {
        DiffFileKind::Image
    } else if is_binary(content, git_binary_patch) {
        DiffFileKind::Binary
    } else if is_oversized_text(content, changed_lines) {
        DiffFileKind::OversizedText
    } else {
        DiffFileKind::Text
    }
}

pub fn is_binary(content: &[u8], git_binary_patch: bool) -> bool {
    git_binary_patch || content.contains(&0)
}

pub fn is_oversized_text(content: &[u8], changed_lines: usize) -> bool {
    content.len() > OVERSIZED_TEXT_BYTES || changed_lines > OVERSIZED_TEXT_CHANGED_LINES
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LfsPointer {
    pub oid: String,
    pub size: u64,
}

pub fn parse_lfs_pointer(content: &[u8]) -> Option<LfsPointer> {
    if content.len() > 1024 {
        return None;
    }

    let text = std::str::from_utf8(content).ok()?;
    let mut lines = text.lines();

    if lines.next()? != "version https://git-lfs.github.com/spec/v1" {
        return None;
    }

    let mut oid = None;
    let mut size = None;

    for line in lines {
        if let Some(value) = line.strip_prefix("oid sha256:") {
            if value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                oid = Some(value.to_owned());
            }
        } else if let Some(value) = line.strip_prefix("size ") {
            size = value.parse::<u64>().ok();
        }
    }

    Some(LfsPointer {
        oid: oid?,
        size: size?,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageInfo {
    pub mime_type: &'static str,
    pub dimensions: Option<(u32, u32)>,
}

pub fn detect_image(content: &[u8]) -> Option<ImageInfo> {
    if content.starts_with(b"\x89PNG\r\n\x1a\n") && content.len() >= 24 {
        return Some(ImageInfo {
            mime_type: "image/png",
            dimensions: Some((be_u32(content, 16)?, be_u32(content, 20)?)),
        });
    }

    if content.starts_with(b"\xff\xd8") {
        return Some(ImageInfo {
            mime_type: "image/jpeg",
            dimensions: jpeg_dimensions(content),
        });
    }

    if (content.starts_with(b"GIF87a") || content.starts_with(b"GIF89a")) && content.len() >= 10 {
        return Some(ImageInfo {
            mime_type: "image/gif",
            dimensions: Some((le_u16(content, 6)? as u32, le_u16(content, 8)? as u32)),
        });
    }

    if content.starts_with(b"BM") && content.len() >= 26 {
        let width = le_i32(content, 18)?.unsigned_abs();
        let height = le_i32(content, 22)?.unsigned_abs();
        return Some(ImageInfo {
            mime_type: "image/bmp",
            dimensions: Some((width, height)),
        });
    }

    if content.starts_with(b"RIFF") && content.get(8..12) == Some(b"WEBP") {
        return Some(ImageInfo {
            mime_type: "image/webp",
            dimensions: webp_dimensions(content),
        });
    }

    if let Ok(text) = std::str::from_utf8(content) {
        if looks_like_svg(text) {
            return Some(ImageInfo {
                mime_type: "image/svg+xml",
                dimensions: svg_dimensions(text),
            });
        }
    }

    None
}

fn be_u32(content: &[u8], offset: usize) -> Option<u32> {
    Some(u32::from_be_bytes(
        content.get(offset..offset + 4)?.try_into().ok()?,
    ))
}

fn le_u16(content: &[u8], offset: usize) -> Option<u16> {
    Some(u16::from_le_bytes(
        content.get(offset..offset + 2)?.try_into().ok()?,
    ))
}

fn le_i32(content: &[u8], offset: usize) -> Option<i32> {
    Some(i32::from_le_bytes(
        content.get(offset..offset + 4)?.try_into().ok()?,
    ))
}

fn le_u24_plus_one(content: &[u8], offset: usize) -> Option<u32> {
    let bytes = content.get(offset..offset + 3)?;
    Some(u32::from(bytes[0]) + (u32::from(bytes[1]) << 8) + (u32::from(bytes[2]) << 16) + 1)
}

fn jpeg_dimensions(content: &[u8]) -> Option<(u32, u32)> {
    let mut offset = 2;

    while offset + 9 < content.len() {
        if content[offset] != 0xff {
            return None;
        }

        let marker = content[offset + 1];
        offset += 2;

        if marker == 0xd8 || marker == 0xd9 {
            continue;
        }

        let segment_len = u16::from_be_bytes(content.get(offset..offset + 2)?.try_into().ok()?);
        let segment_len = usize::from(segment_len);

        if matches!(
            marker,
            0xc0 | 0xc1
                | 0xc2
                | 0xc3
                | 0xc5
                | 0xc6
                | 0xc7
                | 0xc9
                | 0xca
                | 0xcb
                | 0xcd
                | 0xce
                | 0xcf
        ) {
            let height = u16::from_be_bytes(content.get(offset + 3..offset + 5)?.try_into().ok()?);
            let width = u16::from_be_bytes(content.get(offset + 5..offset + 7)?.try_into().ok()?);
            return Some((u32::from(width), u32::from(height)));
        }

        if segment_len < 2 {
            return None;
        }

        offset += segment_len;
    }

    None
}

fn webp_dimensions(content: &[u8]) -> Option<(u32, u32)> {
    if content.get(12..16) == Some(b"VP8X") && content.len() >= 30 {
        return Some((le_u24_plus_one(content, 24)?, le_u24_plus_one(content, 27)?));
    }

    None
}

fn looks_like_svg(text: &str) -> bool {
    let trimmed = text.trim_start();
    trimmed.starts_with("<svg") || (trimmed.starts_with("<?xml") && trimmed.contains("<svg"))
}

fn svg_dimensions(text: &str) -> Option<(u32, u32)> {
    Some((
        svg_numeric_attribute(text, "width")?,
        svg_numeric_attribute(text, "height")?,
    ))
}

fn svg_numeric_attribute(text: &str, name: &str) -> Option<u32> {
    let offset = text.find(name)?;
    let after_name = text.get(offset + name.len()..)?.trim_start();
    let value = after_name.strip_prefix('=')?.trim_start();
    let quote = value.chars().next()?;

    if quote != '"' && quote != '\'' {
        return None;
    }

    let value = value.get(1..)?;
    let raw_number = value
        .chars()
        .take_while(|character| character.is_ascii_digit() || *character == '.')
        .collect::<String>();

    raw_number
        .parse::<f32>()
        .ok()
        .map(|value| value.round() as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_plain_text() {
        let mut probe = DiffFileProbe::new("notes.asset", DiffChangeKind::Modified);
        probe.new_content = Some(b"plain text\nwithout extension hints\n");
        probe.changed_lines = 2;

        let classification = classify_diff_file(probe);

        assert_eq!(classification.file_kind, DiffFileKind::Text);
        assert_eq!(classification.metadata["changedLines"], "2");
    }

    #[test]
    fn classifies_null_byte_content_as_binary_without_extension() {
        let mut probe = DiffFileProbe::new("unknown", DiffChangeKind::Modified);
        probe.new_content = Some(b"abc\0def");

        let classification = classify_diff_file(probe);

        assert_eq!(classification.file_kind, DiffFileKind::Binary);
    }

    #[test]
    fn honors_git_binary_patch_marker() {
        let mut probe = DiffFileProbe::new("generated.txt", DiffChangeKind::Modified);
        probe.new_content = Some(b"text-shaped content");
        probe.git_binary_patch = true;

        let classification = classify_diff_file(probe);

        assert_eq!(classification.file_kind, DiffFileKind::Binary);
    }

    #[test]
    fn detects_lfs_pointer_and_metadata() {
        let pointer = b"version https://git-lfs.github.com/spec/v1\n\
oid sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\n\
size 10485760\n";
        let mut probe = DiffFileProbe::new("texture.png", DiffChangeKind::Modified);
        probe.new_content = Some(pointer);

        let classification = classify_diff_file(probe);

        assert_eq!(classification.file_kind, DiffFileKind::LfsPointer);
        assert_eq!(classification.metadata["lfsSize"], "10485760");
        assert_eq!(
            classification.metadata["lfsOid"],
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
        );
    }

    #[test]
    fn classifies_resolved_lfs_content_instead_of_pointer() {
        let pointer = b"version https://git-lfs.github.com/spec/v1\n\
oid sha256:abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd\n\
size 12\n";
        let mut probe = DiffFileProbe::new("asset.txt", DiffChangeKind::Modified);
        probe.new_content = Some(pointer);
        probe.new_display_content = Some(b"actual text\n");

        let classification = classify_diff_file(probe);

        assert_eq!(classification.file_kind, DiffFileKind::Text);
        assert_eq!(classification.metadata["lfsResolved"], "true");
        assert_eq!(classification.metadata["newBytes"], "12");
        assert_eq!(
            classification.metadata["lfsOid"],
            "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd"
        );
    }

    #[test]
    fn records_lfs_metadata_when_old_side_is_pointer_and_new_side_is_content() {
        let pointer = b"version https://git-lfs.github.com/spec/v1\n\
oid sha256:abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd\n\
size 9\n";
        let mut probe = DiffFileProbe::new("asset.txt", DiffChangeKind::Modified);
        probe.old_content = Some(pointer);
        probe.old_display_content = Some(b"old text\n");
        probe.new_content = Some(b"new text\n");
        probe.new_display_content = Some(b"new text\n");

        let classification = classify_diff_file(probe);

        assert_eq!(classification.file_kind, DiffFileKind::Text);
        assert_eq!(classification.metadata["lfsResolved"], "true");
        assert_eq!(
            classification.metadata["lfsOid"],
            "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd"
        );
    }

    #[test]
    fn classifies_resolved_lfs_image_and_keeps_image_metadata() {
        let pointer = b"version https://git-lfs.github.com/spec/v1\n\
oid sha256:abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd\n\
size 24\n";
        let png = [
            0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n', 0, 0, 0, 13, b'I', b'H', b'D', b'R',
            0, 0, 0, 3, 0, 0, 0, 4,
        ];
        let mut probe = DiffFileProbe::new("asset.png", DiffChangeKind::Modified);
        probe.new_content = Some(pointer);
        probe.new_display_content = Some(&png);

        let classification = classify_diff_file(probe);

        assert_eq!(classification.file_kind, DiffFileKind::Image);
        assert_eq!(classification.metadata["lfsResolved"], "true");
        assert_eq!(classification.metadata["mimeType"], "image/png");
        assert_eq!(classification.metadata["imageWidth"], "3");
        assert_eq!(classification.metadata["imageHeight"], "4");
    }

    #[test]
    fn detects_png_by_magic_bytes_and_dimensions_without_extension() {
        let png = [
            0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n', 0, 0, 0, 13, b'I', b'H', b'D', b'R',
            0, 0, 0, 10, 0, 0, 0, 20,
        ];
        let mut probe = DiffFileProbe::new("asset", DiffChangeKind::Added);
        probe.new_content = Some(&png);

        let classification = classify_diff_file(probe);

        assert_eq!(classification.file_kind, DiffFileKind::Image);
        assert_eq!(classification.metadata["mimeType"], "image/png");
        assert_eq!(classification.metadata["imageWidth"], "10");
        assert_eq!(classification.metadata["imageHeight"], "20");
    }

    #[test]
    fn detects_svg_as_image_content() {
        let mut probe = DiffFileProbe::new("vector.txt", DiffChangeKind::Added);
        probe.new_content = Some(br#"<svg width="320" height="180"></svg>"#);

        let classification = classify_diff_file(probe);

        assert_eq!(classification.file_kind, DiffFileKind::Image);
        assert_eq!(classification.metadata["mimeType"], "image/svg+xml");
        assert_eq!(classification.metadata["imageWidth"], "320");
        assert_eq!(classification.metadata["imageHeight"], "180");
    }

    #[test]
    fn classifies_oversized_text_by_size_or_changed_lines() {
        let large = vec![b'a'; OVERSIZED_TEXT_BYTES + 1];
        let mut by_size = DiffFileProbe::new("large.txt", DiffChangeKind::Modified);
        by_size.new_content = Some(&large);

        let mut by_lines = DiffFileProbe::new("many-lines.txt", DiffChangeKind::Modified);
        by_lines.new_content = Some(b"small");
        by_lines.changed_lines = OVERSIZED_TEXT_CHANGED_LINES + 1;

        assert_eq!(
            classify_diff_file(by_size).file_kind,
            DiffFileKind::OversizedText
        );
        assert_eq!(
            classify_diff_file(by_lines).file_kind,
            DiffFileKind::OversizedText
        );
    }

    #[test]
    fn marks_pure_rename_when_content_is_unchanged() {
        let mut probe = DiffFileProbe::new("new/name.txt", DiffChangeKind::Renamed);
        probe.old_path = Some("old/name.txt".into());
        probe.old_content = Some(b"same");
        probe.new_content = Some(b"same");

        let classification = classify_diff_file(probe);

        assert_eq!(classification.file_kind, DiffFileKind::Text);
        assert!(classification.pure_rename);
        assert_eq!(classification.metadata["contentChanged"], "false");
    }
}
