#!/bin/bash

containerName=impostor
imageName=impostor:latest

# Stop and remove the existing container
docker stop $containerName
docker rm $containerName

# Rebuild the image
docker build -t $imageName .

# Run a new container with the updated image
docker run -d --name $containerName --restart unless-stopped $imageName