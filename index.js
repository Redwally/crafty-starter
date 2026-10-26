/**
 * ==============================================================================
 * Minecraft Auto-Start Proxy pour Crafty Controller v4
 * ==============================================================================
 * 
 * Ce script agit comme un proxy transparent et un répondeur Minecraft intelligent :
 * 1. Tant que le serveur Minecraft cible est éteint :
 *    - Il répond aux requêtes de statut (MOTD) avec un message personnalisé.
 *    - Dès qu'un joueur tente de se connecter, il appelle l'API v2 de Crafty Controller
 *      pour allumer le serveur, puis déconnecte le joueur avec un message explicatif.
 * 2. Dès que le serveur Minecraft cible est allumé et prêt sur son port interne :
 *    - Toutes les connexions TCP (Statut, Login, Paquets de jeu) sont transmises
 *      de manière 100% transparente (supporte l'auth Mojang, Geyser, mods, versions multiples).
 * ==============================================================================
 */

require('dotenv').config();
const net = require('net');
const https = require('https');
const axios = require('axios');
const mc = require('minecraft-protocol');

// --- Configuration depuis les variables d'environnement ---
const LISTEN_PORT = parseInt(process.env.LISTEN_PORT, 10) || 25565;
const TARGET_PORT = parseInt(process.env.TARGET_PORT, 10) || 25566;
const TARGET_HOST = process.env.TARGET_HOST || '127.0.0.1';

const CRAFTY_URL = (process.env.CRAFTY_URL || 'https://localhost:8443').replace(/\/+$/, '');
const CRAFTY_TOKEN = process.env.CRAFTY_TOKEN || '';
const CRAFTY_SERVER_ID = process.env.CRAFTY_SERVER_ID || '';
const CRAFTY_ACTION = process.env.CRAFTY_ACTION || 'start_server';

// Port local interne pour le serveur factice minecraft-protocol (évite d'exposer ce port)
const DUMMY_PORT = parseInt(process.env.DUMMY_PORT, 10) || 25564;

// Messages Minecraft (support des sauts de ligne \n et codes de couleur §)
const DISCONNECT_MESSAGE = (
  process.env.DISCONNECT_MESSAGE ||
  '§a[AutoStart]\n§eLe serveur était éteint, démarrage en cours...\n§fPatientez environ 15 secondes avant de réessayer.'
).replace(/\\n/g, '\n');

const STARTING_MESSAGE = (
  process.env.STARTING_MESSAGE ||
  '§6[AutoStart]\n§eLe serveur est déjà en cours de démarrage...\n§fEncore un peu de patience, réessayez dans quelques secondes !'
).replace(/\\n/g, '\n');

// Anti-spam et vérification d'état
const START_COOLDOWN_SEC = parseInt(process.env.START_COOLDOWN_SEC, 10) || 30;
const CHECK_INTERVAL_MS = parseInt(process.env.CHECK_INTERVAL_MS, 10) || 2000;
const ONLINE_MODE = process.env.ONLINE_MODE === 'true';

// --- État de fonctionnement ---
let isTargetOnline = false;
let isStarting = false;
let lastStartRequestTime = 0;

// --- Système de Journalisation avec Horodatage ---
function getTimestamp() {
  const now = new Date();
  return now.toISOString().replace('T', ' ').substring(0, 19);
}

function log(tag, message) {
  console.log(`[${getTimestamp()}] [${tag}] ${message}`);
}

function logError(tag, message, error) {
  const errMsg = error && error.message ? error.message : error;
  console.error(`[${getTimestamp()}] [${tag}] ${message}${errMsg ? ' : ' + errMsg : ''}`);
}

// --- Client Axios configuré pour l'API Crafty ---
// Ignore les certificats SSL auto-signés très courants sur Crafty Controller
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
 * Déclenche le démarrage du serveur Minecraft via l'API v2 de Crafty Controller.
 * Implémente un anti-spam pour éviter les appels multiples simultanés.
 */
async function triggerCraftyStart(playerName) {
  const now = Date.now();
  const elapsedSec = Math.floor((now - lastStartRequestTime) / 1000);

  // Anti-spam : évite de spammer l'API Crafty si un démarrage a déjà été demandé
  if (isStarting || elapsedSec < START_COOLDOWN_SEC) {
    const remaining = START_COOLDOWN_SEC - elapsedSec;
    log('ANTI-SPAM', `Requête ignorée pour ${playerName}. Démarrage déjà en cours ou cooldown actif (${remaining > 0 ? remaining : 0}s restantes).`);
    return;
  }

  if (!CRAFTY_TOKEN || !CRAFTY_SERVER_ID) {
    log('WARN', `Impossible de démarrer le serveur : CRAFTY_TOKEN ou CRAFTY_SERVER_ID manquant dans la configuration.`);
    return;
  }

  isStarting = true;
  lastStartRequestTime = now;

  log('CRAFTY', `Joueur [${playerName}] a déclenché le démarrage. Envoi de l'ordre à Crafty Controller...`);

  // Construction de l'URL d'action v2
  const urlPrimary = `${CRAFTY_URL}/api/v2/servers/${CRAFTY_SERVER_ID}/action/${CRAFTY_ACTION}`;

  try {
    const response = await craftyClient.post(urlPrimary, {});
    log('CRAFTY', `Ordre de démarrage accepté par Crafty (Statut: ${response.status}). En attente de l'ouverture du port ${TARGET_PORT}...`);
  } catch (err) {
    // Si l'action par défaut a renvoyé 404, tenter le fallback sur "start" ou "server_start"
    const fallbackAction = CRAFTY_ACTION === 'start_server' ? 'start' : 'start_server';
    const urlFallback = `${CRAFTY_URL}/api/v2/servers/${CRAFTY_SERVER_ID}/action/${fallbackAction}`;

    log('WARN', `Échec sur ${CRAFTY_ACTION} (${err.message}), tentative de fallback avec l'action '${fallbackAction}'...`);

    try {
      const fallbackResponse = await craftyClient.post(urlFallback, {});
      log('CRAFTY', `Ordre de démarrage accepté via le fallback '${fallbackAction}' (Statut: ${fallbackResponse.status}).`);
    } catch (fallbackErr) {
      logError('CRAFTY', `Échec total de l'appel API Crafty`, fallbackErr);
      // Réinitialise le flag après un court délai pour permettre un nouvel essai en cas d'erreur
      setTimeout(() => {
        isStarting = false;
      }, 5000);
    }
  }
}

/**
 * Sonde rapidement le port du serveur Minecraft cible pour savoir s'il est prêt.
 */
function probeTargetServer() {
  const socket = new net.Socket();
  socket.setTimeout(1000);

  socket.once('connect', () => {
    socket.destroy();
    if (!isTargetOnline) {
      isTargetOnline = true;
      isStarting = false;
      log('PROXY', `>>> Le serveur Minecraft cible (${TARGET_HOST}:${TARGET_PORT}) est EN LIGNE ! Redirection TCP transparente active.`);
    }
  });

  socket.once('timeout', () => {
    socket.destroy();
    handleTargetOffline();
  });

  socket.once('error', () => {
    socket.destroy();
    handleTargetOffline();
  });

  socket.connect(TARGET_PORT, TARGET_HOST);
}

function handleTargetOffline() {
  if (isTargetOnline) {
    isTargetOnline = false;
    log('PROXY', `<<< Le serveur Minecraft cible (${TARGET_HOST}:${TARGET_PORT}) est HORS LIGNE. Répondeur auto-start réactivé.`);
  }
}

// Vérification cyclique de l'état du serveur cible
setInterval(probeTargetServer, CHECK_INTERVAL_MS);

/**
 * Création du serveur factice Minecraft (minecraft-protocol)
 * Il écoute sur le port local DUMMY_PORT et prend le relais quand le serveur cible est éteint.
 */
const dummyServer = mc.createServer({
  host: '127.0.0.1',
  port: DUMMY_PORT,
  'online-mode': ONLINE_MODE,
  version: false, // S'adapte automatiquement à la version de protocole du client
  maxPlayers: 100,
  hideErrors: true,
  beforePing: (response, client) => {
    // Personnalisation dynamique du ping (Server List Ping) selon l'état actuel
    const protocolVer = client.protocolVersion || 765;

    response.version = {
      name: isStarting ? '§6Démarrage en cours...' : '§cServeur Éteint',
      protocol: protocolVer
    };

    response.description = {
      text: isStarting
        ? '§6● Minecraft [Démarrage en cours] §8| §eCrafty Auto-Start\n§7Le serveur démarre, réessayez dans quelques secondes !'
        : '§c● Minecraft [Serveur Éteint] §8| §eCrafty Auto-Start\n§aConnectez-vous pour allumer le serveur automatiquement !'
    };

    response.players = {
      max: 100,
      online: 0,
      sample: [
        {
          name: isStarting ? '§6Statut : Démarrage en cours...' : '§aAction : Connexion = Démarrage',
          id: '00000000-0000-0000-0000-000000000000'
        }
      ]
    };

    return response;
  }
});

// Gestion des connexions au serveur factice
dummyServer.on('connection', (client) => {
  // Ignore les erreurs de socket (ex: joueur qui annule le ping ou ferme la fenêtre)
  client.on('error', () => {});

  // Intercepte login_start avant que minecraft-protocol n'envoie login_success
  // Cela garantit l'affichage propre du message de déconnexion sur toutes les versions (1.8 à 1.21+)
  client.removeAllListeners('login_start');
  client.once('login_start', (packet) => {
    const username = packet.username || 'Inconnu';
    const playerIp = client.socket && client.socket.remoteAddress ? client.socket.remoteAddress : 'inconnue';
    log('AUTH', `Tentative de connexion détectée du joueur [${username}] (IP: ${playerIp})`);

    // Déclencher le démarrage sur Crafty Controller
    triggerCraftyStart(username);

    // Déconnecter immédiatement et proprement le joueur avec le message formaté Minecraft
    const messageToSend = isStarting ? STARTING_MESSAGE : DISCONNECT_MESSAGE;
    try {
      const reason = JSON.stringify({ text: messageToSend });
      client.write('disconnect', { reason });
      // Laisse un bref instant pour l'envoi du paquet TCP avant de clore la session
      setTimeout(() => {
        try {
          client._end(messageToSend);
        } catch (_) {}
      }, 100);
    } catch (err) {
      logError('AUTH', `Erreur lors de la déconnexion de ${username}`, err);
    }
  });
});

dummyServer.on('listening', () => {
  log('INIT', `Répondeur interne Minecraft initialisé sur 127.0.0.1:${DUMMY_PORT}`);
});

dummyServer.on('error', (err) => {
  logError('INIT', `Erreur sur le répondeur interne Minecraft`, err);
});

/**
 * Proxy TCP Principal (Port public LISTEN_PORT)
 * Redirige les flux :
 * - Vers le vrai serveur Minecraft (TARGET_HOST:TARGET_PORT) s'il est en ligne.
 * - Vers le répondeur interne (127.0.0.1:DUMMY_PORT) s'il est éteint.
 */
function pipeSockets(source, destination, initialBuffer = []) {
  for (const chunk of initialBuffer) {
    destination.write(chunk);
  }
  source.pipe(destination);
  destination.pipe(source);

  source.on('error', () => destination.destroy());
  destination.on('error', () => source.destroy());
  source.on('close', () => destination.destroy());
  destination.on('close', () => source.destroy());
}

function forwardToDummy(clientSocket, initialBuffer) {
  const dummySocket = net.connect({ host: '127.0.0.1', port: DUMMY_PORT }, () => {
    pipeSockets(clientSocket, dummySocket, initialBuffer);
  });

  dummySocket.on('error', (err) => {
    logError('PROXY', `Échec de connexion au répondeur interne`, err);
    clientSocket.destroy();
  });
}

const mainProxyServer = net.createServer((clientSocket) => {
  const buffer = [];
  let isTargetConnected = false;

  const onData = (chunk) => {
    if (!isTargetConnected) {
      buffer.push(chunk);
    }
  };

  clientSocket.on('data', onData);
  clientSocket.on('error', () => {});

  if (isTargetOnline) {
    // Le serveur cible est marqué comme en ligne : tentative de connexion directe
    const targetSocket = net.connect({ host: TARGET_HOST, port: TARGET_PORT }, () => {
      isTargetConnected = true;
      clientSocket.removeListener('data', onData);
      pipeSockets(clientSocket, targetSocket, buffer);
    });

    targetSocket.on('error', (err) => {
      // Si la cible refuse la connexion (ex: arrêt soudain), repli immédiat sur le répondeur factice
      if (!isTargetConnected) {
        clientSocket.removeListener('data', onData);
        isTargetOnline = false;
        forwardToDummy(clientSocket, buffer);
      } else {
        clientSocket.destroy();
      }
    });
  } else {
    // Serveur cible éteint : redirection immédiate vers le répondeur interne
    clientSocket.removeListener('data', onData);
    forwardToDummy(clientSocket, buffer);
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

  // Sonde initiale immédiate
  probeTargetServer();
});

mainProxyServer.on('error', (err) => {
  logError('FATAL', `Erreur sur le port d'écoute ${LISTEN_PORT}`, err);
  process.exit(1);
});

// --- Gestion de l'arrêt propre (Graceful Shutdown) ---
function handleShutdown(signal) {
  log('SHUTDOWN', `Signal ${signal} reçu. Fermeture des serveurs...`);
  mainProxyServer.close(() => {
    dummyServer.close();
    log('SHUTDOWN', `Proxy arrêté proprement.`);
    process.exit(0);
  });
}

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));
