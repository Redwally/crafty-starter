/**
 * ==============================================================================
 * Minecraft Auto-Start Proxy pour Crafty Controller v4 (Fabric / Vanilla / Forge)
 * ==============================================================================
 * 
 * Architecture du Proxy :
 * 1. Quand le serveur Fabric est 'running' :
 *    - Redirige tout le trafic du port 25565 vers 127.0.0.1:25566 en proxy TCP
 *      transparent bidirectionnel via net.Socket.pipe.
 * 
 * 2. Quand le serveur Fabric N'EST PAS 'running' :
 *    - Gestion du Ping / MOTD dans le menu Minecraft :
 *      Répond aux requêtes de statut pour afficher le MOTD personnalisé et 0/20 joueurs.
 *      MOTD : "§c[Hors Ligne] §fRejoins pour démarrer le serveur"
 *    - Gestion du clic / login :
 *      1. Envoie la requête POST à l'API Crafty pour démarrer le serveur.
 *      2. Renvoie immédiatement le message de déconnexion au joueur :
 *         "§a[AutoStart]\n§eOrdre de démarrage envoyé à Crafty !\n§fRéessaie dans 15 secondes le temps que Fabric charge."
 * ==============================================================================
 */

require('dotenv').config();
const net = require('net');
const https = require('https');
const axios = require('axios');
const mc = require('minecraft-protocol');

// --- Configuration des ports et adresses ---
const LISTEN_PORT = parseInt(process.env.LISTEN_PORT, 10) || 25565;
const TARGET_PORT = parseInt(process.env.TARGET_PORT, 10) || 25566;
const TARGET_HOST = process.env.TARGET_HOST || '127.0.0.1';

// Port local interne pour le répondeur factice minecraft-protocol
const DUMMY_PORT = parseInt(process.env.DUMMY_PORT, 10) || 25564;

// Configuration API Crafty Controller v4
const CRAFTY_URL = (process.env.CRAFTY_URL || 'https://host.docker.internal:8443').replace(/\/+$/, '');
const CRAFTY_TOKEN = process.env.CRAFTY_TOKEN || '';
const CRAFTY_SERVER_ID = process.env.CRAFTY_SERVER_ID || '';
const CRAFTY_ACTION = process.env.CRAFTY_ACTION || 'start_server';

// Messages Minecraft personnalisables
const OFFLINE_MOTD = process.env.OFFLINE_MOTD || '§c[Hors Ligne] §fRejoins pour démarrer le serveur';
const DISCONNECT_MESSAGE = (
  process.env.DISCONNECT_MESSAGE ||
  '§a[AutoStart]\n§eOrdre de démarrage envoyé à Crafty !\n§fRéessaie dans 15 secondes le temps que Fabric charge.'
).replace(/\\n/g, '\n');

// Anti-spam et temporisations
const START_COOLDOWN_SEC = parseInt(process.env.START_COOLDOWN_SEC, 10) || 30;
const CHECK_INTERVAL_MS = parseInt(process.env.CHECK_INTERVAL_MS, 10) || 2000;

// --- État interne ---
let isTargetOnline = false;
let isStarting = false;
let lastStartRequestTime = 0;

// --- Système de Journalisation Horodatée ---
function getTimestamp() {
  const now = new Date();
  return now.toISOString().replace('T', ' ').substring(0, 19);
}

function log(tag, message) {
  console.log(`[${getTimestamp()}] [${tag}] ${message}`);
}

function logError(tag, message, error) {
  const errMsg = error && error.message ? error.message : (error || '');
  console.error(`[${getTimestamp()}] [${tag}] ${message}${errMsg ? ' : ' + errMsg : ''}`);
}

// --- Client Axios configuré pour l'API Crafty ---
// Ignore les certificats SSL auto-signés très fréquents sur Crafty
const craftyClient = axios.create({
  timeout: 10000,
  httpsAgent: new https.Agent({
    rejectUnauthorized: false
  }),
  headers: {
    'Authorization': `Bearer ${CRAFTY_TOKEN}`,
    'Content-Type': 'application/json'
  }
});

/**
 * Vérifie l'état 'running' du serveur Fabric via l'API v2 de Crafty Controller.
 */
async function checkCraftyServerRunning() {
  if (!CRAFTY_TOKEN || !CRAFTY_SERVER_ID) return false;
  try {
    const response = await craftyClient.get(`${CRAFTY_URL}/api/v2/servers/${CRAFTY_SERVER_ID}/stats`);
    if (response.data && response.data.data) {
      return Boolean(response.data.data.running);
    }
  } catch (err) {
    // Erreur réseau ou token invalide
  }
  return false;
}

/**
 * Envoie l'ordre de démarrage à Crafty Controller v4 avec gestion anti-spam.
 */
async function triggerCraftyStart(playerName) {
  const now = Date.now();
  const elapsedSec = Math.floor((now - lastStartRequestTime) / 1000);

  if (isStarting || elapsedSec < START_COOLDOWN_SEC) {
    const remaining = START_COOLDOWN_SEC - elapsedSec;
    log('ANTI-SPAM', `Requête ignorée pour [${playerName}]. Démarrage en cours ou cooldown actif (${remaining > 0 ? remaining : 0}s restantes).`);
    return;
  }

  if (!CRAFTY_TOKEN || !CRAFTY_SERVER_ID) {
    log('WARN', `Impossible de démarrer le serveur : CRAFTY_TOKEN ou CRAFTY_SERVER_ID manquant.`);
    return;
  }

  isStarting = true;
  lastStartRequestTime = now;

  log('CRAFTY', `Joueur [${playerName}] a cliqué pour se connecter. Envoi de l'ordre de démarrage à Crafty...`);

  const primaryUrl = `${CRAFTY_URL}/api/v2/servers/${CRAFTY_SERVER_ID}/action/${CRAFTY_ACTION}`;

  try {
    const res = await craftyClient.post(primaryUrl, {});
    log('CRAFTY', `Ordre de démarrage accepté par Crafty (Statut: ${res.status}). En attente de Fabric sur ${TARGET_PORT}...`);
  } catch (err) {
    const fallbackAction = CRAFTY_ACTION === 'start_server' ? 'start' : 'start_server';
    const fallbackUrl = `${CRAFTY_URL}/api/v2/servers/${CRAFTY_SERVER_ID}/action/${fallbackAction}`;
    log('WARN', `Échec sur ${CRAFTY_ACTION} (${err.message}), tentative avec l'action '${fallbackAction}'...`);

    try {
      const fallbackRes = await craftyClient.post(fallbackUrl, {});
      log('CRAFTY', `Ordre de démarrage accepté via fallback '${fallbackAction}' (Statut: ${fallbackRes.status}).`);
    } catch (fallbackErr) {
      logError('CRAFTY', `Échec de l'appel API Crafty`, fallbackErr);
      setTimeout(() => {
        isStarting = false;
      }, 5000);
    }
  }
}

/**
 * Sonde rapidement le port cible pour savoir si le serveur Fabric écoute et accepte les connexions.
 */
function probeTargetPort() {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(800);

    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });

    socket.connect(TARGET_PORT, TARGET_HOST);
  });
}

/**
 * Actualise l'état du serveur en croisant le port TCP et l'API Crafty.
 */
async function updateServerStatus() {
  const isPortOpen = await probeTargetPort();
  const isCraftyRunning = await checkCraftyServerRunning();

  const isOnline = isPortOpen;

  if (isOnline && !isTargetOnline) {
    isTargetOnline = true;
    isStarting = false;
    log('PROXY', `>>> Le serveur Fabric cible (${TARGET_HOST}:${TARGET_PORT}) est EN LIGNE (Crafty running: ${isCraftyRunning}) ! Redirection TCP transparente active.`);
  } else if (!isOnline && isTargetOnline) {
    isTargetOnline = false;
    log('PROXY', `<<< Le serveur Fabric cible (${TARGET_HOST}:${TARGET_PORT}) est HORS LIGNE. Répondeur de statut réactivé.`);
  }
}

// Surveillance périodique
setInterval(updateServerStatus, CHECK_INTERVAL_MS);

/**
 * -----------------------------------------------------------------------------
 * 2. SERVEUR FACTICE MINECRAFT (minecraft-protocol)
 * Utilisé quand le serveur Fabric N'EST PAS 'running'.
 * -----------------------------------------------------------------------------
 */
const dummyServer = mc.createServer({
  host: '127.0.0.1',
  port: DUMMY_PORT,
  'online-mode': false,
  version: false, // Détection automatique de la version de protocole du client
  maxPlayers: 20,
  motd: OFFLINE_MOTD,
  hideErrors: true,
  beforePing: (response, client) => {
    // 2.A Gestion du Ping / MOTD dans le menu :
    // Renvoyer une description personnalisée au lieu de casser la connexion
    response.version = {
      name: isStarting ? '§6Démarrage en cours...' : '§cFabric Hors Ligne',
      protocol: client.protocolVersion || 765
    };
    response.players = {
      max: 20,
      online: 0,
      sample: []
    };
    response.description = {
      text: isStarting
        ? '§6[Démarrage...] §eFabric charge, réessaie dans quelques secondes !'
        : OFFLINE_MOTD
    };
    return response;
  }
});

dummyServer.on('connection', (client) => {
  client.on('error', () => {});

  // 2.B Gestion du clic / login :
  client.removeAllListeners('login_start');
  client.once('login_start', (packet) => {
    const username = packet.username || 'Inconnu';
    const playerIp = client.socket && client.socket.remoteAddress ? client.socket.remoteAddress : 'inconnue';
    log('AUTH', `Tentative de connexion / clic du joueur [${username}] (IP: ${playerIp})`);

    // 1. Envoie la requête POST à l'API Crafty pour lancer le serveur
    triggerCraftyStart(username);

    // 2. Renvoie immédiatement le message de déconnexion au joueur
    try {
      client.write('disconnect', {
        reason: JSON.stringify({ text: DISCONNECT_MESSAGE })
      });
      setTimeout(() => {
        try {
          client._end(DISCONNECT_MESSAGE);
        } catch (_) {}
      }, 100);
    } catch (err) {
      logError('AUTH', `Erreur envoi déconnexion à ${username}`, err);
    }
  });
});

dummyServer.on('listening', () => {
  log('INIT', `Répondeur de statut Minecraft initialisé sur 127.0.0.1:${DUMMY_PORT}`);
});

dummyServer.on('error', (err) => {
  logError('INIT', `Erreur répondeur statut Minecraft`, err);
});

/**
 * -----------------------------------------------------------------------------
 * 1. PROXY TCP PRINCIPAL (Port public LISTEN_PORT, ex: 25565)
 * -----------------------------------------------------------------------------
 */
const mainProxyServer = net.createServer((clientSocket) => {
  clientSocket.on('error', () => {});

  if (isTargetOnline) {
    // 1. Quand le serveur Fabric est 'running' :
    // Redirige tout le trafic du port 25565 vers TARGET_HOST:TARGET_PORT
    // en proxy TCP transparent bidirectionnel via net.Socket.pipe
    const targetSocket = net.connect({ host: TARGET_HOST, port: TARGET_PORT });

    clientSocket.pipe(targetSocket);
    targetSocket.pipe(clientSocket);

    targetSocket.on('error', () => {
      clientSocket.destroy();
    });
    clientSocket.on('close', () => targetSocket.destroy());
    targetSocket.on('close', () => clientSocket.destroy());
  } else {
    // 2. Quand le serveur Fabric N'EST PAS 'running' :
    // Redirige le flux vers le répondeur interne minecraft-protocol
    const dummySocket = net.connect({ host: '127.0.0.1', port: DUMMY_PORT });

    clientSocket.pipe(dummySocket);
    dummySocket.pipe(clientSocket);

    dummySocket.on('error', () => {
      clientSocket.destroy();
    });
    clientSocket.on('close', () => dummySocket.destroy());
    dummySocket.on('close', () => clientSocket.destroy());
  }
});

mainProxyServer.listen(LISTEN_PORT, '0.0.0.0', () => {
  log('INIT', `=======================================================`);
  log('INIT', ` Proxy Auto-Start Minecraft démarré`);
  log('INIT', ` - Port d'écoute public : ${LISTEN_PORT}`);
  log('INIT', ` - Serveur cible        : ${TARGET_HOST}:${TARGET_PORT}`);
  log('INIT', ` - Crafty Controller    : ${CRAFTY_URL}`);
  log('INIT', ` - UUID Serveur Crafty  : ${CRAFTY_SERVER_ID || '(non défini)'}`);
  log('INIT', `=======================================================`);

  // Vérification initiale
  updateServerStatus();
});

mainProxyServer.on('error', (err) => {
  logError('FATAL', `Erreur sur le port d'écoute ${LISTEN_PORT}`, err);
  process.exit(1);
});

// --- Arrêt Propre (Graceful Shutdown) ---
function handleShutdown(signal) {
  log('SHUTDOWN', `Signal ${signal} reçu. Arrêt des services...`);
  mainProxyServer.close(() => {
    dummyServer.close();
    log('SHUTDOWN', `Proxy arrêté.`);
    process.exit(0);
  });
}

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));
