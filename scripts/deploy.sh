#!/bin/bash
set -e

echo "Deploying updates to VPS workflow..."

# 1. Commit and push to GitHub
echo "Adding changes to git..."
git add .
echo "Committing changes..."
git commit -m "chore: automated deployment from agent workflow" || true
echo "Pushing to GitHub..."
git push origin main

# 2. Trigger Vercel
# Assumes the Vercel CLI is authenticated globally or locally
if command -v vercel &> /dev/null; then
    echo "Triggering Vercel deployment..."
    vercel --prod
else
    echo "Vercel CLI not found or not in PATH, skipping Vercel deployment."
fi

echo "Deployment complete."
