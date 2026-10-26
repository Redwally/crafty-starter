/**
 * ==============================================================================
 * Minecraft Auto-Start Proxy pour Crafty Controller v4 (Fabric / Vanilla / Forge)
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
const RAW_TOKEN = (process.env.CRAFTY_TOKEN || '').replace(/^Bearer\s+/i, '').trim();
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

// --- Construction des en-têtes universels pour Crafty v4 ---
function getCraftyHeaders() {
  return {
    'Authorization': `Bearer ${RAW_TOKEN}`,
    'token': RAW_TOKEN,
    'Content-Type': 'application/json'
  };
}

// --- Client Axios configuré pour l'API Crafty ---
const craftyClient = axios.create({
  timeout: 10000,
  httpsAgent: new https.Agent({
    rejectUnauthorized: false
  })
});

/**
 * Vérifie l'état 'running' du serveur Fabric via l'API v2 de Crafty Controller.
 */
async function checkCraftyServerRunning() {
  if (!RAW_TOKEN || !CRAFTY_SERVER_ID) return false;
  try {
    const response = await craftyClient.get(
      `${CRAFTY_URL}/api/v2/servers/${CRAFTY_SERVER_ID}/stats`,
      { headers: getCraftyHeaders() }
    );
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
 * Renvoie un objet { success: boolean, status?: number, code?: string, error?: string }
 */
async function triggerCraftyStart(playerName) {
  const now = Date.now();
  const elapsedSec = Math.floor((now - lastStartRequestTime) / 1000);

  if (isStarting || elapsedSec < START_COOLDOWN_SEC) {
    const remaining = START_COOLDOWN_SEC - elapsedSec;
    log('ANTI-SPAM', `Requête ignorée pour [${playerName}]. Démarrage en cours ou cooldown actif (${remaining > 0 ? remaining : 0}s restantes).`);
    return { success: true, alreadyStarting: true, remaining };
  }

  if (!RAW_TOKEN || !CRAFTY_SERVER_ID) {
    log('WARN', `Impossible de démarrer le serveur : CRAFTY_TOKEN ou CRAFTY_SERVER_ID manquant.`);
    return { success: false, code: 'CONFIG_MISSING', error: 'CRAFTY_TOKEN ou CRAFTY_SERVER_ID manquant' };
  }

  log('CRAFTY', `Joueur [${playerName}] a cliqué pour se connecter. Envoi de l'ordre de démarrage à Crafty...`);

  const primaryUrl = `${CRAFTY_URL}/api/v2/servers/${CRAFTY_SERVER_ID}/action/${CRAFTY_ACTION}`;
  const headers = getCraftyHeaders();

  try {
    let res;
    try {
      res = await craftyClient.post(primaryUrl, {}, { headers });
    } catch (primaryErr) {
      // Si 404 sur l'action par défaut, tenter le fallback sur 'start'
      if (primaryErr.response && primaryErr.response.status === 404) {
        const fallbackAction = CRAFTY_ACTION === 'start_server' ? 'start' : 'start_server';
        const fallbackUrl = `${CRAFTY_URL}/api/v2/servers/${CRAFTY_SERVER_ID}/action/${fallbackAction}`;
        log('WARN', `Action '${CRAFTY_ACTION}' introuvable (404), tentative avec '${fallbackAction}'...`);
        res = await craftyClient.post(fallbackUrl, {}, { headers });
      } else {
        throw primaryErr;
      }
    }

    if (res && res.status >= 200 && res.status < 300) {
      isStarting = true;
      lastStartRequestTime = now;
      log('CRAFTY', `Ordre de démarrage accepté par Crafty (Code ${res.status}). En attente de Fabric sur ${TARGET_PORT}...`);
      return { success: true, status: res.status };
    } else {
      throw new Error(`Statut HTTP inattendu: ${res ? res.status : 'inconnu'}`);
    }
  } catch (err) {
    isStarting = false;
    const httpStatus = err.response?.status;
    const errorCode = httpStatus || err.code || 'ERREUR';
    
    // Log détaillé du corps de réponse de Crafty si présent (utile pour débugger les 403)
    const responseBody = err.response?.data ? JSON.stringify(err.response.data) : '';
    logError('CRAFTY', `Erreur lors de la requête à Crafty (Code ${errorCode})${responseBody ? ' Details: ' + responseBody : ''}`, err);

    return {
      success: false,
      status: httpStatus,
      code: errorCode,
      error: err.message
    };
  }
}

/**
 * Sonde rapidement le port cible pour savoir si le serveur Fabric écoute.
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
 * SERVEUR FACTICE MINECRAFT (minecraft-protocol)
 * -----------------------------------------------------------------------------
 */
const dummyServer = mc.createServer({
  host: '127.0.0.1',
  port: DUMMY_PORT,
  'online-mode': false,
  version: false,
  maxPlayers: 20,
  motd: OFFLINE_MOTD,
  hideErrors: true,
  beforePing: (response, client) => {
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

  client.removeAllListeners('login_start');
  client.once('login_start', async (packet) => {
    const username = packet.username || 'Inconnu';
    const playerIp = client.socket && client.socket.remoteAddress ? client.socket.remoteAddress : 'inconnue';
    log('AUTH', `Tentative de connexion / clic du joueur [${username}] (IP: ${playerIp})`);

    const result = await triggerCraftyStart(username);

    let kickMessage;
    if (result.success) {
      if (result.alreadyStarting) {
        kickMessage = "§6[AutoStart]\n§eLe serveur est déjà en cours de démarrage !\n§fLe serveur charge, réessaie dans quelques secondes.";
      } else {
        kickMessage = "§a[AutoStart]\n§eOrdre de démarrage envoyé à Crafty !\n§fLe serveur charge, réessaie dans 15s.";
      }
    } else {
      const codeDisplay = result.status || result.code || 'Inconnu';
      kickMessage = `§c[Erreur AutoStart]\n§fImpossible de contacter Crafty (Code ${codeDisplay}).\n§7Vérifie les logs du proxy.`;
    }

    try {
      client.write('disconnect', {
        reason: JSON.stringify({ text: kickMessage })
      });
      setTimeout(() => {
        try {
          client._end(kickMessage);
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
 * PROXY TCP PRINCIPAL (Port public LISTEN_PORT, ex: 25565)
 * -----------------------------------------------------------------------------
 */
const mainProxyServer = net.createServer((clientSocket) => {
  clientSocket.on('error', () => {});

  if (isTargetOnline) {
    const targetSocket = net.connect({ host: TARGET_HOST, port: TARGET_PORT });

    clientSocket.pipe(targetSocket);
    targetSocket.pipe(clientSocket);

    targetSocket.on('error', () => clientSocket.destroy());
    clientSocket.on('close', () => targetSocket.destroy());
    targetSocket.on('close', () => clientSocket.destroy());
  } else {
    const dummySocket = net.connect({ host: '127.0.0.1', port: DUMMY_PORT });

    clientSocket.pipe(dummySocket);
    dummySocket.pipe(clientSocket);

    dummySocket.on('error', () => clientSocket.destroy());
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