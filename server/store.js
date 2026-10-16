// Persistance sur disque (fichiers JSON dans VIGIE_DATA, ./data par défaut) :
//  - config.json  : sondes et canaux de notification (modifiés depuis l'interface)
//  - history.json : battements récents, agrégats horaires, journal d'événements, état courant
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = path.resolve(process.env.VIGIE_DATA || 'data');

const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');

fs.mkdirSync(DATA_DIR, { recursive: true });

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[store] lecture de ${file} impossible :`, err.message);
    return fallback;
  }
}

// Écriture atomique : fichier temporaire puis renommage, pour ne jamais laisser un JSON tronqué.
function writeJson(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

export function loadConfig() {
  const cfg = readJson(CONFIG_FILE, {});
  return { monitors: cfg.monitors ?? [], notifiers: cfg.notifiers ?? [] };
}

export function saveConfig(cfg) {
  const tmp = `${CONFIG_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, CONFIG_FILE);
}

export function loadHistory() {
  const h = readJson(HISTORY_FILE, {});
  return { beats: h.beats ?? {}, hourly: h.hourly ?? {}, events: h.events ?? [], state: h.state ?? {} };
}

export function saveHistory(h) {
  writeJson(HISTORY_FILE, h);
}
