const fs = require('fs');
const path = require('path');

// Remplacement : ces deux clés existent déjà et changent de texte.
const KEYS = {
    fr: {
        tunnel_declare_action: "Copier l'URL de rappel et ouvrir Discord",
        tunnel_declare_tip: "Ce n'est pas l'adresse ci-dessous : l'URL de rappel est la même, suivie du chemin où Discord renvoie. Ouvre la page OAuth2 de votre application.",
    },
    en: {
        tunnel_declare_action: 'Copy the callback URL and open Discord',
        tunnel_declare_tip: 'Not the address below: the callback URL is the same one, followed by the path Discord returns to. Opens your application’s OAuth2 page.',
    },
    es: {
        tunnel_declare_action: 'Copiar la URL de retorno y abrir Discord',
        tunnel_declare_tip: 'No es la dirección de abajo: la URL de retorno es la misma, seguida de la ruta a la que Discord devuelve. Abre la página OAuth2 de tu aplicación.',
    },
    de: {
        tunnel_declare_action: 'Rückruf-URL kopieren und Discord öffnen',
        tunnel_declare_tip: 'Nicht die Adresse unten: Die Rückruf-URL ist dieselbe, gefolgt vom Pfad, zu dem Discord zurückkehrt. Öffnet die OAuth2-Seite deiner Anwendung.',
    },
};

for (const [lang, entries] of Object.entries(KEYS)) {
    const file = path.join('src', 'web', 'public', 'locales', `${lang}.json`);
    let text = fs.readFileSync(file, 'utf8');

    for (const [k, v] of Object.entries(entries)) {
        const motif = new RegExp(`("${k}"\s*:\s*)"(?:[^"\\]|\\.)*"`);
        if (!motif.test(text)) throw new Error(`${lang} : ${k} introuvable`);
        text = text.replace(motif, `$1${JSON.stringify(v)}`);
    }

    fs.writeFileSync(file, text, 'utf8');
    const relu = JSON.parse(fs.readFileSync(file, 'utf8'));
    console.log(`${lang} : ${relu.tunnel_declare_action}`);
}
