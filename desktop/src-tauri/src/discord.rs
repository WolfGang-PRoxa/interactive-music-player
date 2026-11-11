//! Ce que l'assistant de première configuration demande à Discord.
//!
//! Repris de `tools/start-bot.ps1` : le jeton suffit, l'identifiant de
//! l'application se lit auprès de Discord. Il n'y a rien à recopier, donc rien
//! à confondre — l'erreur classique, prendre l'identifiant du bot pour celui de
//! l'application, ne peut plus se produire.

use std::time::Duration;

/// Discord demande un agent utilisateur de cette forme sur les appels à son
/// API, et sa protection de façade écarte ce qui n'en porte pas.
const USER_AGENT: &str = "DiscordBot (https://github.com/WolfGang-PRoxa/interactive-music-player, 1.0)";

pub const PORTAL_URL: &str = "https://discord.com/developers/applications";

/// Permissions demandées à l'invitation : voir les salons, s'y connecter, y
/// parler, gérer les salons (salons personnels) et déplacer les membres.
const INVITE_PERMISSIONS: u64 = (1 << 10) + (1 << 20) + (1 << 21) + (1 << 4) + (1 << 24);

pub fn invite_url(client_id: &str) -> String {
    format!(
        "https://discord.com/oauth2/authorize?client_id={client_id}&permissions={INVITE_PERMISSIONS}&scope=bot+applications.commands"
    )
}

/// Trois segments base64url séparés par des points : la forme d'un jeton.
///
/// Le test reste large à dessein : il ne décide pas si le jeton est bon,
/// seulement s'il vaut la peine d'aller le demander à Discord.
pub fn looks_like_token(text: &str) -> bool {
    let parts: Vec<&str> = text.trim().split('.').collect();
    let minimums = [16, 5, 20];
    parts.len() == 3
        && parts.iter().zip(minimums).all(|(part, min)| {
            part.len() >= min && part.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        })
}

pub enum Verdict {
    Accepted {
        id: String,
        name: String,
    },
    /// 401 ou 403 : ce jeton-là n'est pas le bon.
    Rejected,
    /// Tout le reste — DNS, proxy, câble — est une panne de liaison, et
    /// reprocher son jeton à l'utilisateur l'enverrait corriger ce qui va bien.
    Offline(String),
}

pub fn validate_token(token: &str) -> Verdict {
    let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(12)).user_agent(USER_AGENT).build();
    let answer = agent
        .get("https://discord.com/api/v10/oauth2/applications/@me")
        .set("Authorization", &format!("Bot {}", token.trim()))
        .call();
    match answer {
        Ok(response) => {
            let Ok(app) = response.into_json::<serde_json::Value>() else {
                return Verdict::Offline("réponse illisible".into());
            };
            match app.get("id").and_then(|v| v.as_str()) {
                Some(id) => Verdict::Accepted {
                    id: id.to_string(),
                    name: app.get("name").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
                },
                None => Verdict::Rejected,
            }
        }
        Err(ureq::Error::Status(401 | 403, _)) => Verdict::Rejected,
        Err(err) => Verdict::Offline(err.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_shape() {
        assert!(looks_like_token("MTAxMjM0NTY3ODkwMTIzNDU2.GabcDe.abcdefghijklmnopqrstuvwxyz0123"));
        assert!(looks_like_token("  MTAxMjM0NTY3ODkwMTIzNDU2.GabcDe.abcdefghijklmnopqrstuvwxyz0123\n"));
        assert!(!looks_like_token("your_bot_token_here"));
        assert!(!looks_like_token("a.b.c"));
        assert!(!looks_like_token("MTAxMjM0NTY3ODkwMTIzNDU2.Gab cDe.abcdefghijklmnopqrstuvwxyz0123"));
    }

    #[test]
    fn invite_carries_both_scopes() {
        let url = invite_url("123");
        assert!(url.contains("client_id=123"));
        assert!(url.contains("permissions=19923984"));
        assert!(url.ends_with("scope=bot+applications.commands"));
    }
}
