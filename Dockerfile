FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

COPY --chown=node:node package.json package-lock.json ./
USER node
RUN npm ci

COPY --chown=node:node . .
RUN npm run build

EXPOSE 3001
CMD ["npm", "start"]
