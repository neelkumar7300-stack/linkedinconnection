# Use the official Apify Node.js image
FROM apify/actor-node:20

# Copy package.json to the image
COPY package*.json ./

# Install only production dependencies
RUN npm --quiet set progress=false \
 && npm install --omit=dev --no-audit --no-fund

# Copy the rest of the source code
COPY . ./

# Run the start script
CMD ["npm", "start"]
