FROM node:24-alpine
LABEL org.opencontainers.image.title="綺綺 KIKI｜智慧秘書" \
      org.opencontainers.image.description="Your Intelligent Work Assistant"
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --chown=node:node src ./src
COPY --chown=node:node scripts/check-database.js scripts/healthcheck.js ./scripts/
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=4s --start-period=15s --retries=3 CMD ["node", "scripts/healthcheck.js"]
CMD ["node", "src/main.js"]
