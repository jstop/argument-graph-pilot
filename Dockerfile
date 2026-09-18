# One image for both services; the compose file picks the entry point.
FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY vendor vendor
COPY common/package.json common/
COPY issuer/package.json issuer/
COPY relying-party/package.json relying-party/
RUN npm ci --omit=dev && npm cache clean --force
COPY common common
COPY issuer issuer
COPY relying-party relying-party
COPY schema schema
RUN mkdir /data && chown node:node /data
USER node
