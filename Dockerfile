# Stage 1: Use an official Node.js runtime as a parent image.
# We use the 'alpine' version for a smaller, more secure final image.
FROM node:20-alpine

# Create and set the working directory inside the container
WORKDIR /usr/src/app

# Copy package.json and package-lock.json (if it exists)
# This step is separate to leverage Docker's layer caching.
# Dependencies are only re-installed if package*.json files change.
COPY package*.json ./

# Install app dependencies
# Using --only=production will skip devDependencies for a smaller image
RUN npm install --only=production

# Copy the rest of your application's source code into the container
COPY . .

# The command that will be executed when the container starts
CMD [ "npm", "start" ]