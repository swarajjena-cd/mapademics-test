FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package.json ./

# Install only production dependencies
RUN npm install --omit=dev

# Copy app files
COPY server.mjs ./
COPY public/ ./public/
COPY data/ ./data/

EXPOSE 3456

ENV PORT=3456
ENV NODE_ENV=production

CMD ["node", "server.mjs"]
