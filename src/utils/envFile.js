/**
 * envFile — Lire et modifier le fichier `.env` sans le défigurer.
 *
 * Le `.env` est le seul endroit où vit la configuration du bot. Le modifier
 * depuis le tableau de bord ne doit rien coûter à qui préfère l'éditer à la
 * main : les commentaires de `.env.example` expliquent chaque variable, et
 * réécrire le fichier à partir d'une table en ferait perdre la trace. Seules
 * les lignes des clés demandées changent, sur place ; une clé absente est
 * ajoutée à la fin plutôt que perdue.
 *
 * Même discipline que `desktop/src-tauri/src/env_file.rs`, côté application
 * de bureau.
 *
 * La lecture passe par `dotenv.parse`, celle-là même qui charge le fichier au
 * démarrage : ce qui est affiché est exactement ce que le bot lira.
 */

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

/** Le fichier que `require('dotenv').config()` charge : celui de la racine partagée. */
function envPath() {
  return path.join(process.cwd(), '.env');
}

/** Le modèle d'où part un `.env` qui n'existe pas encore. */
function examplePath() {
  return path.join(process.cwd(), '.env.example');
}

function readText(file) {
  try {
    // Un BOM collerait au nom de la première variable, qui deviendrait
    // introuvable : dotenv a le même travers, d'où l'écriture sans BOM.
    return fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Les paires clé/valeur du fichier, telles que dotenv les lit.
 * Un fichier absent rend une table vide.
 *
 * @param {string} [file]
 * @returns {Record<string, string>}
 */
function read(file = envPath()) {
  const text = readText(file);
  return text === null ? {} : dotenv.parse(text);
}

/**
 * La valeur écrite comme dotenv la relira.
 *
 * Sans guillemets, dotenv coupe au premier `#` et rogne les blancs du bord :
 * une valeur qui en contient est donc entourée de guillemets, simples de
 * préférence (rien n'y est interprété), doubles s'il le faut.
 *
 * @param {string} value
 * @returns {string}
 */
function serialize(value) {
  const text = String(value);
  if (/[\r\n]/.test(text)) {
    throw new Error('Une valeur du fichier .env tient sur une seule ligne.');
  }
  const needsQuotes = text.includes('#') || text !== text.trim() || /^['"`]/.test(text);
  if (!needsQuotes) return text;
  if (!text.includes("'")) return `'${text}'`;
  if (!text.includes('"')) return `"${text}"`;
  if (!text.includes('`')) return `\`${text}\``;
  throw new Error("Cette valeur mêle les trois sortes de guillemets : elle ne peut pas s'écrire dans .env.");
}

/** La clé d'une ligne d'affectation, ou null pour un commentaire ou un blanc. */
function keyOf(line) {
  const match = /^\s*(?:export\s+)?([\w.-]+)\s*=/.exec(line);
  return match ? match[1] : null;
}

/**
 * Inscrit des valeurs dans le fichier, sans toucher au reste.
 *
 * Une clé présente plusieurs fois voit toutes ses lignes réécrites : dotenv
 * retient la dernière, et n'en changer qu'une laisserait l'autre décider.
 * Les fins de ligne du fichier (CRLF sous Windows) sont conservées. L'écriture
 * passe par un fichier temporaire renommé, pour qu'une coupure en plein milieu
 * ne laisse pas un `.env` à moitié écrit — le bot ne redémarrerait plus.
 *
 * @param {Record<string, string>} values
 * @param {string} [file]
 */
function update(values, file = envPath()) {
  const entries = Object.entries(values).map(([key, value]) => {
    if (!/^[\w.-]+$/.test(key)) throw new Error(`Nom de variable invalide : ${key}`);
    return [key, `${key}=${serialize(value === null || value === undefined ? '' : value)}`];
  });
  if (entries.length === 0) return;

  let text = readText(file);
  // Premier enregistrement sans .env : on part du modèle, pour que le
  // fichier créé porte les explications de chaque variable.
  if (text === null && file === envPath()) text = readText(examplePath());
  if (text === null) text = '';

  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.length ? text.split(/\r?\n/) : [];
  // Le saut de ligne final donne un dernier élément vide : il est remis à la fin.
  const trailing = lines.length && lines[lines.length - 1] === '' ? lines.pop() : null;

  const pending = new Map(entries);
  const written = new Set();
  for (let i = 0; i < lines.length; i++) {
    const key = keyOf(lines[i]);
    if (key && pending.has(key)) {
      lines[i] = pending.get(key);
      written.add(key);
    }
  }
  for (const [key, line] of pending) {
    if (!written.has(key)) lines.push(line);
  }
  if (trailing !== null || lines.length) lines.push('');

  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, lines.join(eol), 'utf8');
  try {
    fs.renameSync(temp, file);
  } catch (err) {
    try {
      fs.unlinkSync(temp);
    } catch (e) {
      /* rien à nettoyer */
    }
    throw err;
  }
}

module.exports = { envPath, read, update, serialize };
