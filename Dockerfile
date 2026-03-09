FROM node:20-bookworm-slim AS base
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
ENV NODE_ENV=production

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
COPY --from=base /app /app
RUN mkdir -p /data
EXPOSE 3000
CMD ["npm", "run", "start:api"]