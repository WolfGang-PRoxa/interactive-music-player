//! Le cycle de vie du bot : préparation, lancement, surveillance, arrêt.
//!
//! Reprend le déroulé de `tools/start-bot.ps1` — mêmes étapes, mêmes messages,
//! mêmes réparations proposées — à une différence près, qui change tout :
//! l'application **garde** le processus du bot. Elle le voit mourir, sait
//! pourquoi, et le relance quand il le demande, là où le lanceur PowerShell le
//! lâchait dans la nature une fois le tableau de bord ouvert.
//!
//! ## Le redémarrage
//!
//! Hors application, le bot se redémarre seul : il lance une nouvelle instance
//! détachée, puis sort. Sous l'application, une instance détachée échapperait à
//! la surveillance ; le bot sait donc qu'il est supervisé (`IMP_SUPERVISOR`), et
//! se contente de déposer le point d'entrée voulu dans
//! `data/desktop-restart.json` avant de sortir avec le code 75. C'est
//! l'application qui relance — la même instance pour un redémarrage, une autre
//! version pour une bascule depuis le tableau de bord. Voir
//! src/utils/supervisor.js.
//!
//! ## Pas de fenêtre de lancement
//!
//! L'application s'ouvre aussitôt sur sa fenêtre principale, celle du tableau
//! de bord. Tant que le serveur du bot n'écoute pas encore, elle affiche une
//! page d'attente embarquée (`ui/starting.html`) ; dès qu'il répond, elle
//! charge le tableau de bord. Le bot ouvre son serveur avant de se connecter à
//! Discord : la page s'affiche donc en une ou deux secondes, et c'est elle qui
//! dit à l'utilisateur ce qui attend la fin du démarrage (voir
//! `WebServer.listen` côté bot).
//!
//! La fenêtre d'état (`launcher`) ne sert plus qu'aux moments où il n'y a pas
//! de tableau de bord à montrer : première configuration, panne, extinction.
//!
//! ## Quelle version
//!
//! Au lancement, c'est la version installée la plus récente qui démarre (voir
//! `versions.rs`).

use std::fs::{self, File};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

use crate::dashboard::Endpoint;
use crate::discord;
use crate::env_file;
use crate::layout::{self, Layout, Origin};
use crate::payload;
use crate::versions;
use crate::view::{Action, Card, Footer, Screen, Snapshot, StepState, Tone};

/// Code de sortie par lequel le bot demande à être relancé.
pub const RESTART_EXIT_CODE: i32 = 75;

/// Fichier où le bot dépose le point d'entrée de sa prochaine instance.
const RESTART_REQUEST: &str = "desktop-restart.json";

pub const LAUNCHER: &str = "launcher";
pub const DASHBOARD: &str = "dashboard";

/// Page embarquée que montre la fenêtre principale tant que le serveur du bot
/// ne répond pas.
const STARTING_PAGE: &str = "starting.html";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    /// Rien ne tourne.
    Idle,
    /// L'assistant de première configuration est ouvert.
    Setup,
    /// La séquence de lancement est en cours.
    Launching,
    /// Le bot tourne, sous la garde de l'application.
    Running,
    /// Le bot a demandé à être relancé ; la nouvelle instance démarre.
    Restarting,
    /// Une extinction est demandée ; on attend la fin du fondu.
    Stopping,
    /// Un bot tournait déjà, lancé hors de l'application.
    Attached,
}

impl Phase {
    /// Un bot répond-il, ou va-t-il répondre ?
    pub fn bot_alive(self) -> bool {
        matches!(self, Phase::Running | Phase::Restarting | Phase::Stopping | Phase::Attached)
    }
}

struct Inner {
    phase: Phase,
    snapshot: Snapshot,
    layout: Option<Layout>,
    child: Option<Child>,
    /// Point d'entrée du processus en cours : un redémarrage forcé, sans
    /// demande du bot, repart sur la même version.
    entry: Option<PathBuf>,
    /// Incrémenté à chaque processus lancé : la surveillance d'un processus
    /// remplacé se tait au lieu de rapporter une mort qui n'en est plus une.
    generation: u64,
    last_exit: Option<i32>,
    quitting: bool,
    /// Lancé avec la session Windows : rien ne s'affiche tant que tout va bien.
    background: bool,
    /// Les commandes slash doivent être enregistrées au prochain lancement.
    deploy_pending: bool,
    client_id: String,
}

pub struct Supervisor {
    app: AppHandle,
    inner: Mutex<Inner>,
}

pub fn get(app: &AppHandle) -> Arc<Supervisor> {
    app.state::<Arc<Supervisor>>().inner().clone()
}

impl Supervisor {
    pub fn new(app: AppHandle, background: bool) -> Arc<Self> {
        Arc::new(Supervisor {
            app,
            inner: Mutex::new(Inner {
                phase: Phase::Idle,
                snapshot: Snapshot::default(),
                layout: None,
                child: None,
                entry: None,
                generation: 0,
                last_exit: None,
                quitting: false,
                background,
                deploy_pending: false,
                client_id: String::new(),
            }),
        })
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn snapshot(&self) -> Snapshot {
        self.lock().snapshot.clone()
    }

    pub fn phase(&self) -> Phase {
        self.lock().phase
    }

    pub fn layout(&self) -> Option<Layout> {
        self.lock().layout.clone()
    }

    /// Modifie l'état, puis prévient la fenêtre et la zone de notification.
    fn update(&self, change: impl FnOnce(&mut Inner)) {
        let (snapshot, phase) = {
            let mut inner = self.lock();
            change(&mut inner);
            inner.snapshot.idle = matches!(inner.phase, Phase::Idle | Phase::Setup);
            (inner.snapshot.clone(), inner.phase)
        };
        let _ = self.app.emit_to(LAUNCHER, "launcher://state", &snapshot);
        self.paint_starting(&snapshot);
        crate::tray::refresh(&self.app, phase);
    }

    /// Recopie l'étape en cours sur la page d'attente, si elle est affichée.
    ///
    /// Par `eval` plutôt que par l'IPC : la fenêtre principale n'y a pas accès,
    /// puisqu'elle finit sur une page servie par le bot. Le script ne touche
    /// qu'à une fonction que seule la page d'attente définit.
    fn paint_starting(&self, snapshot: &Snapshot) {
        let Some(window) = self.app.get_webview_window(DASHBOARD) else { return };
        if !on_app_page(&window) {
            return;
        }
        let caption = snapshot
            .steps
            .iter()
            .find(|step| step.state == StepState::Running)
            .map(|step| step.caption.clone())
            .unwrap_or_else(|| snapshot.headline.clone());
        let state = serde_json::json!({ "caption": caption, "progress": snapshot.progress });
        let _ = window.eval(format!("window.impStarting && window.impStarting({state});"));
    }

    fn set_step(&self, index: usize, state: StepState) {
        self.update(|inner| {
            if let Some(step) = inner.snapshot.steps.get_mut(index) {
                step.state = state;
            }
            if state != StepState::Running {
                inner.snapshot.progress = None;
            }
        });
    }

    fn fail(&self, message: &str, details: Option<String>, actions: Vec<Action>) {
        self.show_failure(message, details, None, actions);
    }

    /// Comme `fail`, le détail étant la fin d'un journal : il s'affiche tel
    /// quel, en chasse fixe.
    fn fail_log(&self, message: &str, log: Option<String>, actions: Vec<Action>) {
        self.show_failure(message, None, log, actions);
    }

    fn show_failure(&self, message: &str, details: Option<String>, log: Option<String>, actions: Vec<Action>) {
        // La page d'attente n'a plus rien à attendre : la panne se dit dans la
        // fenêtre d'état. Un tableau de bord chargé, lui, reste ouvert.
        if let Some(window) = self.app.get_webview_window(DASHBOARD) {
            if on_app_page(&window) {
                let _ = window.destroy();
            }
        }
        self.update(|inner| {
            inner.phase = if inner.child.is_some() { Phase::Running } else { Phase::Idle };
            inner.snapshot.screen = Screen::Steps;
            inner.snapshot.headline = message.into();
            inner.snapshot.footer = Some(Footer { message: message.into(), details, log, tone: Tone::Error, actions });
        });
        self.show_launcher();
    }

    // ------------------------------------------------------------------
    //  Fenêtres
    // ------------------------------------------------------------------

    pub fn show_launcher(&self) {
        if let Some(window) = self.app.get_webview_window(LAUNCHER) {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
    }

    fn hide_launcher(&self) {
        if let Some(window) = self.app.get_webview_window(LAUNCHER) {
            let _ = window.hide();
        }
    }

    /// Ce qu'un clic sur l'icône, ou une seconde ouverture de l'application,
    /// doit montrer : la fenêtre principale tant que le bot tourne ou démarre,
    /// la fenêtre d'état sinon.
    pub fn show_main(self: &Arc<Self>) {
        let phase = self.phase();
        if matches!(phase, Phase::Running | Phase::Attached | Phase::Launching | Phase::Restarting) {
            // Hors du fil des événements : construire une fenêtre depuis un
            // gestionnaire d'événement peut bloquer sous Windows.
            let this = self.clone();
            thread::spawn(move || this.open_dashboard());
            return;
        }
        self.show_launcher();
    }

    /// La fenêtre principale, créée au besoin sur la page d'attente.
    fn main_window(&self) -> tauri::Result<WebviewWindow> {
        if let Some(window) = self.app.get_webview_window(DASHBOARD) {
            return Ok(window);
        }
        let relay_app = self.app.clone();
        let tab_app = self.app.clone();
        WebviewWindowBuilder::new(&self.app, DASHBOARD, WebviewUrl::App(STARTING_PAGE.into()))
            .title("Interactive Music Player")
            // Les liens qui s'ouvrent ailleurs — GitHub, le don, la
            // documentation, le portail Discord, le partage — visent un onglet
            // (`target="_blank"`, `window.open`). Une fenêtre d'application n'a
            // pas d'onglets : ils partent dans le navigateur de l'utilisateur.
            //
            // La demande d'onglet seule (`on_new_window`) n'y suffisait pas :
            // sous Windows, le clic ne menait toujours nulle part. Le script
            // injecté fait passer ces liens par une navigation vers l'adresse
            // relais, que `on_navigation` intercepte avant qu'elle ne commence.
            // La demande d'onglet reste le filet de ce qui lui échapperait.
            .initialization_script(EXTERNAL_LINKS_SCRIPT)
            .on_navigation(move |url| match route_navigation(url) {
                Navigation::Proceed => true,
                Navigation::Drop => false,
                Navigation::Open(target) => {
                    open_external(&relay_app, target);
                    false
                }
            })
            .on_new_window(move |url, _features| {
                if is_external_link(&url) {
                    open_external(&tab_app, url);
                }
                tauri::webview::NewWindowResponse::Deny
            })
            .inner_size(1360.0, 860.0)
            .min_inner_size(420.0, 560.0)
            .center()
            .build()
    }

    /// Montre la fenêtre principale, et y charge le tableau de bord dès que le
    /// serveur du bot répond.
    ///
    /// La page vient du serveur du bot, comme dans un navigateur : elle n'a
    /// aucun accès à l'IPC de l'application (voir capabilities/launcher.json).
    pub fn open_dashboard(&self) {
        let window = match self.main_window() {
            Ok(window) => window,
            Err(err) => {
                return self.fail(
                    "Le tableau de bord n'a pas pu s'ouvrir dans l'application.",
                    Some(err.to_string()),
                    vec![Action::primary("open-browser", "Ouvrir dans le navigateur")],
                );
            }
        };
        if on_app_page(&window) {
            if let Some(layout) = self.layout() {
                let endpoint = Endpoint::of(&layout);
                if endpoint.answers() {
                    if let Ok(url) = tauri::Url::parse(&endpoint.url()) {
                        let _ = window.navigate(url);
                    }
                }
            }
        }
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        self.hide_launcher();
    }

    pub fn open_in_browser(&self) {
        let Some(layout) = self.layout() else { return };
        let url = Endpoint::of(&layout).url();
        let _ = self.app.opener().open_url(url, None::<&str>);
    }

    fn close_dashboard(&self) {
        if let Some(window) = self.app.get_webview_window(DASHBOARD) {
            let _ = window.destroy();
        }
    }

    pub fn open_logs(&self) {
        if let Some(layout) = self.layout() {
            let dir = layout.logs_dir();
            let _ = fs::create_dir_all(&dir);
            let _ = self.app.opener().open_path(dir.to_string_lossy(), None::<&str>);
        }
    }

    // ------------------------------------------------------------------
    //  Lancement
    // ------------------------------------------------------------------

    /// Lance la séquence de démarrage, sauf si un bot tourne ou démarre déjà.
    pub fn start(self: &Arc<Self>) {
        {
            let mut inner = self.lock();
            if matches!(inner.phase, Phase::Launching | Phase::Running | Phase::Restarting | Phase::Stopping) {
                return;
            }
            inner.phase = Phase::Launching;
        }
        // L'application s'ouvre sans attendre le bot : la fenêtre principale
        // paraît aussitôt, sur la page d'attente. Sauf au démarrage avec
        // Windows, où rien ne s'affiche tant que tout va bien.
        if !self.lock().background {
            self.open_dashboard();
        }
        let this = self.clone();
        thread::spawn(move || this.launch());
    }

    fn launch(self: &Arc<Self>) {
        self.update(|inner| inner.snapshot.sequence("Démarrage en cours…", &[]));

        let layout = match layout::resolve(&self.app) {
            Ok(layout) => layout,
            Err(err) => {
                return self.fail(
                    "L'application ne trouve pas le bot.",
                    Some(err),
                    vec![Action::secondary("quit", "Quitter")],
                );
            }
        };
        self.update(|inner| {
            inner.snapshot.root = layout.root.display().to_string();
            inner.snapshot.chosen_root = layout.origin == Origin::Chosen;
            inner.layout = Some(layout.clone());
        });

        // Un bot répond déjà sur ce port : lancé par le raccourci, ou laissé
        // par une session précédente. On s'y rattache plutôt que d'en lancer un
        // second, qui mourrait sur un port occupé — et surtout sans toucher à
        // ses fichiers.
        if Endpoint::of(&layout).answers() {
            return self.attach();
        }

        let install = payload::needs_install(&layout);
        let install_deps = layout.origin != Origin::Managed && !layout.has_dependencies();
        let deploy = {
            let mut inner = self.lock();
            let pending = std::mem::take(&mut inner.deploy_pending);
            pending || install || install_deps
        };

        let mut captions: Vec<&str> = Vec::new();
        if install {
            captions.push("Préparation des fichiers du bot");
        }
        captions.push("Vérification de la configuration");
        if install_deps {
            captions.push("Installation des dépendances");
        }
        captions.push("Démarrage du serveur");
        self.update(|inner| inner.snapshot.sequence("Démarrage en cours…", &captions));

        let mut index = 0;

        if install {
            self.set_step(index, StepState::Running);
            let this = self.clone();
            let progress = move |part: f64| this.update(|inner| inner.snapshot.progress = Some(part));
            if let Err(err) = payload::install(&layout, &progress) {
                self.set_step(index, StepState::Failed);
                return self.fail(
                    "La préparation des fichiers du bot a échoué.",
                    Some(format!(
                        "{err}\n\nUn antivirus peut bloquer l'extraction : réessayez, ou réinstallez l'application."
                    )),
                    vec![Action::primary("start", "Réessayer"), Action::secondary("quit", "Quitter")],
                );
            }
            self.set_step(index, StepState::Done);
            index += 1;
        }

        // Configuration. L'absence de jeton n'est pas une panne : au premier
        // lancement, c'est l'état normal. Elle ouvre donc l'assistant.
        self.set_step(index, StepState::Running);
        ensure_env_file(&layout);
        if !env_file::has_token(&env_file::read(&layout.env_file())) {
            return self.enter_setup();
        }
        self.set_step(index, StepState::Done);
        index += 1;

        if install_deps {
            self.set_step(index, StepState::Running);
            let log = layout.logs_dir().join("npm-install.log");
            let mut command = Command::new(layout.npm());
            command.args(["install", "--no-audit", "--no-fund"]);
            if !run_logged(&layout, &mut command, &log) {
                self.set_step(index, StepState::Failed);
                return self.fail_log(
                    "L'installation des dépendances a échoué.",
                    tail(&log, 12),
                    vec![Action::primary("start", "Réessayer"), Action::secondary("open-logs", "Ouvrir les journaux")],
                );
            }
            self.set_step(index, StepState::Done);
            index += 1;
        }

        // La version installée la plus récente : celle de l'installeur, ou une
        // version plus récente installée depuis le tableau de bord.
        let version = versions::to_launch(&layout);
        let code_root = version.as_ref().map(|v| v.root.clone()).unwrap_or_else(|| layout.root.clone());

        // L'enregistrement des commandes slash passe par l'API REST de
        // Discord, sans rien attendre du bot : il se fait à côté, sans
        // retarder l'ouverture. Son échec n'est pas bloquant — le bot démarre
        // très bien sans, et il se rattrapera au prochain lancement.
        if deploy {
            let this = self.clone();
            let layout = layout.clone();
            let script = code_root.join("src").join("deploy-commands.js");
            thread::spawn(move || {
                let log = layout.logs_dir().join("npm-deploy.log");
                let mut command = Command::new(layout.node());
                command.arg(script);
                if !run_logged(&layout, &mut command, &log) {
                    this.lock().deploy_pending = true;
                }
            });
        }

        self.set_step(index, StepState::Running);
        if let Err(err) = self.spawn_bot(&layout, version.as_ref().map(|v| v.entry_point()), false) {
            self.set_step(index, StepState::Failed);
            return self.fail(
                "Node.js n'a pas pu être lancé.",
                Some(format!("{} : {err}", layout.node().display())),
                vec![Action::primary("start", "Réessayer"), Action::secondary("quit", "Quitter")],
            );
        }
        self.await_dashboard(&layout, index);
    }

    /// Attend que le serveur du tableau de bord réponde, puis l'y charge.
    ///
    /// Le bot ouvre son serveur avant de se connecter à Discord : il répond
    /// d'ordinaire en une ou deux secondes, et le tableau de bord dit lui-même
    /// ce qui attend la fin du démarrage. Le délai de 90 s ne couvre que les
    /// machines très lentes ; au-delà, mieux vaut rendre la main.
    fn await_dashboard(self: &Arc<Self>, layout: &Layout, index: usize) {
        let started = Instant::now();
        loop {
            let exited = self.lock().last_exit;
            if let Some(code) = exited {
                self.set_step(index, StepState::Failed);
                if code == RESTART_EXIT_CODE {
                    return self.relaunch();
                }
                return self.report_exit(layout, code, true);
            }
            if Endpoint::of(layout).answers() {
                break;
            }
            if started.elapsed() > Duration::from_secs(90) {
                self.set_step(index, StepState::Failed);
                return self.fail_log(
                    "Le bot ne répond pas encore.",
                    tail(&layout.logs_dir().join("latest.log"), 12),
                    vec![
                        Action::primary("open-dashboard", "Ouvrir quand même"),
                        Action::secondary("open-logs", "Ouvrir les journaux"),
                        Action::secondary("restart", "Redémarrer"),
                    ],
                );
            }
            thread::sleep(Duration::from_millis(300));
        }

        self.set_step(index, StepState::Done);
        let (background, exited) = {
            let mut inner = self.lock();
            inner.phase = Phase::Running;
            let background = inner.background;
            // Le démarrage avec Windows ne vaut que pour le premier lancement :
            // un redémarrage demandé ensuite doit se voir.
            inner.background = false;
            (background, inner.last_exit)
        };
        // Mort entre la réponse du port et le passage en « en marche » : la
        // surveillance s'est tue, la phase étant encore au lancement.
        if let Some(code) = exited {
            return self.exited(code);
        }
        self.update(|inner| {
            inner.snapshot.headline = "Le serveur répond.".into();
            inner.snapshot.footer = None;
        });
        if !background {
            self.open_dashboard();
        }
    }

    fn spawn_bot(self: &Arc<Self>, layout: &Layout, entry: Option<PathBuf>, restart: bool) -> io::Result<()> {
        fs::create_dir_all(layout.logs_dir())?;
        // Ce que Node écrit avant que le journal du bot ne soit ouvert — un
        // module introuvable, une erreur de syntaxe — n'irait nulle part sans
        // console. On le garde ici.
        let mut output = File::create(layout.logs_dir().join("desktop-process.log"))?;
        let entry = entry.unwrap_or_else(|| layout.entry_point());
        // De quoi savoir, après coup, quelle version l'application a lancée.
        let _ = writeln!(output, "[Interactive Music Player] node {}", entry.display());
        let mut command = Command::new(layout.node());
        command
            .arg(&entry)
            .current_dir(&layout.root)
            .env("PATH", layout.child_path())
            // Le tableau de bord s'ouvre dans l'application, pas dans un onglet.
            .env("AUTO_OPEN_DASHBOARD", "false")
            .env("IMP_SUPERVISOR", "desktop")
            .stdin(Stdio::null())
            .stdout(output.try_clone()?)
            .stderr(output);
        if restart {
            command.env("IMP_RESTART", "1");
        } else {
            command.env_remove("IMP_RESTART");
        }
        hide_console(&mut command);
        let child = command.spawn()?;

        let generation = {
            let mut inner = self.lock();
            inner.generation += 1;
            inner.child = Some(child);
            inner.entry = Some(entry);
            inner.last_exit = None;
            inner.generation
        };
        let this = self.clone();
        thread::spawn(move || this.watch(generation));
        Ok(())
    }

    /// Surveille un processus jusqu'à sa fin.
    fn watch(self: Arc<Self>, generation: u64) {
        loop {
            thread::sleep(Duration::from_millis(250));
            let code = {
                let mut inner = self.lock();
                if inner.generation != generation {
                    return;
                }
                let Some(child) = inner.child.as_mut() else { return };
                match child.try_wait() {
                    Ok(Some(status)) => {
                        let code = status.code().unwrap_or(-1);
                        inner.child = None;
                        inner.last_exit = Some(code);
                        code
                    }
                    _ => continue,
                }
            };
            return self.exited(code);
        }
    }

    fn exited(self: &Arc<Self>, code: i32) {
        let (phase, quitting) = {
            let inner = self.lock();
            (inner.phase, inner.quitting)
        };
        if quitting {
            self.app.exit(0);
            return;
        }
        // Pendant le lancement, c'est la séquence elle-même qui rend compte.
        if matches!(phase, Phase::Launching | Phase::Restarting) {
            return;
        }
        let Some(layout) = self.layout() else { return };
        // Une extinction demandée finit par « éteint », quel que soit le code :
        // un processus tué faute d'avoir fini son fondu à temps reste un
        // processus qu'on a voulu arrêter.
        if phase == Phase::Stopping {
            self.close_dashboard();
            return self.report_exit(&layout, 0, false);
        }
        if code == RESTART_EXIT_CODE {
            return self.relaunch();
        }
        self.close_dashboard();
        self.report_exit(&layout, code, false);
    }

    /// Le bot a demandé à être relancé : même instance, ou autre version.
    fn relaunch(self: &Arc<Self>) {
        let Some(layout) = self.layout() else { return };
        // Sans demande du bot — un redémarrage forcé —, la même version.
        let entry = take_restart_request(&layout).or_else(|| self.lock().entry.clone());
        self.update(|inner| {
            inner.phase = Phase::Restarting;
            inner.snapshot.sequence("Redémarrage en cours…", &["Redémarrage du bot", "Ouverture du tableau de bord"]);
        });
        self.set_step(0, StepState::Running);
        if let Err(err) = self.spawn_bot(&layout, entry, true) {
            self.set_step(0, StepState::Failed);
            self.close_dashboard();
            return self.fail(
                "Le bot n'a pas pu être relancé.",
                Some(err.to_string()),
                vec![Action::primary("start", "Réessayer")],
            );
        }
        self.set_step(0, StepState::Done);
        self.set_step(1, StepState::Running);

        let started = Instant::now();
        loop {
            let exited = self.lock().last_exit;
            if let Some(code) = exited {
                self.set_step(1, StepState::Failed);
                self.close_dashboard();
                if code == RESTART_EXIT_CODE {
                    return self.relaunch();
                }
                return self.report_exit(&layout, code, true);
            }
            if Endpoint::of(&layout).answers() {
                break;
            }
            if started.elapsed() > Duration::from_secs(90) {
                self.set_step(1, StepState::Failed);
                return self.fail_log(
                    "Le bot ne répond pas encore.",
                    tail(&layout.logs_dir().join("latest.log"), 12),
                    vec![Action::secondary("open-logs", "Ouvrir les journaux")],
                );
            }
            thread::sleep(Duration::from_millis(300));
        }
        self.set_step(1, StepState::Done);
        self.update(|inner| {
            inner.phase = Phase::Running;
            inner.snapshot.headline = "Le bot a redémarré.".into();
        });
        // Une page de tableau de bord ouverte se reconnecte d'elle-même. Il
        // ne reste qu'à charger celle qui attendait, ou à rouvrir la fenêtre
        // quand le redémarrage a été demandé depuis la fenêtre d'état.
        let waiting = self.app.get_webview_window(DASHBOARD).map(|w| on_app_page(&w)).unwrap_or(false);
        let from_launcher =
            self.app.get_webview_window(LAUNCHER).map(|w| w.is_visible().unwrap_or(false)).unwrap_or(false);
        if waiting || (from_launcher && self.app.get_webview_window(DASHBOARD).is_none()) {
            self.open_dashboard();
        }
    }

    /// Dit pourquoi le bot s'est arrêté, et ce qui le débloque.
    fn report_exit(&self, layout: &Layout, code: i32, at_launch: bool) {
        self.update(|inner| inner.phase = Phase::Idle);

        if code == 0 && !at_launch {
            self.update(|inner| {
                inner.snapshot.sequence("Le bot est éteint.", &[]);
                inner.snapshot.footer = Some(Footer {
                    log: None,
                    message: "Le bot est éteint.".into(),
                    details: Some("L'état de lecture est sauvegardé et sera restauré au prochain démarrage.".into()),
                    tone: Tone::Muted,
                    actions: vec![Action::primary("start", "Démarrer le bot"), Action::secondary("quit", "Quitter")],
                });
            });
            return self.show_launcher();
        }

        let log = layout.logs_dir().join("latest.log");
        let details = tail(&log, 20).or_else(|| tail(&layout.logs_dir().join("desktop-process.log"), 20));

        // Un jeton refusé est le seul échec de démarrage qui ait une réparation
        // évidente, et le plus probable sur une première installation.
        if details.as_deref().is_some_and(|d| d.contains("TokenInvalid") || d.contains("An invalid token was provided"))
        {
            return self.fail(
                "Discord a refusé le jeton du bot.",
                Some("Le jeton enregistré n'est plus accepté. Il a pu être régénéré depuis sur le portail, ou n'avoir été copié qu'en partie.".into()),
                vec![Action::primary("reconfigure", "Reconfigurer"), Action::secondary("open-logs", "Ouvrir les journaux")],
            );
        }

        let message =
            if at_launch { "Le bot s'est arrêté aussitôt après son démarrage." } else { "Le bot s'est arrêté." };
        self.fail_log(
            message,
            details.or_else(|| Some(format!("Code de sortie {code}. Aucun détail dans les journaux."))),
            vec![
                Action::primary("start", "Relancer"),
                Action::secondary("open-logs", "Ouvrir les journaux"),
                Action::secondary("quit", "Quitter"),
            ],
        );
    }

    // ------------------------------------------------------------------
    //  Bot lancé hors de l'application
    // ------------------------------------------------------------------

    fn attach(self: &Arc<Self>) {
        let background = self.lock().background;
        self.update(|inner| {
            inner.phase = Phase::Attached;
            inner.snapshot.screen = Screen::Cards;
            inner.snapshot.headline = "Le bot est déjà démarré.".into();
            inner.snapshot.steps.clear();
            inner.snapshot.footer = None;
            inner.snapshot.cards = vec![
                Card {
                    id: "open-dashboard",
                    title: "Ouvrir le tableau de bord".into(),
                    detail: "Dans cette application".into(),
                    glyph: "dashboard",
                    danger: false,
                },
                Card {
                    id: "open-browser",
                    title: "Ouvrir dans le navigateur".into(),
                    detail: "Le tableau de bord reste accessible depuis n'importe quel onglet".into(),
                    glyph: "browser",
                    danger: false,
                },
                Card {
                    id: "restart",
                    title: "Redémarrer le bot".into(),
                    detail: "La lecture reprend où elle en était".into(),
                    glyph: "restart",
                    danger: false,
                },
                Card {
                    id: "shutdown",
                    title: "Éteindre le bot".into(),
                    detail: "Coupe la lecture et arrête le processus".into(),
                    glyph: "shutdown",
                    danger: true,
                },
            ];
        });
        // L'application s'ouvre sur le tableau de bord du bot déjà lancé ; ses
        // commandes restent dans la fenêtre d'état et l'icône de notification.
        if !background {
            self.open_dashboard();
        }
    }

    /// Attend que le port se ferme, ou s'ouvre.
    fn wait_port(&self, layout: &Layout, open: bool, timeout: Duration) -> bool {
        let started = Instant::now();
        while started.elapsed() < timeout {
            if Endpoint::of(layout).answers() == open {
                return true;
            }
            thread::sleep(Duration::from_millis(300));
        }
        false
    }

    // ------------------------------------------------------------------
    //  Redémarrage, extinction, sortie
    // ------------------------------------------------------------------

    pub fn restart(self: &Arc<Self>) {
        let Some(layout) = self.layout() else { return };
        match self.phase() {
            Phase::Running => {
                // Le bot sauvegarde son état et sort avec le code 75 ; la
                // surveillance relance. Sans réponse, on force.
                if !Endpoint::of(&layout).send("restartBot") {
                    self.kill_and(|this| this.relaunch());
                }
            }
            Phase::Attached => {
                if !Endpoint::of(&layout).send("restartBot") {
                    return self.fail(
                        "La demande de redémarrage n'a pas pu être transmise.",
                        Some(format!("Le tableau de bord n'a pas répondu sur le port {}.", Endpoint::of(&layout).port)),
                        vec![Action::secondary("open-logs", "Ouvrir les journaux")],
                    );
                }
                self.update(|inner| {
                    inner
                        .snapshot
                        .sequence("Redémarrage en cours…", &["Arrêt de l'instance en cours", "Redémarrage du bot"]);
                });
                self.show_launcher();
                self.set_step(0, StepState::Running);
                // Ne pas avoir vu le port tomber n'est pas une erreur : un
                // redémarrage très bref a pu passer entre deux sondages.
                let closed = self.wait_port(&layout, false, Duration::from_secs(20));
                self.set_step(0, if closed { StepState::Done } else { StepState::Warned });
                self.set_step(1, StepState::Running);
                if self.wait_port(&layout, true, Duration::from_secs(90)) {
                    self.set_step(1, StepState::Done);
                    self.attach();
                } else {
                    self.set_step(1, StepState::Failed);
                    self.update(|inner| inner.phase = Phase::Idle);
                    self.fail_log(
                        "Le bot n'est pas revenu.",
                        tail(&layout.logs_dir().join("latest.log"), 12),
                        vec![
                            Action::primary("start", "Démarrer le bot"),
                            Action::secondary("open-logs", "Ouvrir les journaux"),
                        ],
                    );
                }
            }
            _ => self.start(),
        }
    }

    /// Demande confirmation avant d'éteindre : couper la lecture d'un serveur
    /// entier ne doit pas tenir à un clic de travers.
    pub fn confirm_shutdown(&self) {
        self.update(|inner| {
            inner.snapshot.footer = Some(Footer {
                log: None,
                message: "Éteindre le bot ?".into(),
                details: Some("La lecture en cours sera interrompue pour tous les auditeurs. L'état est sauvegardé et sera restauré au prochain démarrage.".into()),
                tone: Tone::Warn,
                actions: vec![Action::danger("confirm-shutdown", "Éteindre"), Action::secondary("cancel", "Annuler")],
            });
        });
        self.show_launcher();
    }

    pub fn cancel(&self) {
        self.update(|inner| inner.snapshot.footer = None);
    }

    pub fn shutdown(self: &Arc<Self>) {
        let Some(layout) = self.layout() else { return };
        match self.phase() {
            Phase::Running | Phase::Restarting => {
                self.update(|inner| {
                    inner.phase = Phase::Stopping;
                    inner.snapshot.sequence("Extinction en cours…", &["Extinction du bot"]);
                });
                self.set_step(0, StepState::Running);
                self.stop_owned(&layout);
            }
            Phase::Attached => {
                if !Endpoint::of(&layout).send("shutdownBot") {
                    return self.fail(
                        "La demande d'extinction n'a pas pu être transmise.",
                        Some(format!("Le tableau de bord n'a pas répondu sur le port {}.", Endpoint::of(&layout).port)),
                        vec![Action::secondary("open-logs", "Ouvrir les journaux")],
                    );
                }
                self.close_dashboard();
                self.update(|inner| inner.snapshot.sequence("Extinction en cours…", &["Extinction du bot"]));
                self.set_step(0, StepState::Running);
                // L'extinction commence par un fondu de la musique, réglable
                // jusqu'à plusieurs secondes : le délai est large.
                if self.wait_port(&layout, false, Duration::from_secs(60)) {
                    self.set_step(0, StepState::Done);
                    self.update(|inner| {
                        inner.phase = Phase::Idle;
                        inner.snapshot.headline = "Le bot est éteint.".into();
                        inner.snapshot.footer = Some(Footer {
                            log: None,
                            message: "Le bot est éteint.".into(),
                            details: Some(
                                "L'état de lecture est sauvegardé et sera restauré au prochain démarrage.".into(),
                            ),
                            tone: Tone::Muted,
                            actions: vec![
                                Action::primary("start", "Démarrer le bot"),
                                Action::secondary("quit", "Quitter"),
                            ],
                        });
                    });
                } else {
                    self.set_step(0, StepState::Failed);
                    self.fail(
                        "Le bot ne s'est pas arrêté.",
                        None,
                        vec![Action::secondary("open-logs", "Ouvrir les journaux")],
                    );
                }
            }
            _ => {}
        }
    }

    /// Éteint le bot qu'on garde : en douceur par sa WebSocket — fondu et
    /// sauvegarde —, de force s'il ne répond pas ou ne sort pas à temps. Dans
    /// les deux cas c'est la surveillance qui constate la fin, et `exited`
    /// qui en tire la suite : message d'extinction, ou sortie de
    /// l'application.
    fn stop_owned(self: &Arc<Self>, layout: &Layout) {
        let generation = self.lock().generation;
        if !Endpoint::of(layout).send("shutdownBot") {
            if let Some(child) = self.lock().child.as_mut() {
                let _ = child.kill();
            }
            return;
        }
        let this = self.clone();
        thread::spawn(move || {
            // L'extinction commence par un fondu, réglable jusqu'à plusieurs
            // secondes depuis le tableau de bord : le délai est large.
            thread::sleep(Duration::from_secs(60));
            let mut inner = this.lock();
            if inner.generation == generation {
                if let Some(child) = inner.child.as_mut() {
                    let _ = child.kill();
                }
            }
        });
    }

    fn kill_and(self: &Arc<Self>, then: impl FnOnce(&Arc<Self>)) {
        {
            let mut inner = self.lock();
            // La surveillance de ce processus se taira : c'est nous qui le
            // remplaçons, sa mort n'est pas un incident.
            inner.generation += 1;
            if let Some(mut child) = inner.child.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
        then(self);
    }

    /// Quitte l'application. Le bot qu'elle garde s'éteint avec elle, en
    /// douceur ; un bot lancé ailleurs continue sa vie.
    pub fn quit(self: &Arc<Self>) {
        let Some(layout) = self.layout() else {
            self.app.exit(0);
            return;
        };
        let owned = {
            let mut inner = self.lock();
            inner.quitting = true;
            inner.child.is_some()
        };
        if !owned {
            self.app.exit(0);
            return;
        }
        self.close_dashboard();
        self.update(|inner| {
            inner.phase = Phase::Stopping;
            inner.snapshot.sequence("Extinction en cours…", &["Extinction du bot"]);
        });
        self.set_step(0, StepState::Running);
        self.show_launcher();
        self.stop_owned(&layout);
    }

    /// Tue le bot sans attendre : l'application est fermée par le système.
    pub fn kill_now(&self) {
        let mut inner = self.lock();
        inner.generation += 1;
        if let Some(mut child) = inner.child.take() {
            let _ = child.kill();
        }
    }

    // ------------------------------------------------------------------
    //  Assistant de première configuration
    // ------------------------------------------------------------------

    fn enter_setup(&self) {
        self.close_dashboard();
        self.update(|inner| {
            inner.phase = Phase::Setup;
            inner.snapshot.screen = Screen::Setup;
            inner.snapshot.headline = "Première configuration".into();
            inner.snapshot.footer = None;
            inner.snapshot.setup = Default::default();
        });
        self.show_launcher();
    }

    pub fn reconfigure(&self) {
        self.close_dashboard();
        self.enter_setup();
    }

    pub fn submit_token(self: &Arc<Self>, token: String) {
        let Some(layout) = self.layout() else { return };
        if !discord::looks_like_token(&token) {
            return self.update(|inner| {
                inner.snapshot.setup.status =
                    "Ce texte n'a pas la forme d'un jeton. Sur le portail, onglet Bot : Reset Token, puis Copy.".into();
                inner.snapshot.setup.tone = Tone::Error;
            });
        }
        self.update(|inner| {
            inner.snapshot.setup.busy = true;
            inner.snapshot.setup.status = "Vérification auprès de Discord…".into();
            inner.snapshot.setup.tone = Tone::Muted;
        });

        match discord::validate_token(&token) {
            discord::Verdict::Accepted { id, name } => {
                ensure_env_file(&layout);
                let written = env_file::set_values(
                    &layout.env_file(),
                    &[("DISCORD_TOKEN", token.trim()), ("DISCORD_CLIENT_ID", id.as_str())],
                );
                if let Err(err) = written {
                    return self.update(|inner| {
                        inner.snapshot.setup.busy = false;
                        inner.snapshot.setup.status = format!("Le fichier .env n'a pas pu être écrit : {err}");
                        inner.snapshot.setup.tone = Tone::Error;
                    });
                }
                self.update(|inner| {
                    inner.client_id = id;
                    inner.deploy_pending = true;
                    inner.snapshot.headline = "Plus qu'une étape.".into();
                    inner.snapshot.setup.stage = 2;
                    inner.snapshot.setup.busy = false;
                    inner.snapshot.setup.bot_name =
                        if name.is_empty() { "Application reconnue.".into() } else { format!("« {name} » est reconnu.") };
                });
            }
            discord::Verdict::Rejected => self.update(|inner| {
                inner.snapshot.setup.busy = false;
                inner.snapshot.setup.status = "Discord refuse ce jeton. Reprenez-le dans l'onglet Bot, par Reset Token puis Copy — un jeton n'est visible qu'une fois, juste après avoir été régénéré.".into();
                inner.snapshot.setup.tone = Tone::Error;
            }),
            discord::Verdict::Offline(reason) => self.update(|inner| {
                inner.snapshot.setup.busy = false;
                inner.snapshot.setup.status = format!(
                    "Discord est injoignable pour l'instant ({reason}). Vérifiez votre connexion, puis collez le jeton de nouveau."
                );
                inner.snapshot.setup.tone = Tone::Warn;
            }),
        }
    }

    /// Ouvre l'invitation, et démarre le bot sans attendre qu'elle soit
    /// acceptée : il démarre très bien sans aucun serveur, et le tableau de
    /// bord sait le dire.
    pub fn invite_and_start(self: &Arc<Self>) {
        let client_id = self.lock().client_id.clone();
        if !client_id.is_empty() {
            let _ = self.app.opener().open_url(discord::invite_url(&client_id), None::<&str>);
        }
        self.finish_setup();
    }

    pub fn finish_setup(self: &Arc<Self>) {
        self.lock().phase = Phase::Idle;
        self.start();
    }

    pub fn open_portal(&self) {
        let _ = self.app.opener().open_url(discord::PORTAL_URL, None::<&str>);
    }

    /// « Utiliser une installation existante » : un clone du dépôt, avec son
    /// `.env` et ses `data/`.
    pub fn choose_folder(self: &Arc<Self>) {
        use tauri_plugin_dialog::DialogExt;
        let picked = self
            .app
            .dialog()
            .file()
            .set_title("Dossier du bot (celui qui contient src et package.json)")
            .blocking_pick_folder();
        let Some(path) = picked.and_then(|p| p.into_path().ok()) else { return };
        if !layout::is_bot_root(&path) {
            return self.update(|inner| {
                inner.snapshot.setup.status = format!(
                    "{} ne contient pas le bot : choisissez le dossier où se trouvent src et package.json.",
                    path.display()
                );
                inner.snapshot.setup.tone = Tone::Error;
            });
        }
        let mut settings = layout::read_settings(&self.app);
        settings.bot_root = Some(path);
        if let Err(err) = layout::write_settings(&self.app, &settings) {
            return self.update(|inner| {
                inner.snapshot.setup.status = format!("Le réglage n'a pas pu être enregistré : {err}");
                inner.snapshot.setup.tone = Tone::Error;
            });
        }
        self.lock().phase = Phase::Idle;
        self.start();
    }

    /// Revient au dossier géré par l'application.
    pub fn use_default_folder(self: &Arc<Self>) {
        let mut settings = layout::read_settings(&self.app);
        settings.bot_root = None;
        let _ = layout::write_settings(&self.app, &settings);
        self.lock().phase = Phase::Idle;
        self.start();
    }

    /// Fermeture d'une fenêtre : rien ne s'arrête tant que le bot tourne,
    /// l'application reste dans la zone de notification.
    pub fn window_closing(&self, label: &str) -> bool {
        if label == DASHBOARD {
            return true;
        }
        let phase = self.phase();
        phase.bot_alive() || phase == Phase::Launching
    }
}

/// Crée `.env` depuis l'exemple s'il manque, pour que l'utilisateur garde les
/// explications de chaque variable.
fn ensure_env_file(layout: &Layout) {
    let env = layout.env_file();
    if env.exists() {
        return;
    }
    let example = layout.root.join(".env.example");
    if example.is_file() {
        let _ = fs::copy(&example, &env);
    } else {
        let _ = fs::write(&env, "");
    }
}

/// Lit, puis efface, la demande de relance déposée par le bot.
///
/// Le point d'entrée n'est retenu que s'il désigne bien un bot — un
/// `src/index.js` sous une racine qui en a la forme. À défaut, l'instance
/// courante est relancée.
fn take_restart_request(layout: &Layout) -> Option<PathBuf> {
    let file = layout.root.join("data").join(RESTART_REQUEST);
    let text = fs::read_to_string(&file).ok();
    let _ = fs::remove_file(&file);
    let value: serde_json::Value = serde_json::from_str(&text?).ok()?;
    let entry = PathBuf::from(value.get("entryPoint")?.as_str()?);
    let entry = if entry.is_absolute() { entry } else { layout.root.join(entry) };
    if entry.file_name()? != "index.js" || !entry.is_file() {
        return None;
    }
    let src = entry.parent()?;
    if src.file_name()? != "src" {
        return None;
    }
    layout::is_bot_root(src.parent()?).then_some(entry)
}

/// Lance une commande jusqu'au bout, sa sortie dans un journal.
fn run_logged(layout: &Layout, command: &mut Command, log: &Path) -> bool {
    if let Some(dir) = log.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let Ok(file) = File::create(log) else { return false };
    let Ok(copy) = file.try_clone() else { return false };
    command.current_dir(&layout.root).env("PATH", layout.child_path()).stdin(Stdio::null()).stdout(copy).stderr(file);
    hide_console(command);
    command.status().map(|s| s.success()).unwrap_or(false)
}

#[cfg(windows)]
fn hide_console(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_console(_command: &mut Command) {}

/// Les dernières lignes d'un journal, sans codes de couleur.
pub fn tail(path: &Path, lines: usize) -> Option<String> {
    let mut file = File::open(path).ok()?;
    let length = file.metadata().ok()?.len();
    let start = length.saturating_sub(64 * 1024);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).ok()?;
    let text = String::from_utf8_lossy(&bytes);
    let cleaned = strip_ansi(&text);
    let kept: Vec<&str> = cleaned.lines().filter(|l| !l.trim().is_empty()).collect();
    if kept.is_empty() {
        return None;
    }
    Some(kept[kept.len().saturating_sub(lines)..].join("\n"))
}

/// La fenêtre montre-t-elle une page embarquée — la page d'attente — plutôt
/// que le tableau de bord servi par le bot ?
fn on_app_page(window: &WebviewWindow) -> bool {
    window.url().map(|url| is_app_url(&url)).unwrap_or(true)
}

/// Une adresse des pages embarquées : `tauri://localhost` sous macOS et Linux,
/// `http(s)://tauri.localhost` sous Windows.
fn is_app_url(url: &tauri::Url) -> bool {
    url.scheme() == "tauri" || url.host_str() == Some("tauri.localhost")
}

/// L'hôte de l'adresse relais : une navigation vers lui demande d'ouvrir son
/// paramètre `u` dans le navigateur. `.invalid` ne se résout jamais — si
/// l'interception manquait, la page n'irait nulle part. Doit rester celui de
/// `RELAY`, dans external_links.js.
const OPEN_EXTERNAL_HOST: &str = "imp-open.invalid";

/// Injecté dans chaque page de la fenêtre principale : voir external_links.js.
const EXTERNAL_LINKS_SCRIPT: &str = include_str!("external_links.js");

/// Ce que devient une navigation de la fenêtre principale.
#[derive(Debug, PartialEq)]
enum Navigation {
    /// Une navigation ordinaire : elle suit son cours.
    Proceed,
    /// L'adresse relais, avec un paramètre qui ne peut pas sortir.
    Drop,
    /// L'adresse relais : son paramètre part dans le navigateur.
    Open(tauri::Url),
}

fn route_navigation(url: &tauri::Url) -> Navigation {
    if url.host_str() != Some(OPEN_EXTERNAL_HOST) {
        return Navigation::Proceed;
    }
    url.query_pairs()
        .find(|(key, _)| key == "u")
        .and_then(|(_, value)| tauri::Url::parse(&value).ok())
        .filter(is_external_link)
        .map_or(Navigation::Drop, Navigation::Open)
}

/// Confie un lien au navigateur de l'utilisateur.
///
/// Sur le fil principal, mais hors du gestionnaire d'événement de la webview
/// qui l'a demandé : l'ouverture passe par le shell de Windows, qui n'a rien à
/// faire au milieu d'un événement WebView2. Si le shell refuse, l'Explorateur
/// prend le relais — il sait lui aussi remettre une adresse au navigateur par
/// défaut.
fn open_external(app: &AppHandle, url: tauri::Url) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if handle.opener().open_url(url.as_str(), None::<&str>).is_err() {
            #[cfg(windows)]
            let _ = Command::new("explorer.exe").arg(url.as_str()).spawn();
        }
    });
}

/// Un lien que le navigateur de l'utilisateur saura ouvrir.
///
/// Ce qui sort d'ici est confié au système : seuls le web et le courriel
/// passent, jamais un fichier ni un protocole d'application.
fn is_external_link(url: &tauri::Url) -> bool {
    match url.scheme() {
        "http" | "https" => url.host().is_some(),
        "mailto" => true,
        _ => false,
    }
}

fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' && chars.peek() == Some(&'[') {
            chars.next();
            for next in chars.by_ref() {
                if next.is_ascii_alphabetic() {
                    break;
                }
            }
            continue;
        }
        out.push(c);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_web_links_leave_the_app() {
        let link = |s: &str| is_external_link(&tauri::Url::parse(s).unwrap());
        assert!(link("https://github.com/WolfGang-PRoxa/interactive-music-player"));
        assert!(link("https://buymeacoffee.com/wolfgang_proxa"));
        assert!(link("http://localhost:3000/docs"));
        assert!(link("mailto:someone@example.com"));
        assert!(!link("file:///C:/Windows/System32/calc.exe"));
        assert!(!link("ms-settings:privacy"));
        assert!(!link("about:blank"));
    }

    #[test]
    fn relayed_links_open_in_the_browser_and_nothing_else_does() {
        let route = |s: &str| route_navigation(&tauri::Url::parse(s).unwrap());
        let relay = |target: &str| {
            let mut url = tauri::Url::parse(&format!("https://{OPEN_EXTERNAL_HOST}/")).unwrap();
            url.query_pairs_mut().append_pair("u", target);
            route(url.as_str())
        };
        let open = |s: &str| Navigation::Open(tauri::Url::parse(s).unwrap());

        assert_eq!(relay("https://buymeacoffee.com/wolfgang_proxa"), open("https://buymeacoffee.com/wolfgang_proxa"));
        assert_eq!(
            relay("https://github.com/WolfGang-PRoxa/interactive-music-player/issues/new?title=a&b=c"),
            open("https://github.com/WolfGang-PRoxa/interactive-music-player/issues/new?title=a&b=c")
        );
        // Ce que le script injecté envoie : encodeURIComponent.
        assert_eq!(
            route("https://imp-open.invalid/?u=https%3A%2F%2Fgithub.com%2FWolfGang-PRoxa%2Finteractive-music-player"),
            open("https://github.com/WolfGang-PRoxa/interactive-music-player")
        );
        assert_eq!(relay("file:///C:/Windows/System32/calc.exe"), Navigation::Drop);
        assert_eq!(relay("not a url"), Navigation::Drop);
        assert_eq!(route("https://imp-open.invalid/"), Navigation::Drop);
        assert_eq!(route("http://localhost:3000/?token=abc"), Navigation::Proceed);
        assert_eq!(route("https://discord.com/oauth2/authorize?u=https%3A%2F%2Fexample.com"), Navigation::Proceed);
        assert_eq!(route("tauri://localhost/starting.html"), Navigation::Proceed);
    }

    #[test]
    fn the_injected_script_targets_the_relay() {
        assert!(EXTERNAL_LINKS_SCRIPT.contains(&format!("'https://{OPEN_EXTERNAL_HOST}/?u='")));
    }

    #[test]
    fn app_pages_are_told_apart_from_the_dashboard() {
        let app = |s: &str| is_app_url(&tauri::Url::parse(s).unwrap());
        assert!(app("tauri://localhost/starting.html"));
        assert!(app("http://tauri.localhost/starting.html"));
        assert!(!app("http://localhost:3000/"));
        assert!(!app("https://imp.example.dev/"));
    }

    #[test]
    fn ansi_is_stripped() {
        assert_eq!(strip_ansi("\u{1b}[32mok\u{1b}[0m fin"), "ok fin");
    }

    #[test]
    fn tail_keeps_last_lines() {
        let dir = std::env::temp_dir().join(format!("imp-tail-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("latest.log");
        fs::write(&path, "un\ndeux\n\ntrois\nquatre\n").unwrap();
        assert_eq!(tail(&path, 2).unwrap(), "trois\nquatre");
        assert!(tail(&dir.join("absent.log"), 2).is_none());
    }
}
