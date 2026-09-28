FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_UPDATE_NOTIFIER=false

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Apply the repository's deterministic prestart transforms during the image build.
RUN npm run prestart \
    && node --check server.js \
    && node --check scripts/back4app-entrypoint.js \
    && node --check scripts/back4app-homologation.js

USER node

EXPOSE 3000

CMD ["node", "scripts/back4app-entrypoint.js"]

