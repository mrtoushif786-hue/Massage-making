FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
ENV HEADLESS=1 DATA_DIR=/data
CMD ["node", "index.js"]
