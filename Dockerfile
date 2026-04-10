FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY src/ src/
COPY tsconfig.json ./
RUN npx tsc
ENV TRANSPORT=stdio
CMD ["node", "dist/index.js"]
