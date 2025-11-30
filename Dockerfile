FROM node:24-slim

WORKDIR /app

# curl für Healthcheck
RUN apt-get update \
  && apt-get install -y curl \
  && rm -rf /var/lib/apt/lists/*

# Wichtig: lockfile mitkopieren
COPY package.json package-lock.json ./

# Install exakt nach Lockfile
RUN npm ci

COPY . .

EXPOSE 5173

CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]