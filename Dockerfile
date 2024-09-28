FROM node:20

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies
COPY package*.json ./
RUN npm install
RUN npm install -g nodemon

EXPOSE 3000

CMD ["nodemon", "index.js"]