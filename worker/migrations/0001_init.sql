-- Vigie sur Cloudflare D1
CREATE TABLE monitors (id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE notifiers (id TEXT PRIMARY KEY, data TEXT NOT NULL);
-- état courant d'une sonde (statut, depuis quand, dernière alerte…) : écrit seulement quand il change
CREATE TABLE state (monitor_id TEXT PRIMARY KEY, data TEXT NOT NULL);
-- une ligne par sonde et par heure : compteurs + battements bruts (JSON, vidé après ~26 h)
-- => une seule écriture par vérification (quota gratuit : 100 000 lignes écrites / jour)
CREATE TABLE hours (
  monitor_id TEXT NOT NULL,
  hour INTEGER NOT NULL,
  up INTEGER NOT NULL,
  total INTEGER NOT NULL,
  sum_ms REAL NOT NULL,
  n_ms INTEGER NOT NULL,
  beats TEXT,
  PRIMARY KEY (monitor_id, hour)
);
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  t INTEGER NOT NULL,
  monitor_id TEXT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  msg TEXT NOT NULL
);
CREATE INDEX events_monitor ON events (monitor_id, id);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
