#!/bin/bash

containerName=impostor
imageName=impostor:latest

# Stop and remove the existing container
docker stop $containerName
docker rm $containerName

exit()