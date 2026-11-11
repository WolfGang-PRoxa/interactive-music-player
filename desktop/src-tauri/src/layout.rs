//! Où vit le bot que l'application lance, et avec quel Node.
//!
//! Le bot suppose d'être lancé depuis la racine de son dépôt : `.env`, `data/`
//! et `node_modules/` s'y résolvent par `process.cwd()`, et les versions
//! installées depuis le tableau de bord vont dans `versions/`, d'où elles
//! héritent de `node_modules/` en remontant les dossiers (voir
//! `src/versioning/locations.js`). L'application respecte cette forme plutôt
//! que de la contourner : le bot qu'elle lance est toujours un dossier qui
//! ressemble trait pour trait au dépôt.
//!
//! Trois provenances, dans l'ordre de priorité :
//!
//!   1. **un dossier choisi** — `IMP_BOT_ROOT`, ou le dossier retenu dans
//!      l'assistant (« Utiliser une installation existante ») : un clone du
//!      dépôt, avec ses propres `node_modules`. L'application n'y écrit que ce
//!      que le bot y écrirait lui-même ;
//!   2. **le dossier de l'application** — `%LOCALAPPDATA%\<identifiant>\bot`,
//!      rempli depuis la charge utile de l'installeur ;
//!   3. **le dépôt de développement** — en `tauri dev`, sans charge utile, le
//!      dépôt dont l'application est issue.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

use crate::payload::Payload;

/// Réglages de l'application elle-même, distincts du `.env` du bot.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// Dossier d'un bot existant, choisi dans l'assistant.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bot_root: Option<PathBuf>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Origin {
    /// Dossier désigné par `IMP_BOT_ROOT` ou choisi par l'utilisateur.
    Chosen,
    /// Dossier géré par l'application, rempli depuis l'installeur.
    Managed,
    /// Dépôt de développement, en `tauri dev`.
    Development,
}

#[derive(Debug, Clone)]
pub struct Layout {
    /// Racine du bot : répertoire de travail du processus Node.
    pub root: PathBuf,
    pub origin: Origin,
    /// Dossier propre à l'application : réglages, runtime, bot géré.
    pub app_data: PathBuf,
    /// Charge utile de l'installeur, si l'application en porte une.
    pub payload: Option<Payload>,
}

impl Layout {
    pub fn env_file(&self) -> PathBuf {
        self.root.join(".env")
    }

    pub fn logs_dir(&self) -> PathBuf {
        self.root.join("data").join("logs")
    }

    pub fn entry_point(&self) -> PathBuf {
        self.root.join("src").join("index.js")
    }

    /// Dossier du runtime Node embarqué, une fois extrait.
    pub fn runtime_dir(&self) -> PathBuf {
        self.app_data.join("runtime")
    }

    /// Le Node embarqué, s'il a été extrait.
    pub fn bundled_node(&self) -> Option<PathBuf> {
        let node = self.runtime_dir().join(node_file_name());
        node.is_file().then_some(node)
    }

    /// Le Node à utiliser pour ce bot.
    ///
    /// Un dossier choisi a installé ses `node_modules` avec le Node de la
    /// machine : c'est donc lui qu'il faut, quand il existe — un module natif
    /// compilé pour une autre version refuserait de se charger. Le dossier géré
    /// a été préparé avec le Node embarqué, qui passe donc en premier.
    pub fn node(&self) -> PathBuf {
        let system = find_in_path(node_file_name());
        let bundled = self.bundled_node();
        let preferred = match self.origin {
            Origin::Managed => bundled.or(system),
            Origin::Chosen | Origin::Development => system.or(bundled),
        };
        preferred.unwrap_or_else(|| PathBuf::from(node_file_name()))
    }

    /// `npm` pour ce bot : celui qui accompagne le Node retenu.
    pub fn npm(&self) -> PathBuf {
        let node = self.node();
        let name = if cfg!(windows) { "npm.cmd" } else { "npm" };
        match node.parent() {
            Some(dir) if dir.join(name).is_file() => dir.join(name),
            _ => find_in_path(name).unwrap_or_else(|| PathBuf::from(name)),
        }
    }

    /// `PATH` à transmettre au bot.
    ///
    /// Le dossier du Node retenu passe devant : le bot relance des processus
    /// par `process.argv[0]`, mais son installateur de versions appelle `npm`
    /// par son nom, qui doit désigner celui qui accompagne ce Node.
    pub fn child_path(&self) -> std::ffi::OsString {
        let mut dirs: Vec<PathBuf> = Vec::new();
        if let Some(dir) = self.node().parent() {
            if !dir.as_os_str().is_empty() {
                dirs.push(dir.to_path_buf());
            }
        }
        if let Some(path) = std::env::var_os("PATH") {
            dirs.extend(std::env::split_paths(&path));
        }
        std::env::join_paths(dirs).unwrap_or_default()
    }

    pub fn has_dependencies(&self) -> bool {
        self.root.join("node_modules").is_dir()
    }
}

pub fn node_file_name() -> &'static str {
    if cfg!(windows) {
        "node.exe"
    } else {
        "node"
    }
}

fn find_in_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).map(|dir| dir.join(name)).find(|candidate| candidate.is_file())
}

/// Ce dossier est-il un bot lançable ?
///
/// `src/index.js` et un `package.json` au nom du projet : assez pour écarter un
/// dossier choisi par erreur, sans exiger `node_modules`, que l'application
/// sait installer.
pub fn is_bot_root(dir: &Path) -> bool {
    if !dir.join("src").join("index.js").is_file() {
        return false;
    }
    let Ok(text) = fs::read_to_string(dir.join("package.json")) else {
        return false;
    };
    serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|pkg| pkg.get("name").and_then(|n| n.as_str()).map(|n| n == "interactive-music-player"))
        .unwrap_or(false)
}

pub fn app_data_dir(app: &AppHandle) -> PathBuf {
    app.path().app_local_data_dir().unwrap_or_else(|_| std::env::temp_dir().join("interactive-music-player"))
}

fn settings_file(app_data: &Path) -> PathBuf {
    app_data.join("settings.json")
}

pub fn read_settings(app: &AppHandle) -> Settings {
    let path = settings_file(&app_data_dir(app));
    fs::read_to_string(path).ok().and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_default()
}

pub fn write_settings(app: &AppHandle, settings: &Settings) -> std::io::Result<()> {
    let dir = app_data_dir(app);
    fs::create_dir_all(&dir)?;
    let text = serde_json::to_string_pretty(settings).map_err(std::io::Error::other)?;
    fs::write(settings_file(&dir), text)
}

/// Dépôt dont l'application est issue, quand il est encore là.
fn development_root() -> Option<PathBuf> {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let root = manifest.parent()?.parent()?.to_path_buf();
    is_bot_root(&root).then_some(root)
}

/// Décide quel bot lancer.
pub fn resolve(app: &AppHandle) -> Result<Layout, String> {
    let app_data = app_data_dir(app);
    let payload = crate::payload::locate(app);

    if let Some(root) = std::env::var_os("IMP_BOT_ROOT").map(PathBuf::from) {
        if !is_bot_root(&root) {
            return Err(format!("IMP_BOT_ROOT désigne {} , qui ne contient pas le bot.", root.display()));
        }
        return Ok(Layout { root, origin: Origin::Chosen, app_data, payload });
    }

    if let Some(root) = read_settings(app).bot_root {
        if is_bot_root(&root) {
            return Ok(Layout { root, origin: Origin::Chosen, app_data, payload });
        }
        // Le dossier a disparu ou a été déplacé : on retombe sur le dossier de
        // l'application plutôt que de bloquer le démarrage sur un chemin mort.
    }

    if payload.is_some() {
        let root = app_data.join("bot");
        return Ok(Layout { root, origin: Origin::Managed, app_data, payload });
    }

    if let Some(root) = development_root() {
        return Ok(Layout { root, origin: Origin::Development, app_data, payload });
    }

    Err("Aucun bot à lancer : l'installation semble incomplète. Réinstallez l'application.".into())
}
