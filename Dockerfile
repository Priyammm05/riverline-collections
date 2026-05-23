FROM node:20-alpine
WORKDIR /app

RUN npm install -g pnpm

# Copy workspace config first — needed so pnpm approves build scripts
COPY pnpm-workspace.yaml package.json ./
RUN pnpm install

# Copy source
COPY . .

CMD ["pnpm", "run", "api"]
