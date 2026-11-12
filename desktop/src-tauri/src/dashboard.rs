//! Parler au bot une fois lancé : son port, son adresse, ses commandes.
//!
//! Aucun point d'accès n'est ajouté pour l'application. Elle emprunte ceux que
//! le lanceur PowerShell utilisait déjà : `/api/clients` pour l'adresse du
//! tableau de bord, la WebSocket authentifiée pour `restartBot` et
//! `shutdownBot` (src/web/websocket/handlers/systemHandlers.js).

use std::collections::HashMap;
use std::fs;
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

use crate::layout::Layout;

pub struct Endpoint {
    pub port: u16,
    pub token: String,
    env: HashMap<String, String>,
}

impl Endpoint {
    /// Lit le port et le jeton du tableau de bord pour ce bot.
    ///
    /// Le jeton vient de `DASHBOARD_TOKEN` s'il est renseigné, sinon de
    /// `data/dashboard-token`, que le bot écrit à son premier démarrage (voir
    /// src/web/auth.js). Il est relu à chaque fois : il n'existe pas encore
    /// avant le premier démarrage.
    pub fn of(layout: &Layout) -> Self {
        let env = crate::env_file::read(&layout.env_file());
        let port = env.get("PORT").and_then(|p| p.trim().parse().ok()).unwrap_or(3000);
        let token = env
            .get("DASHBOARD_TOKEN")
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty())
            .or_else(|| {
                fs::read_to_string(layout.root.join("data").join("dashboard-token")).ok().map(|t| t.trim().to_string())
            })
            .unwrap_or_default();
        Endpoint { port, token, env }
    }

    /// Le serveur du tableau de bord accepte-t-il une connexion ?
    ///
    /// C'est le seul signal fiable que le bot est prêt : il n'ouvre son port
    /// qu'une fois connecté à Discord (événement ClientReady de src/index.js).
    pub fn answers(&self) -> bool {
        port_answers(self.port)
    }

    /// Combien d'onglets sont connectés, et où ouvrir le suivant.
    ///
    /// Le jeton passe en en-tête : un GET porteur de `?token=` est redirigé
    /// vers l'adresse nettoyée, le jeton confié à un cookie que ce client ne
    /// garderait pas.
    pub fn clients(&self) -> (Option<u64>, String) {
        let url = format!("http://127.0.0.1:{}/api/clients", self.port);
        let mut request = ureq::get(&url).timeout(Duration::from_secs(2));
        if !self.token.is_empty() {
            request = request.set("Authorization", &format!("Bearer {}", self.token));
        }
        let Ok(response) = request.call() else {
            return (None, String::new());
        };
        let Ok(body) = response.into_json::<serde_json::Value>() else {
            return (None, String::new());
        };
        let count = body.get("count").and_then(|c| c.as_u64());
        let entry = body.get("entry").and_then(|e| e.as_str()).map(web_address).unwrap_or_default();
        (count, entry)
    }

    /// Adresse du tableau de bord, jeton compris.
    ///
    /// Sur l'origine où vit la session Discord, pas sur l'interface d'écoute :
    /// un cookie appartient à une origine, et le retour de Discord pose le sien
    /// sur `PUBLIC_URL` quand elle est déclarée, et sur l'origine de départ
    /// quand le relais de retour OAuth s'en charge (voir oauth.entryUrl).
    /// L'adresse donnée par le bot passe donc en premier : lui seul sait
    /// lequel des deux cas est le sien.
    pub fn url(&self) -> String {
        let (_, entry) = self.clients();
        let mut base = entry;
        if base.is_empty() {
            base = self.env.get("PUBLIC_URL").map(|u| web_address(u)).unwrap_or_default();
        }
        if base.is_empty() {
            let host = self.env.get("HOST").map(|h| h.trim()).filter(|h| !h.is_empty()).unwrap_or("localhost");
            let host = match host {
                "0.0.0.0" | "::" | "127.0.0.1" => "localhost",
                other => other,
            };
            base = format!("http://{host}:{}", self.port);
        }
        if self.token.is_empty() {
            format!("{base}/")
        } else {
            format!("{base}/?token={}", self.token)
        }
    }

    /// Envoie au bot une commande du tableau de bord, par sa WebSocket.
    ///
    /// Le serveur traite le message de façon asynchrone ; fermer la socket dans
    /// la foulée couperait avant qu'il ne l'ait lu. On lui laisse un instant,
    /// sans attendre la poignée de main de fermeture, qu'un processus en train
    /// de s'arrêter n'achèvera pas.
    pub fn send(&self, kind: &str) -> bool {
        let address = SocketAddr::from(([127, 0, 0, 1], self.port));
        let Ok(stream) = TcpStream::connect_timeout(&address, Duration::from_secs(2)) else {
            return false;
        };
        let _ = stream.set_read_timeout(Some(Duration::from_secs(4)));
        let _ = stream.set_write_timeout(Some(Duration::from_secs(4)));
        let mut url = format!("ws://127.0.0.1:{}/", self.port);
        if !self.token.is_empty() {
            url.push_str(&format!("?token={}", self.token));
        }
        let Ok((mut socket, _)) = tungstenite::client(url.as_str(), stream) else {
            return false;
        };
        let message = serde_json::json!({ "type": kind }).to_string();
        let sent = socket.send(tungstenite::Message::Text(message.into())).is_ok();
        std::thread::sleep(Duration::from_millis(250));
        sent
    }
}

pub fn port_answers(port: u16) -> bool {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&address, Duration::from_millis(150)).is_ok()
}

/// Une adresse web absolue sans barre finale, ou une chaîne vide.
///
/// Ce qui sort d'ici finit dans une fenêtre ou un navigateur : seules http et
/// https passent.
pub fn web_address(value: &str) -> String {
    let value = value.trim();
    match tauri::Url::parse(value) {
        Ok(url) if matches!(url.scheme(), "http" | "https") && url.host().is_some() => {
            value.trim_end_matches('/').to_string()
        }
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_web_addresses_pass() {
        assert_eq!(web_address("https://pc.tail.ts.net/"), "https://pc.tail.ts.net");
        assert_eq!(web_address(" http://localhost:3000 "), "http://localhost:3000");
        assert_eq!(web_address("file:///C:/Windows"), "");
        assert_eq!(web_address("calc.exe"), "");
        assert_eq!(web_address(""), "");
    }
}
