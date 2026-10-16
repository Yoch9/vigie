# Vigie

Surveillance de disponibilité façon Uptime Kuma : Vigie vérifie à intervalle régulier des sites web,
routeurs, ports et enregistrements DNS, et envoie une alerte quand un élément tombe puis quand il revient.

Deux façons de l'exécuter, avec la même interface :

- **Cloudflare Workers** (offre gratuite, recommandé pour surveiller *de l'extérieur*) : `worker/` + base D1 ;
- **serveur Node** (VPS, machine locale) : `server/`, toutes les fonctions (ping, certificats, SMTP).

`shared/` contient ce qui est commun (validation des saisies, envoi des alertes) et `src/` l'interface React.

## Sondes

| Type | Vérifie | DOWN si |
|---|---|---|
| HTTP(S) | une URL | erreur réseau/TLS, délai dépassé, code HTTP hors de la plage acceptée (`200-399` par défaut) |
| HTTP(S) + mot-clé | une URL | idem, ou mot-clé absent (ou présent, en mode inverse) |
| Port TCP | `hôte:port` (SSH, RDP, SIP, HTTPS…) | connexion refusée ou délai dépassé |
| Ping *(Node uniquement)* | un routeur, un serveur | pas de réponse ICMP (commande `ping` du système) |
| DNS | un nom (A, AAAA, MX, TXT…) | pas de réponse ou valeur attendue absente |
| Push | rien : c'est l'équipement/le script qui appelle `GET /api/push/<jeton>` | aucun appel pendant l'intervalle, ou `?status=down` |

Version Node : pour les sondes HTTPS, Vigie surveille aussi la date d'expiration du certificat (alerte N jours avant, 14 par défaut).

**Anti-fausses alertes** : une sonde n'est déclarée DOWN qu'après *N essais* en échec (2 par défaut),
refaits à un intervalle plus court. En attendant elle est « Instable » (orange), sans alerte.

## Alertes

E-mail (SMTP), Microsoft Teams (webhook de workflow), Slack, Discord, Telegram, ntfy (notification
push sur mobile) ou webhook JSON générique. Chaque canal a un bouton « Envoyer un test ». On reçoit :
le passage DOWN, le retour UP (avec la durée de l'incident), éventuellement une relance périodique
tant que c'est DOWN, et l'alerte d'expiration de certificat. Les échecs d'envoi apparaissent dans le journal.

## Cloudflare Workers (gratuit)

Une exécution planifiée par minute vérifie les sondes dont l'intervalle tombe ; l'état et l'historique
sont dans une base D1. L'interface est servie par le même Worker, protégée par mot de passe.

**Premier déploiement**

```bash
npx wrangler login                      # connexion au compte Cloudflare (navigateur)
npx wrangler d1 create vigie            # puis recopier le database_id affiché dans wrangler.toml
npx wrangler secret put VIGIE_USER      # identifiant de l'interface
npx wrangler secret put VIGIE_PASSWORD  # mot de passe de l'interface
npm run cf:deploy                       # build + migrations D1 + déploiement
```

L'URL est `https://vigie.<votre-sous-domaine>.workers.dev`. Ensuite, `npm run cf:deploy` suffit.

**En local** : `npm run build` puis `npm run cf:dev` (http://localhost:8787, identifiants de `.dev.vars`,
déclencher une exécution planifiée : http://localhost:8787/__scheduled). Base locale :
`npx wrangler d1 migrations apply vigie --local`.

**Différences avec la version Node**

- pas de **ping** (ICMP impossible dans un Worker) : pour un routeur, surveiller un port TCP ouvert (443, 22…) ;
- pas d'alerte d'**expiration de certificat** (un certificat expiré ou invalide fait quand même passer la sonde DOWN),
  pas d'option « ignorer les erreurs TLS » ;
- intervalle par **pas de 1 minute** ; les nouveaux essais avant DOWN sont faits dans la même minute (≤ 30 s d'écart) ;
- **e-mail** via l'API Brevo (300 e-mails/jour gratuits, expéditeur à valider) ou Resend, pas de SMTP ;
- l'interface se rafraîchit toute seule (toutes les 15 s, onglet visible) au lieu du temps réel ;
- le Worker ne peut pas joindre les adresses IP de Cloudflare elles-mêmes en TCP, ni le port 25.

**Quotas gratuits** (largement suffisants pour quelques dizaines de sondes) : 40 vérifications au plus par
minute ; ~100 000 écritures D1/jour, soit environ 60 sondes à 1 minute (une écriture par vérification).
Sondes moins fréquentes (5 min) = beaucoup plus de marge.

## Serveur Node

### Développement

```bash
npm install
npm run dev:server   # API sur http://localhost:3001 (redémarre à chaque modification)
npm run dev:web      # interface sur http://localhost:5174 (proxy /api vers le port 3001)
```

Données dans `./data` (`config.json` : sondes et canaux ; `history.json` : historique). Pour repartir de zéro,
arrêter le serveur et supprimer ce dossier.

### Production

```bash
npm ci && npm run build   # compile l'interface dans dist/
npm start                 # sert l'interface et l'API sur PORT (3001)
```

Variables : `PORT`, `HOST`, `VIGIE_DATA`, `TZ` (fuseau des messages d'alerte), et surtout
`VIGIE_USER` / `VIGIE_PASSWORD` qui activent l'authentification HTTP Basic sur l'interface et l'API.
Seules `/api/health` et les URL de push restent publiques. Mettez un reverse proxy HTTPS devant
(Apache/nginx) : l'auth Basic ne doit pas circuler en clair.

Service systemd fourni : `deploy/vigie.service` (utilisateur `vigie`, code dans `/opt/vigie`).

**Où l'installer ?** Pour surveiller « de l'extérieur », Vigie doit tourner hors du réseau surveillé
(un petit VPS par exemple) : s'il est sur le même LAN, une coupure de la box/du lien internet
le coupera lui aussi et aucune alerte ne partira.

Historique conservé : chaque vérification pendant ~26 h, agrégats horaires pendant 90 jours.
