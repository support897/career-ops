#!/bin/bash
# deploy-lambda.sh — Deploy career-ops scanner to AWS Lambda
#
# Prerequisites:
#   1. AWS CLI installed and configured (`aws configure`)
#   2. Docker installed and running
#   3. DATABASE_URL environment variable set
#
# Usage:
#   chmod +x scripts/deploy-lambda.sh
#   ./scripts/deploy-lambda.sh
#
# This script:
#   1. Creates an ECR repository (if not exists)
#   2. Builds the Docker image
#   3. Pushes to ECR
#   4. Creates/updates the Lambda function
#   5. Sets up API Gateway for HTTP access
#   6. Outputs the API Gateway URL

set -euo pipefail

# ── Configuration ──────────────────────────────────────────────────
AWS_REGION="${AWS_REGION:-us-east-1}"
ECR_REPO_NAME="career-ops-scanner"
LAMBDA_FUNCTION_NAME="career-ops-scanner"
LAMBDA_MEMORY=2048
LAMBDA_TIMEOUT=300

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  career-ops Lambda Deployment${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
echo ""

# ── Check prerequisites ────────────────────────────────────────────
echo -e "${YELLOW}Checking prerequisites...${NC}"

if ! command -v aws &> /dev/null; then
  echo -e "${RED}Error: AWS CLI not installed.${NC}"
  echo "Install: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html"
  exit 1
fi

if ! command -v docker &> /dev/null; then
  echo -e "${RED}Error: Docker not installed.${NC}"
  echo "Install: https://docs.docker.com/get-docker/"
  exit 1
fi

if ! docker info &> /dev/null; then
  echo -e "${RED}Error: Docker is not running.${NC}"
  echo "Start Docker Desktop and try again."
  exit 1
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo -e "${RED}Error: DATABASE_URL environment variable not set.${NC}"
  echo "Set it: export DATABASE_URL='postgresql://...'"
  exit 1
fi

# Get AWS account ID
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
if [ -z "$AWS_ACCOUNT_ID" ]; then
  echo -e "${RED}Error: Could not get AWS account ID. Run 'aws configure' first.${NC}"
  exit 1
fi

ECR_URI="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPO_NAME}"

echo -e "${GREEN}✓ AWS Account: ${AWS_ACCOUNT_ID}${NC}"
echo -e "${GREEN}✓ Region: ${AWS_REGION}${NC}"
echo ""

# ── Step 1: Create ECR repository ─────────────────────────────────
echo -e "${YELLOW}Step 1/5: Creating ECR repository...${NC}"

if aws ecr describe-repositories --repository-names "$ECR_REPO_NAME" --region "$AWS_REGION" &> /dev/null; then
  echo -e "${GREEN}  ✓ ECR repository already exists${NC}"
else
  aws ecr create-repository \
    --repository-name "$ECR_REPO_NAME" \
    --region "$AWS_REGION" \
    --image-scanning-configuration scanOnPush=true \
    --encryption-configuration encryptionType=AES256
  echo -e "${GREEN}  ✓ ECR repository created${NC}"
fi

# ── Step 2: Login to ECR ──────────────────────────────────────────
echo -e "${YELLOW}Step 2/5: Logging in to ECR...${NC}"

aws ecr get-login-password --region "$AWS_REGION" | \
  docker login --username AWS --password-stdin "${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"

echo -e "${GREEN}  ✓ Logged in to ECR${NC}"

# ── Step 3: Build Docker image ────────────────────────────────────
echo -e "${YELLOW}Step 3/5: Building Docker image...${NC}"

cd "$(dirname "$0")/.."

docker build \
  --platform linux/arm64 \
  -t "$ECR_REPO_NAME" \
  -f lambda/Dockerfile \
  .

echo -e "${GREEN}  ✓ Docker image built${NC}"

# ── Step 4: Push to ECR ───────────────────────────────────────────
echo -e "${YELLOW}Step 4/5: Pushing to ECR...${NC}"

docker tag "$ECR_REPO_NAME:latest" "$ECR_URI:latest"
docker push "$ECR_URI:latest"

echo -e "${GREEN}  ✓ Image pushed to ECR${NC}"

# ── Step 5: Create/Update Lambda function ──────────────────────────
echo -e "${YELLOW}Step 5/5: Creating Lambda function...${NC}"

# Check if function exists
if aws lambda get-function --function-name "$LAMBDA_FUNCTION_NAME" --region "$AWS_REGION" &> /dev/null; then
  echo -e "  Updating existing function..."
  aws lambda update-function-code \
    --function-name "$LAMBDA_FUNCTION_NAME" \
    --image-uri "$ECR_URI:latest" \
    --region "$AWS_REGION" > /dev/null

  aws lambda wait function-updated \
    --function-name "$LAMBDA_FUNCTION_NAME" \
    --region "$AWS_REGION"

  echo -e "${GREEN}  ✓ Lambda function updated${NC}"
else
  echo -e "  Creating new function..."
  aws lambda create-function \
    --function-name "$LAMBDA_FUNCTION_NAME" \
    --package-type Image \
    --code ImageUri="$ECR_URI:latest" \
    --role "arn:aws:iam::${AWS_ACCOUNT_ID}:role/lambda-basic-execution" \
    --timeout "$LAMBDA_TIMEOUT" \
    --memory-size "$LAMBDA_MEMORY" \
    --environment "Variables={DATABASE_URL=${DATABASE_URL}}" \
    --region "$AWS_REGION" > /dev/null

  echo -e "${GREEN}  ✓ Lambda function created${NC}"
fi

# ── Create Function URL (simpler than API Gateway) ────────────────
echo -e "${YELLOW}Setting up Function URL...${NC}"

# Check if function URL already exists
FUNCTION_URL=$(aws lambda get-function-url-config \
  --function-name "$LAMBDA_FUNCTION_NAME" \
  --region "$AWS_REGION" \
  --query 'FunctionUrl' \
  --output text 2>/dev/null || echo "")

if [ -z "$FUNCTION_URL" ] || [ "$FUNCTION_URL" = "None" ]; then
  FUNCTION_URL=$(aws lambda create-function-url-config \
    --function-name "$LAMBDA_FUNCTION_NAME" \
    --auth-type NONE \
    --region "$AWS_REGION" \
    --query 'FunctionUrl' \
    --output text)
  echo -e "${GREEN}  ✓ Function URL created${NC}"
else
  echo -e "${GREEN}  ✓ Function URL already exists${NC}"
fi

# ── Done ──────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Deployment Complete!${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "  Lambda Function: ${YELLOW}${LAMBDA_FUNCTION_NAME}${NC}"
echo -e "  Function URL:    ${YELLOW}${FUNCTION_URL}${NC}"
echo -e "  Region:          ${YELLOW}${AWS_REGION}${NC}"
echo -e "  Memory:          ${YELLOW}${LAMBDA_MEMORY} MB${NC}"
echo -e "  Timeout:         ${YELLOW}${LAMBDA_TIMEOUT}s${NC}"
echo ""
echo -e "${YELLOW}Test it:${NC}"
echo "  curl -X POST ${FUNCTION_URL} \\"
echo "    -H 'Content-Type: application/json' \\"
echo "    -d '{\"userId\": \"user_3GfaXsz2WyxzFl0LcD4ktVnNsCS\"}'"
echo ""
echo -e "${YELLOW}Next step:${NC}"
echo "  Set this URL in your Inngest function:"
echo "  LAMBDA_FUNCTION_URL=${FUNCTION_URL}"
echo ""
