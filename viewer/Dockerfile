FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
# Build the static UI and place it where the server serves it from (dist/ui)
COPY ui ./ui
RUN cd ui && npm install && npm run build && mkdir -p /app/dist/ui && cp -r dist/* /app/dist/ui/

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
CMD ["node", "dist/index.js"]
