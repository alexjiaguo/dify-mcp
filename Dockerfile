FROM node:24-alpine

ENV NODE_ENV=production \
    DIFYWF_MCP_TRANSPORT=http \
    DIFYWF_MCP_PORT=3000 \
    DIFYWF_MCP_HOST=0.0.0.0 \
    DIFYWF_HOME=/home/node/.difywf

WORKDIR /app

COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --chown=node:node bin ./bin
COPY --chown=node:node src ./src
RUN ln -s /app/bin/difywf.js /usr/local/bin/difywf

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.DIFYWF_MCP_PORT + '/health').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"

# Binding 0.0.0.0 requires DIFYWF_MCP_TOKEN (Bearer or x-difywf-token on /mcp).
# /health stays unauthenticated for this probe.
CMD ["difywf", "mcp", "serve"]
