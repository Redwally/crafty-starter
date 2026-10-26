# ==============================================================================
# Dockerfile pour le Proxy Auto-Start Minecraft (Crafty Controller v4)
# Compatible Dokploy / Portainer / Docker CLI
# ==============================================================================

FROM node:22-alpine

# Installation de dumb-init pour une gestion propre des signaux d'arrêt POSIX (SIGTERM / SIGINT)
RUN apk add --no-cache dumb-init

WORKDIR /app

# Optimisation du cache Docker : copier uniquement les définitions de dépendances
COPY package*.json ./

# Installation des dépendances de production
RUN npm install --omit=dev

# Copie du reste des sources
COPY . .

# Définir l'environnement
ENV NODE_ENV=production

# Port d'écoute public par défaut de Minecraft
EXPOSE 25565

# Gestionnaire d'initialisation pour éviter les processus zombies et assurer l'arrêt propre
ENTRYPOINT ["/usr/bin/dumb-init", "--"]

# Commande de démarrage
CMD ["node", "index.js"]
