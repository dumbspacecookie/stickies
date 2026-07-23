# Stickies MCP server — image used by Glama to start the server and answer
# introspection (list-tools) requests. stdio transport; no native build deps.
FROM node:22-slim

WORKDIR /app

# Install production deps first for layer caching.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source (server reads ../package.json for its version).
COPY src ./src

ENV NODE_ENV=production

# Stdio MCP server. --disable-warning silences the node:sqlite experimental notice.
ENTRYPOINT ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
