//! Quelle version du bot lancer quand plusieurs sont installées.
//!
//! Le dossier du bot porte deux sortes de code (voir `src/versioning/` côté
//! bot) :
//!
//!   - le **code de base**, à la racine : celui que l'installeur de
//!     l'application a déployé, ou le clone choisi dans l'assistant. Le tableau
//!     de bord l'appelle « dev » ;
//!   - les **versions installées** depuis le tableau de bord, chacune dans
//!     `versions/<tag>/`, attestée par son marqueur `.imp-version.json`.
//!
//! Basculer de version depuis le tableau de bord ne vaut que pour le processus
//! en cours : le bot dépose le point d'entrée voulu, l'application relance
//! dessus (voir `supervisor.rs`). Rien ne s'en souvenait au lancement suivant,
//! qui repartait donc toujours sur le code de base — une 0.0.1 déployée par
//! l'installeur, alors que la 0.0.2 était installée à côté.
//!
//! Au lancement, l'application démarre désormais la plus récente de toutes,
//! comparées selon le semver. À égalité, le code de base l'emporte : c'est lui
//! que l'installeur vient de poser.

use serde::Deserialize;
use std::fs;
use std::path::{Path, PathBuf};

use crate::layout::{self, Layout, Origin};

/// Marqueur d'intégrité d'une version installée (`src/versioning/locations.js`).
const MARKER_FILE: &str = ".imp-version.json";

#[derive(Debug, Deserialize)]
struct Marker {
    #[serde(default)]
    tag: Option<String>,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    complete: bool,
}

/// Une version lançable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    /// Racine d'installation : le dossier qui porte `src/index.js`.
    pub root: PathBuf,
    pub version: semver::Version,
    /// Tag de la release, ou `None` pour le code de base.
    pub tag: Option<String>,
}

impl Candidate {
    pub fn entry_point(&self) -> PathBuf {
        self.root.join("src").join("index.js")
    }
}

/// Lit une version semver, `v` initial toléré.
pub fn parse(text: &str) -> Option<semver::Version> {
    let text = text.trim();
    let text = text.strip_prefix(['v', 'V']).unwrap_or(text);
    semver::Version::parse(text).ok()
}

fn package_version(root: &Path) -> Option<semver::Version> {
    let text = fs::read_to_string(root.join("package.json")).ok()?;
    let pkg: serde_json::Value = serde_json::from_str(&text).ok()?;
    parse(pkg.get("version")?.as_str()?)
}

/// Dossier des versions installées, comme le bot le calcule.
///
/// `IMP_VERSIONS_DIR` le déporte, depuis l'environnement ou le `.env` ; un
/// chemin relatif part de la racine du bot, qui est son répertoire de travail.
pub fn versions_dir(layout: &Layout) -> PathBuf {
    let configured = std::env::var("IMP_VERSIONS_DIR")
        .ok()
        .or_else(|| crate::env_file::read(&layout.env_file()).get("IMP_VERSIONS_DIR").cloned())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());
    match configured {
        Some(dir) => layout.root.join(dir),
        None => layout.root.join("versions"),
    }
}

/// Les versions complètes de `versions/`, dans le désordre.
///
/// Une extraction interrompue n'a pas de marqueur complet : elle est écartée,
/// comme le fait le bot lui-même.
pub fn installed(dir: &Path) -> Vec<Candidate> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .filter_map(|root| {
            let text = fs::read_to_string(root.join(MARKER_FILE)).ok()?;
            let marker: Marker = serde_json::from_str(&text).ok()?;
            if !marker.complete || !layout::is_bot_root(&root) {
                return None;
            }
            let tag =
                marker.tag.clone().unwrap_or_else(|| root.file_name().unwrap_or_default().to_string_lossy().into());
            let version =
                marker.version.as_deref().and_then(parse).or_else(|| parse(&tag)).or_else(|| package_version(&root))?;
            Some(Candidate { root, version, tag: Some(tag) })
        })
        .collect()
}

/// La plus récente des candidates ; à égalité, la première de la liste.
pub fn newest(candidates: Vec<Candidate>) -> Option<Candidate> {
    candidates.into_iter().reduce(|best, next| if next.version > best.version { next } else { best })
}

/// La version à lancer pour ce bot.
///
/// En `tauri dev`, c'est toujours le dépôt de travail : on y lance le code
/// qu'on est en train d'écrire, pas une release téléchargée à côté.
pub fn to_launch(layout: &Layout) -> Option<Candidate> {
    let base = package_version(&layout.root).map(|version| Candidate { root: layout.root.clone(), version, tag: None });
    if layout.origin == Origin::Development {
        return base;
    }
    let mut candidates: Vec<Candidate> = base.into_iter().collect();
    candidates.extend(installed(&versions_dir(layout)));
    newest(candidates)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate(version: &str, tag: Option<&str>) -> Candidate {
        Candidate {
            root: PathBuf::from(tag.unwrap_or("base")),
            version: parse(version).unwrap(),
            tag: tag.map(String::from),
        }
    }

    #[test]
    fn tags_parse_with_or_without_v() {
        assert_eq!(parse("v0.0.2"), parse("0.0.2"));
        assert!(parse("v1.2.3-beta.1").is_some());
        assert!(parse("dev").is_none());
    }

    #[test]
    fn newest_wins_and_base_keeps_ties() {
        let base = candidate("0.0.1", None);
        let pick = newest(vec![base.clone(), candidate("0.0.2", Some("v0.0.2"))]).unwrap();
        assert_eq!(pick.tag.as_deref(), Some("v0.0.2"));

        let pick = newest(vec![candidate("0.0.3", None), candidate("0.0.2", Some("v0.0.2"))]).unwrap();
        assert_eq!(pick.tag, None);

        let pick = newest(vec![candidate("0.0.2", None), candidate("0.0.2", Some("v0.0.2"))]).unwrap();
        assert_eq!(pick.tag, None);

        // Une préversion passe derrière la version finale du même numéro.
        let pick = newest(vec![candidate("1.0.0", None), candidate("1.0.0-rc.1", Some("v1.0.0-rc.1"))]).unwrap();
        assert_eq!(pick.tag, None);
    }

    #[test]
    fn only_complete_installs_count() {
        let dir = std::env::temp_dir().join(format!("imp-versions-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let make = |name: &str, version: &str, complete: bool| {
            let root = dir.join(name);
            fs::create_dir_all(root.join("src")).unwrap();
            fs::write(root.join("src").join("index.js"), "").unwrap();
            fs::write(
                root.join("package.json"),
                format!(r#"{{"name":"interactive-music-player","version":"{version}"}}"#),
            )
            .unwrap();
            fs::write(
                root.join(MARKER_FILE),
                format!(r#"{{"tag":"{name}","version":"{version}","complete":{complete}}}"#),
            )
            .unwrap();
        };
        make("v0.0.2", "0.0.2", true);
        make("v0.0.9", "0.0.9", false);
        let found = installed(&dir);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].tag.as_deref(), Some("v0.0.2"));
        assert_eq!(found[0].version, parse("0.0.2").unwrap());
        let _ = fs::remove_dir_all(&dir);
    }
}
