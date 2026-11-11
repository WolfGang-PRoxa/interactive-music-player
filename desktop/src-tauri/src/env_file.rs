//! Lecture et écriture du fichier `.env` du bot.
//!
//! Même discipline que `tools/start-bot.ps1` : on lit ce dont l'application a
//! besoin (jeton, port, adresse publique), et l'on n'écrit que les clés
//! demandées, sans toucher au reste du fichier. Les commentaires de
//! `.env.example` expliquent chaque variable ; réécrire le fichier en deux
//! lignes priverait l'utilisateur de tout ce qu'il voudrait régler ensuite.

use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::Path;

/// Valeur de démonstration laissée par `.env.example`.
pub const PLACEHOLDER_TOKEN: &str = "your_bot_token_here";

/// Les paires clé/valeur du fichier, à la manière de dotenv.
///
/// Un fichier absent ou illisible rend une table vide : c'est l'état normal
/// d'une première installation, pas une erreur.
pub fn read(path: &Path) -> HashMap<String, String> {
    let mut values = HashMap::new();
    let Ok(text) = fs::read_to_string(path) else {
        return values;
    };
    // Un BOM collerait au nom de la première variable, qui deviendrait
    // introuvable — dotenv a le même travers, d'où l'écriture sans BOM.
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    for line in text.lines() {
        if let Some((key, value)) = parse_line(line) {
            values.insert(key, value);
        }
    }
    values
}

fn parse_line(line: &str) -> Option<(String, String)> {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with('#') {
        return None;
    }
    let trimmed = trimmed.strip_prefix("export ").unwrap_or(trimmed);
    let (key, raw) = trimmed.split_once('=')?;
    let key = key.trim();
    if key.is_empty() || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return None;
    }
    let raw = raw.trim();
    let value = if let Some(inner) = quoted(raw, '"').or_else(|| quoted(raw, '\'')) {
        inner.to_string()
    } else {
        // Hors guillemets, dotenv coupe au premier « # » précédé d'un blanc.
        match raw.find(" #") {
            Some(index) => raw[..index].trim_end().to_string(),
            None => raw.to_string(),
        }
    };
    Some((key.to_string(), value))
}

fn quoted(raw: &str, quote: char) -> Option<&str> {
    let inner = raw.strip_prefix(quote)?;
    let end = inner.rfind(quote)?;
    Some(&inner[..end])
}

/// Inscrit des valeurs dans le fichier sans toucher au reste.
///
/// Une clé déjà présente est remplacée sur place ; une clé absente est ajoutée
/// en fin plutôt que perdue en silence. Le fichier est écrit en UTF-8 sans BOM.
pub fn set_values(path: &Path, values: &[(&str, &str)]) -> io::Result<()> {
    let existing = match fs::read_to_string(path) {
        Ok(text) => text.strip_prefix('\u{feff}').unwrap_or(&text).to_string(),
        Err(err) if err.kind() == io::ErrorKind::NotFound => String::new(),
        Err(err) => return Err(err),
    };

    let mut remaining: Vec<(&str, &str)> = values.to_vec();
    let mut lines: Vec<String> = Vec::new();
    for line in existing.lines() {
        let replaced = parse_line(line).and_then(|(key, _)| {
            let position = remaining.iter().position(|(k, _)| *k == key)?;
            let (k, v) = remaining.remove(position);
            Some(format!("{k}={v}"))
        });
        lines.push(replaced.unwrap_or_else(|| line.to_string()));
    }
    for (key, value) in remaining {
        lines.push(format!("{key}={value}"));
    }

    let mut text = lines.join("\n");
    text.push('\n');
    fs::write(path, text)
}

/// Le jeton du bot est-il renseigné ?
///
/// Ne dit pas s'il est bon — seul Discord en décide —, seulement s'il vaut la
/// peine de démarrer. Un `.env` recopié tel quel depuis l'exemple garde la
/// valeur de démonstration : le bot mourrait aussitôt sur un refus
/// d'authentification, message autrement moins parlant que l'assistant.
pub fn has_token(values: &HashMap<String, String>) -> bool {
    match values.get("DISCORD_TOKEN") {
        Some(token) => {
            let token = token.trim();
            !token.is_empty() && token != PLACEHOLDER_TOKEN
        }
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_file(name: &str, content: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("imp-env-{}-{}", name, std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(".env");
        fs::write(&path, content).unwrap();
        path
    }

    #[test]
    fn reads_like_dotenv() {
        let path = temp_file(
            "read",
            "\u{feff}# commentaire\nDISCORD_TOKEN=abc.def.ghi\nPORT = 3100 # le port\nPUBLIC_URL=\"https://x.y\"\nexport HOST='0.0.0.0'\nnot a line\n",
        );
        let values = read(&path);
        assert_eq!(values.get("DISCORD_TOKEN").unwrap(), "abc.def.ghi");
        assert_eq!(values.get("PORT").unwrap(), "3100");
        assert_eq!(values.get("PUBLIC_URL").unwrap(), "https://x.y");
        assert_eq!(values.get("HOST").unwrap(), "0.0.0.0");
        assert_eq!(values.len(), 4);
    }

    #[test]
    fn writes_in_place_and_appends() {
        let path = temp_file("write", "# Le jeton\nDISCORD_TOKEN=your_bot_token_here\n# Le port\nPORT=3000\n");
        set_values(&path, &[("DISCORD_TOKEN", "a.b.c"), ("DISCORD_CLIENT_ID", "42")]).unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert_eq!(text, "# Le jeton\nDISCORD_TOKEN=a.b.c\n# Le port\nPORT=3000\nDISCORD_CLIENT_ID=42\n");
    }

    #[test]
    fn placeholder_is_not_a_token() {
        let mut values = HashMap::new();
        assert!(!has_token(&values));
        values.insert("DISCORD_TOKEN".into(), PLACEHOLDER_TOKEN.into());
        assert!(!has_token(&values));
        values.insert("DISCORD_TOKEN".into(), "x.y.z".into());
        assert!(has_token(&values));
    }
}
