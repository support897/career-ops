#!/bin/bash
# Careerflow AWS Lambda + EventBridge Setup Script
# This script deploys the Lambda function and sets up EventBridge for scheduled scanning
#
# Prerequisites:
#   - AWS CLI installed and configured
#   - Docker installed (for building Lambda package)
#   - Node.js 22+ installed
#
# Usage:
#   chmod +x setup-aws.sh
#   ./setup-aws.sh

set -e

echo "🚀 Careerflow AWS Lambda + EventBridge Setup"
echo "=============================================="

# Configuration
FUNCTION_NAME="careerflow-scanner"
REGION="us-east-1"
RUNTIME="nodejs22.x"
HANDLER="index.handler"
MEMORY_SIZE=1024
TIMEOUT=900  # 15 minutes
SCRAMBLE_KEY="careerflow-scanner-$(date +%s)"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check prerequisites
echo -e "\n${YELLOW}Checking prerequisites...${NC}"

if ! command -v aws &> /dev/null; then
    echo -e "${RED}❌ AWS CLI not found. Install it first:${NC}"
    echo "   https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html"
    exit 1
fi

if ! command -v docker &> /dev/null; then
    echo -e "${RED}❌ Docker not found. Install it first:${NC}"
    echo "   https://docs.docker.com/get-docker/"
    exit 1
fi

if ! command -v node &> /dev/null; then
    echo -e "${RED}❌ Node.js not found. Install it first:${NC}"
    echo "   https://nodejs.org/"
    exit 1
fi

echo -e "${GREEN}✅ All prerequisites found${NC}"

# Get AWS account ID
echo -e "\n${YELLOW}Getting AWS account information...${NC}"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
echo -e "${GREEN}✅ AWS Account ID: ${ACCOUNT_ID}${NC}"

# Create IAM role for Lambda
echo -e "\n${YELLOW}Creating IAM role for Lambda...${NC}"

ROLE_NAME="${FUNCTION_NAME}-role"
ROLE_ARN=$(aws iam create-role \
    --role-name "$ROLE_NAME" \
    --assume-role-policy-document '{
        "Version": "2012-10-17",
        "Statement": [
            {
                "Effect": "Allow",
                "Principal": {
                    "Service": "lambda.amazonaws.com"
                },
                "Action": "sts:AssumeRole"
            }
        ]
    }' \
    --query 'Role.Arn' \
    --output text 2>/dev/null || echo "")

if [ -z "$ROLE_ARN" ]; then
    echo -e "${YELLOW}Role already exists, getting ARN...${NC}"
    ROLE_ARN=$(aws iam get-role --role-name "$ROLE_NAME" --query 'Role.Arn' --output text)
fi

echo -e "${GREEN}✅ IAM Role: ${ROLE_ARN}${NC}"

# Attach basic Lambda execution policy
echo -e "${YELLOW}Attaching Lambda execution policy...${NC}"
aws iam attach-role-policy \
    --role-name "$ROLE_NAME" \
    --policy-arn "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole" 2>/dev/null || true

# Create deployment package
echo -e "\n${YELLOW}Creating deployment package...${NC}"

# Clean previous build
rm -rf build-lambda
mkdir -p build-lambda

# Copy Lambda files
cp lambda/index.mjs build-lambda/
cp lambda/package-minimal.json build-lambda/package.json

# Copy required source files
cp scan.mjs build-lambda/
cp scan-ats-full.mjs build-lambda/
cp portals.yml build-lambda/
cp tracker-aliases.json build-lambda/

# Copy directories (excluding unnecessary files)
cp -r providers build-lambda/
cp -r plugins build-lambda/
cp -r lib build-lambda/
cp -r config build-lambda/
cp -r modes build-lambda/
cp -r templates build-lambda/

# Create minimal data directory
mkdir -p build-lambda/data
cp data/scan-history.tsv build-lambda/data/ 2>/dev/null || true
cp data/blacklist.md build-lambda/data/ 2>/dev/null || true

# Install dependencies (production only, no dev dependencies)
echo -e "${YELLOW}Installing Lambda dependencies...${NC}"
cd build-lambda
npm install --production --ignore-scripts 2>/dev/null || npm install --production
cd ..

# Remove unnecessary files to reduce size
echo -e "${YELLOW}Cleaning up unnecessary files...${NC}"
find build-lambda -name "*.md" -type f ! -name "package.json" -delete 2>/dev/null || true
find build-lambda -name "*.ts" -type f -delete 2>/dev/null || true
find build-lambda -name "*.d.ts" -type f -delete 2>/dev/null || true
find build-lambda -name "*.map" -type f -delete 2>/dev/null || true
find build-lambda -name "test" -type d -exec rm -rf {} + 2>/dev/null || true
find build-lambda -name "tests" -type d -exec rm -rf {} + 2>/dev/null || true
find build-lambda -name "__tests__" -type d -exec rm -rf {} + 2>/dev/null || true
find build-lambda -name "example" -type d -exec rm -rf {} + 2>/dev/null || true
find build-lambda -name "examples" -type d -exec rm -rf {} + 2>/dev/null || true
find build-lambda -name ".github" -type d -exec rm -rf {} + 2>/dev/null || true

# Create zip package (with max compression)
echo -e "${YELLOW}Creating zip package...${NC}"
cd build-lambda
zip -r -9 ../function.zip .
cd ..

# Check size
ZIP_SIZE=$(du -h function.zip | cut -f1)
echo -e "${GREEN}✅ Deployment package created (${ZIP_SIZE})${NC}"

# Create Lambda function
echo -e "\n${YELLOW}Creating Lambda function...${NC}"

# Get DATABASE_URL from .env
DATABASE_URL=$(grep DATABASE_URL .env | cut -d= -f2-)
CRON_SECRET=$(grep CRON_SECRET .env | cut -d= -f2-)

if [ -z "$DATABASE_URL" ]; then
    echo -e "${RED}❌ DATABASE_URL not found in .env${NC}"
    exit 1
fi

# Wait for role to be available
echo -e "${YELLOW}Waiting for IAM role to be available...${NC}"
sleep 10

# Create or update function
if aws lambda get-function --function-name "$FUNCTION_NAME" --region "$REGION" &> /dev/null; then
    echo -e "${YELLOW}Updating existing Lambda function...${NC}"
    aws lambda update-function-code \
        --function-name "$FUNCTION_NAME" \
        --region "$REGION" \
        --zip-file "fileb://$(pwd)/function.zip"
    
    sleep 5
    
    aws lambda update-function-configuration \
        --function-name "$FUNCTION_NAME" \
        --region "$REGION" \
        --runtime "$RUNTIME" \
        --handler "$HANDLER" \
        --memory-size $MEMORY_SIZE \
        --timeout $TIMEOUT \
        --environment "Variables={DATABASE_URL=${DATABASE_URL},CRON_SECRET=${CRON_SECRET},NODE_OPTIONS=--max-old-space-size=1536}"
else
    echo -e "${YELLOW}Creating new Lambda function...${NC}"
    aws lambda create-function \
        --function-name "$FUNCTION_NAME" \
        --region "$REGION" \
        --runtime "$RUNTIME" \
        --role "$ROLE_ARN" \
        --handler "$HANDLER" \
        --zip-file "fileb://$(pwd)/function.zip" \
        --memory-size $MEMORY_SIZE \
        --timeout $TIMEOUT \
        --environment "Variables={DATABASE_URL=${DATABASE_URL},CRON_SECRET=${CRON_SECRET},NODE_OPTIONS=--max-old-space-size=1536}"
fi

echo -e "${GREEN}✅ Lambda function created/updated${NC}"

# Get Lambda function ARN
FUNCTION_ARN=$(aws lambda get-function-configuration \
    --function-name "$FUNCTION_NAME" \
    --region "$REGION" \
    --query 'FunctionArn' \
    --output text)

echo -e "${GREEN}✅ Lambda ARN: ${FUNCTION_ARN}${NC}"

# Create EventBridge rule for scheduled scanning
echo -e "\n${YELLOW}Creating EventBridge rule for scheduled scanning...${NC}"

RULE_NAME="${FUNCTION_NAME}-daily-schedule"
SCHEDULE_EXPRESSION="cron(0 6 * * ? *)"  # Every day at 6 AM UTC

aws events put-rule \
    --name "$RULE_NAME" \
    --schedule-expression "$SCHEDULE_EXPRESSION" \
    --description "Careerflow daily job scanning" \
    --region "$REGION"

echo -e "${GREEN}✅ EventBridge rule created${NC}"

# Add Lambda as target for EventBridge rule
echo -e "${YELLOW}Adding Lambda as target...${NC}"

aws events put-targets \
    --rule "$RULE_NAME" \
    --region "$REGION" \
    --targets "Id"="1","Arn"="$FUNCTION_ARN","Input"='{"action":"scheduled","userId":"system"}'

echo -e "${GREEN}✅ Lambda added as target${NC}"

# Grant EventBridge permission to invoke Lambda
echo -e "${YELLOW}Granting EventBridge permission to invoke Lambda...${NC}"

aws lambda add-permission \
    --function-name "$FUNCTION_NAME" \
    --region "$REGION" \
    --statement-id "eventbridge-invoke" \
    --action "lambda:InvokeFunction" \
    --principal "events.amazonaws.com" \
    --source-arn "arn:aws:events:${REGION}:${ACCOUNT_ID}:rule/${RULE_NAME}" 2>/dev/null || true

echo -e "${GREEN}✅ Permission granted${NC}"

# Create function URL for direct invocation
echo -e "\n${YELLOW}Creating Lambda function URL...${NC}"

FUNCTION_URL=$(aws lambda create-function-url-config \
    --function-name "$FUNCTION_NAME" \
    --region "$REGION" \
    --auth-type "NONE" \
    --query 'FunctionUrl' \
    --output text 2>/dev/null || echo "")

if [ -n "$FUNCTION_URL" ]; then
    echo -e "${GREEN}✅ Function URL: ${FUNCTION_URL}${NC}"
else
    echo -e "${YELLOW}⚠️ Function URL already exists or failed to create${NC}"
fi

# Clean up
echo -e "\n${YELLOW}Cleaning up...${NC}"
rm -rf build-lambda
rm -f function.zip

echo -e "\n${GREEN}✅ Setup complete!${NC}"
echo ""
echo "Summary:"
echo "  - Lambda Function: ${FUNCTION_NAME}"
echo "  - Region: ${REGION}"
echo "  - Schedule: Daily at 6 AM UTC"
echo "  - Function URL: ${FUNCTION_URL:-'Not created'}"
echo ""
echo "Next steps:"
echo "  1. Set LAMBDA_SCAN_URL in .env to: ${FUNCTION_URL}"
echo "  2. Deploy the web app to Vercel: vercel deploy"
echo "  3. Test the Lambda function:"
echo "     aws lambda invoke --function-name ${FUNCTION_NAME} --payload '{\"action\":\"scheduled\",\"userId\":\"system\"}' response.json"
echo ""
echo "To change the schedule:"
echo "  aws events put-rule --name ${RULE_NAME} --schedule-expression 'cron(0 */6 * * ? *)'  # Every 6 hours"
echo ""
echo "To manually trigger a scan:"
echo "  curl -X POST ${FUNCTION_URL} -H 'Content-Type: application/json' -d '{\"action\":\"scheduled\",\"userId\":\"system\"}'"
