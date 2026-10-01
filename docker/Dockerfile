FROM node:22-alpine AS base

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json* ./
RUN npm install

# Copy source (tsconfig.web.json builds the browser program into dist/gateway/public)
COPY tsconfig.json tsconfig.web.json ./
COPY src ./src

# Build
FROM base AS build
RUN npm run build

# Production
FROM node:22-alpine AS production
WORKDIR /app

# xmllint: `catalog seal` and `balance seal` validate the Anexo 24 XML against
# the SAT's XSD (src/services/sat/anexo24/official-xsd.ts) and refuse without it.
RUN apk add --no-cache libxml2-utils

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY --from=build /app/dist ./dist

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "dist/index.js"]
