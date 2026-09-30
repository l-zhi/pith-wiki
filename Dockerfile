FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY bin/ ./bin/
COPY src/ ./src/
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PITH_WIKI_HOME=/data \
    PITH_WIKI_WORKSPACE=/workspace
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules/ ./node_modules/
COPY --from=build /app/dist/ ./dist/
COPY bundled-skills/ ./bundled-skills/
RUN mkdir -p /data /workspace && chown node:node /data /workspace
USER node
WORKDIR /workspace
ENTRYPOINT ["node", "/app/dist/bin/pith-wiki.js"]
CMD ["--help"]
