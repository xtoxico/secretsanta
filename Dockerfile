FROM node:18-alpine

# Set working directory
WORKDIR /app

# Copy package.json and package-lock.json (if available)
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy project source
COPY . .

# Expose port
EXPOSE 3000

# Start application
CMD ["npm", "start"]
