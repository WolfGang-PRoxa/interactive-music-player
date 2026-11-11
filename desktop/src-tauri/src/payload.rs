//! La charge utile de l'installeur : le runtime Node et le bot, prêts à servir.
//!
//! L'installeur porte une seule archive, `payload/bot.tar.gz`, plutôt que des
//! dizaines de milliers de fichiers de `node_modules` en ressources : il
//! s'installe en quelques secondes, et l'archive se déploie au premier
//! lancement — puis à chaque mise à jour de l'application, et seulement alors.
//!
//! Elle contient deux dossiers :
//!
//!   - `runtime/` — Node pour Windows, tel que publié sur nodejs.org ;
//!   - `bot/` — le code du bot et ses dépendances, installées pour ce Node.
//!
//! Le déploiement remplace le code et laisse les données : `.env`, `data/` et
//! `versions/` ne sont jamais dans l'archive, et rien ici ne les touche.

use serde::{Deserialize, Serialize};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

use crate::layout::Layout;

/// Ce que le déploiement ne touche jamais dans le dossier du bot.
const PRESERVED: &[&str] = &[".env", "data", "versions"];

/// Identité d'une charge utile, écrite par `desktop/scripts/build-payload.js`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    /// Identifiant unique de la construction : version et commit.
    pub id: String,
    pub version: String,
    pub node: String,
    /// Entrées de premier niveau de `bot/`, pour savoir quoi retirer à la
    /// mise à jour suivante.
    pub entries: Vec<String>,
    /// Nombre d'entrées de l'archive, pour la progression.
    pub files: u64,
}

#[derive(Debug, Clone)]
pub struct Payload {
    pub archive: PathBuf,
    pub manifest: Manifest,
}

/// Cherche la charge utile parmi les ressources de l'application.
pub fn locate(app: &AppHandle) -> Option<Payload> {
    let dir = app.path().resource_dir().ok()?.join("payload");
    let archive = dir.join("bot.tar.gz");
    if !archive.is_file() {
        return None;
    }
    let manifest =
        fs::read_to_string(dir.join("manifest.json")).ok().and_then(|text| serde_json::from_str(&text).ok())?;
    Some(Payload { archive, manifest })
}

fn stamp_file(app_data: &Path) -> PathBuf {
    app_data.join("payload.json")
}

fn installed_manifest(app_data: &Path) -> Option<Manifest> {
    fs::read_to_string(stamp_file(app_data)).ok().and_then(|text| serde_json::from_str(&text).ok())
}

/// La charge utile doit-elle être déployée ?
///
/// Oui quand l'application en porte une et que le dossier de l'application n'en
/// a pas reçu cette construction-là — ou qu'il manque le runtime, effacé à la
/// main ou par un antivirus.
pub fn needs_install(layout: &Layout) -> bool {
    let Some(payload) = &layout.payload else {
        return false;
    };
    let current = installed_manifest(&layout.app_data);
    current.as_ref().map(|m| &m.id) != Some(&payload.manifest.id) || layout.bundled_node().is_none()
}

/// Déploie la charge utile ; `progress` reçoit la part accomplie, de 0 à 1.
pub fn install(layout: &Layout, progress: &dyn Fn(f64)) -> io::Result<()> {
    let Some(payload) = &layout.payload else {
        return Ok(());
    };
    let app_data = &layout.app_data;
    fs::create_dir_all(app_data)?;

    // 1. Extraction complète à l'écart : une archive corrompue ou un disque
    //    plein ne laisse jamais un bot à moitié remplacé.
    let staging = app_data.join(".staging");
    remove_if_exists(&staging)?;
    fs::create_dir_all(&staging)?;
    unpack(&payload.archive, &staging, payload.manifest.files, progress)?;

    let new_runtime = staging.join("runtime");
    let new_bot = staging.join("bot");
    if !new_runtime.join(crate::layout::node_file_name()).is_file() || !new_bot.join("src").is_dir() {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "l'archive de l'installeur est incomplète"));
    }

    // 2. Le runtime est remplacé en bloc.
    let runtime = layout.runtime_dir();
    remove_if_exists(&runtime)?;
    fs::rename(&new_runtime, &runtime)?;

    // 3. Le code du bot est remplacé entrée par entrée, autour des données.
    let bot = app_data.join("bot");
    fs::create_dir_all(&bot)?;
    if let Some(previous) = installed_manifest(app_data) {
        for entry in previous.entries.iter().filter(|e| is_replaceable(e)) {
            remove_if_exists(&bot.join(entry))?;
        }
    }
    for entry in fs::read_dir(&new_bot)? {
        let entry = entry?;
        let name = entry.file_name();
        if !is_replaceable(&name.to_string_lossy()) {
            continue;
        }
        let target = bot.join(&name);
        remove_if_exists(&target)?;
        fs::rename(entry.path(), &target)?;
    }

    // 4. Le tampon en dernier : un déploiement interrompu sera rejoué.
    let stamp = serde_json::to_string_pretty(&payload.manifest).map_err(io::Error::other)?;
    fs::write(stamp_file(app_data), stamp)?;
    remove_if_exists(&staging)?;
    progress(1.0);
    Ok(())
}

fn is_replaceable(name: &str) -> bool {
    !name.is_empty() && !name.contains(['/', '\\']) && name != "." && name != ".." && !PRESERVED.contains(&name)
}

fn unpack(archive: &Path, into: &Path, expected: u64, progress: &dyn Fn(f64)) -> io::Result<()> {
    let file = fs::File::open(archive)?;
    let decoder = flate2::read::GzDecoder::new(io::BufReader::with_capacity(1 << 20, file));
    let mut tar = tar::Archive::new(decoder);
    let total = expected.max(1) as f64;
    let mut done: u64 = 0;
    for entry in tar.entries()? {
        let mut entry = entry?;
        // `unpack_in` refuse tout chemin qui sortirait du dossier visé.
        entry.unpack_in(into)?;
        done += 1;
        if done.is_multiple_of(500) {
            progress((done as f64 / total).min(0.99));
        }
    }
    Ok(())
}

fn remove_if_exists(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => fs::remove_dir_all(path),
        Ok(_) => fs::remove_file(path),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn data_is_never_replaceable() {
        for name in PRESERVED {
            assert!(!is_replaceable(name));
        }
        assert!(!is_replaceable(".."));
        assert!(!is_replaceable("a/b"));
        assert!(is_replaceable("src"));
        assert!(is_replaceable("node_modules"));
        assert!(is_replaceable(".env.example"));
    }
}
