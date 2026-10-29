FROM node:24-slim AS build
WORKDIR /app
COPY package.json tsconfig.json tsconfig.build.json ./
RUN npm install
COPY src ./src
COPY scripts ./scripts
COPY data ./data
RUN npm run build

FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
