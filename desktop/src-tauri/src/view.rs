//! Ce que la fenêtre de lancement affiche.
//!
//! Toute la logique vit côté Rust ; la page ne fait que dessiner l'instantané
//! qu'on lui envoie à chaque changement, et renvoyer l'identifiant du bouton
//! cliqué. Elle n'a donc rien à décider, et rien à désynchroniser.

use serde::Serialize;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum StepState {
    Pending,
    Running,
    Done,
    Warned,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
pub struct Step {
    pub caption: String,
    pub state: StepState,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Primary,
    Secondary,
    Danger,
}

#[derive(Debug, Clone, Serialize)]
pub struct Action {
    pub id: &'static str,
    pub label: String,
    pub kind: Kind,
}

impl Action {
    pub fn primary(id: &'static str, label: &str) -> Self {
        Action { id, label: label.into(), kind: Kind::Primary }
    }
    pub fn secondary(id: &'static str, label: &str) -> Self {
        Action { id, label: label.into(), kind: Kind::Secondary }
    }
    pub fn danger(id: &'static str, label: &str) -> Self {
        Action { id, label: label.into(), kind: Kind::Danger }
    }
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Tone {
    Muted,
    Warn,
    Error,
}

#[derive(Debug, Clone, Serialize)]
pub struct Footer {
    pub message: String,
    pub details: Option<String>,
    /// Fin d'un journal, affichée en chasse fixe.
    pub log: Option<String>,
    pub tone: Tone,
    pub actions: Vec<Action>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Card {
    pub id: &'static str,
    pub title: String,
    pub detail: String,
    pub glyph: &'static str,
    pub danger: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Setup {
    /// 1 : coller le jeton ; 2 : inviter le bot.
    pub stage: u8,
    pub status: String,
    pub tone: Tone,
    pub bot_name: String,
    pub busy: bool,
}

impl Default for Setup {
    fn default() -> Self {
        Setup {
            stage: 1,
            status: "En attente du jeton. Collez-le ci-dessus.".into(),
            tone: Tone::Muted,
            bot_name: String::new(),
            busy: false,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Screen {
    Steps,
    Setup,
    Cards,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub screen: Screen,
    pub headline: String,
    pub steps: Vec<Step>,
    /// Avancement de l'étape en cours, quand elle sait le mesurer.
    pub progress: Option<f64>,
    pub cards: Vec<Card>,
    pub footer: Option<Footer>,
    pub setup: Setup,
    /// Dossier du bot, affiché en pied de fenêtre.
    pub root: String,
    /// Le bot vient-il d'un dossier choisi, que l'on peut quitter ?
    pub chosen_root: bool,
    /// Rien ne tourne : l'utilisateur peut changer de dossier.
    pub idle: bool,
}

impl Default for Snapshot {
    fn default() -> Self {
        Snapshot {
            screen: Screen::Steps,
            headline: "Démarrage en cours…".into(),
            steps: Vec::new(),
            progress: None,
            cards: Vec::new(),
            footer: None,
            setup: Setup::default(),
            root: String::new(),
            chosen_root: false,
            idle: false,
        }
    }
}

impl Snapshot {
    /// Repart sur une liste d'étapes neuve, en gardant ce qui décrit le dossier.
    pub fn sequence(&mut self, headline: &str, captions: &[&str]) {
        self.screen = Screen::Steps;
        self.headline = headline.into();
        self.steps = captions.iter().map(|c| Step { caption: (*c).into(), state: StepState::Pending }).collect();
        self.progress = None;
        self.cards.clear();
        self.footer = None;
    }
}
