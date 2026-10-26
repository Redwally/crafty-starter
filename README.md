# 🚀 Minecraft Auto-Start Proxy (Crafty Controller v4)

Proxy Node.js léger, robuste et performant permettant de **démarrer automatiquement un serveur Minecraft géré par Crafty Controller v4** dès qu'un joueur tente de s'y connecter, tout en fournissant une redirection TCP transparente une fois le serveur en ligne.

Conçu spécialement pour être déployé en quelques secondes avec **Docker** ou **Dokploy**.

---

## 🎯 Fonctionnement

```
[ Joueur Minecraft ]
         │
         ▼ (Port public : 25565)
[ Proxy Auto-Start Node.js ]
         │
         ├─── Si le serveur cible (25566) est ÉTEINT :
         │      ├─ 1. Répond au Server List Ping (MOTD personnalisé "Serveur éteint")
         │      ├─ 2. Intercepte la connexion du joueur
         │      ├─ 3. Envoie un appel POST à l'API v2 de Crafty Controller pour démarrer le serveur
         │      └─ 4. Déconnecte le joueur avec un message en jeu clair (§a/§e/§f)
         │
         └─── Dès que le serveur cible (25566) est PRÊT :
                └─ Transmet 100% du flux TCP directement au serveur Minecraft réel
                   (Compatible toutes versions 1.8+, BungeeCord, Velocity, Geyser, mods, auth Mojang)
```

### Avantages de cette architecture :
* **Proxy TCP transparent (Layer 4)** : Aucune altération des paquets de jeu lorsque le serveur est allumé. Aucun problème de chiffrement RSA/AES Mojang ni d'incompatibilité de version.
* **Anti-spam intégré** : Un cooldown configurable empêche de bombarder l'API Crafty si plusieurs joueurs se connectent en même temps.
* **SSL auto-signé supporté** : Axios ignore les erreurs de certificat SSL par défaut de Crafty (`rejectUnauthorized: false`).
* **Formatage Minecraft natif** : Prise en charge complète des codes couleurs `§` et des retours à la ligne `\n`.

---

## 📁 Structure du Projet

```text
crafty-mc-starter/
├── .env.example         # Modèle des variables d'environnement
├── .gitignore           # Fichiers exclus du versioning Git
├── .dockerignore        # Fichiers exclus de l'image Docker
├── Dockerfile           # Image Docker optimisée sous node:20-alpine
├── docker-compose.yml   # Déploiement Docker / Dokploy
├── package.json         # Dépendances (minecraft-protocol, axios, dotenv)
├── index.js             # Code source principal
└── README.md            # Documentation complète
```

---

## ⚙️ Configuration préalable dans Crafty Controller v4

1. **Changer le port de votre serveur Minecraft :**
   - Dans le panneau Crafty Controller, allez dans les fichiers de configuration de votre serveur Minecraft (`server.properties`).
   - Changez `server-port=25565` en `server-port=25566` (ou tout autre port de votre choix).
   - *Pourquoi ?* Le proxy va écouter sur le port standard `25565`, et redirigera le flux vers `25566`.

2. **Créer un jeton d'API (Token) :**
   - Dans Crafty Controller, rendez-vous dans la section des utilisateurs ou paramètres de clés API.
   - Générez un token API et copiez-le.

3. **Récupérer l'UUID du serveur :**
   - Cliquez sur votre serveur dans Crafty Controller.
   - L'UUID se trouve dans l'URL de votre navigateur :  
     `https://crafty.example.com/panel/server_detail?id=VOTRE-UUID-SERVEUR`

---

## 🔧 Variables d'Environnement (`.env`)

Créez un fichier `.env` basé sur [`.env.example`](file:///.env.example) :

```bash
cp .env.example .env
```

| Variable | Valeur par défaut | Description |
| :--- | :--- | :--- |
| `LISTEN_PORT` | `25565` | Port public sur lequel les joueurs se connectent |
| `TARGET_PORT` | `25566` | Port interne du vrai serveur Minecraft dans Crafty |
| `TARGET_HOST` | `127.0.0.1` | Hôte du serveur Minecraft (`127.0.0.1` ou `host.docker.internal`) |
| `CRAFTY_URL` | `https://localhost:8443` | URL de l'API de votre instance Crafty Controller |
| `CRAFTY_TOKEN` | `votre_token_api` | Jeton d'API Bearer de Crafty Controller |
| `CRAFTY_SERVER_ID` | `votre_uuid_serveur` | UUID du serveur cible dans Crafty |
| `CRAFTY_ACTION` | `start_server` | Action API Crafty (`start_server` ou `start`) |
| `DISCONNECT_MESSAGE` | *Voir .env.example* | Message affiché au joueur lors du démarrage |
| `STARTING_MESSAGE` | *Voir .env.example* | Message si un joueur réessaie pendant le boot |
| `START_COOLDOWN_SEC` | `30` | Cooldown anti-spam entre deux requêtes API |
| `CHECK_INTERVAL_MS` | `2000` | Intervalle de détection du port Minecraft (ms) |
| `ONLINE_MODE` | `false` | Mode en ligne du serveur factice (laisser `false`) |

---

## 🚀 Déploiement

### Option A : Déploiement avec Dokploy

1. Créez un nouveau service **Application** ou **Compose** dans Dokploy.
2. Liez votre dépôt Git ou importez ce dossier.
3. Renseignez vos variables d'environnement dans l'onglet **Environment** de Dokploy.
4. **Astuce Réseau sous Dokploy / Docker :**
   - Si Crafty et Minecraft tournent sur le même serveur VPS hôte :
     - Soit activez `network_mode: host` dans [docker-compose.yml](file:///docker-compose.yml) et utilisez `TARGET_HOST=127.0.0.1`.
     - Soit utilisez `TARGET_HOST=host.docker.internal` avec le port mapping `25565:25565`.
5. Cliquez sur **Deploy**.

---

### Option B : Déploiement avec Docker Compose (CLI)

```bash
# 1. Cloner ou copier les fichiers
# 2. Configurer le .env
nano .env

# 3. Démarrer le conteneur en arrière-plan
docker compose up -d --build

# 4. Consulter les logs en temps réel
docker compose logs -f
```

---

### Option C : Lancement local (sans Docker)

```bash
# Installer les dépendances
npm install

# Démarrer le proxy
npm start
```

---

## 🎨 Personnalisation des Messages et Couleurs

Vous pouvez personnaliser les messages dans `.env` en utilisant le caractère de section `§` :
* `§a` : Vert clair
* `§e` : Jaune
* `§6` : Or / Orange
* `§c` : Rouge clair
* `§f` : Blanc
* `§7` : Gris clair
* `§l` : **Gras**
* `\n` : Saut de ligne

Exemple :
```ini
DISCONNECT_MESSAGE=§a[MonServeur]\n§eLe serveur démarre !\n§fRendez-vous dans 15 secondes.
```

---

## 📜 Exemple de Logs de Console

```text
[2026-10-26 18:40:00] [INIT] Répondeur interne Minecraft initialisé sur 127.0.0.1:25564
[2026-10-26 18:40:00] [INIT] =======================================================
[2026-10-26 18:40:00] [INIT]  Proxy Auto-Start Minecraft démarré
[2026-10-26 18:40:00] [INIT]  - Port d'écoute public : 25565
[2026-10-26 18:40:00] [INIT]  - Serveur cible        : 127.0.0.1:25566
[2026-10-26 18:40:00] [INIT]  - Crafty Controller    : https://crafty.mondomaine.com
[2026-10-26 18:40:00] [INIT]  - UUID Serveur Crafty  : 3b9c8b74-1e0e-43f1-bfa6-84852f8217bb
[2026-10-26 18:40:00] [INIT] =======================================================
[2026-10-26 18:42:15] [AUTH] Tentative de connexion détectée du joueur [Notch] (IP: 192.168.1.50)
[2026-10-26 18:42:15] [CRAFTY] Joueur [Notch] a déclenché le démarrage. Envoi de l'ordre à Crafty Controller...
[2026-10-26 18:42:16] [CRAFTY] Ordre de démarrage accepté par Crafty (Statut: 200). En attente de l'ouverture du port 25566...
[2026-10-26 18:42:32] [PROXY] >>> Le serveur Minecraft cible (127.0.0.1:25566) est EN LIGNE ! Redirection TCP transparente active.
```
