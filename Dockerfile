# Build stage: compile TypeScript with dev dependencies present.
FROM apify/actor-node:20 AS builder

COPY package*.json ./
RUN npm install --include=dev --audit=false

COPY . ./
RUN npm run build

# Final stage: production dependencies and compiled JavaScript only.
FROM apify/actor-node:20

COPY package*.json ./
RUN npm --quiet set progress=false \
    && npm install --omit=dev --omit=optional --audit=false \
    && echo "Installed NPM packages:" \
    && (npm list --omit=dev --all || true) \
    && echo "Node.js version:" \
    && node --version \
    && echo "NPM version:" \
    && npm --version \
    && rm -r ~/.npm

COPY --from=builder /usr/src/app/dist ./dist
COPY . ./

CMD npm run start:prod --silent
