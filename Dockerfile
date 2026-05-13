FROM node:20-slim

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source code
COPY . .

# Railway sets the PORT environment variable
EXPOSE 3000

CMD ["npm", "start"]
