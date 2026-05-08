# ============================================================
# FILE: Dockerfile
# ROLE: Container image for ADIP Express API
# ============================================================
FROM node:20-alpine AS base
WORKDIR /app

# Install dependencies
COPY adip-backend/express-api/package*.json ./
RUN npm ci --production

# Copy application code
COPY adip-backend/express-api/src ./src
COPY adip-backend/shared ./node_modules/adip-shared

# Health check
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:3001/api/health || exit 1

EXPOSE 3001
ENV NODE_ENV=production
CMD ["node", "src/app.js"]
