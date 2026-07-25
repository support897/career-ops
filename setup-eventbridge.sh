#!/bin/bash
# setup-eventbridge.sh — Create EventBridge rules for Lambda scanning
# Run this AFTER adding events:PutRule permission to career-ops-scanner IAM user
#
# Prerequisites:
#   - AWS CLI installed and configured
#   - career-ops-scanner IAM user has events:PutRule permission

set -e

FUNCTION_NAME="careerflow-scanner"
REGION="us-east-1"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

echo "🚀 Setting up EventBridge rules for $FUNCTION_NAME"

# 1. Hourly scan rule — triggers Lambda every hour
# Lambda checks each user's schedule and scans only those who are due
echo "📅 Creating hourly scan rule..."
aws events put-rule \
  --name "careerflow-hourly-scan" \
  --schedule-expression "rate(1 hour)" \
  --description "Careerflow hourly scan — checks per-user schedules" \
  --region "$REGION" 2>&1

# Get Lambda ARN
FUNCTION_ARN=$(aws lambda get-function-configuration \
  --function-name "$FUNCTION_NAME" \
  --region "$REGION" \
  --query 'FunctionArn' \
  --output text)

# Add Lambda as target for hourly scan
aws events put-targets \
  --rule "careerflow-hourly-scan" \
  --region "$REGION" \
  --targets "Id"="1","Arn"="$FUNCTION_ARN","Input"='{"action":"scheduled"}' 2>&1

echo "✅ Hourly scan rule created"

# 2. Daily digest rule — triggers Lambda once/day at 6pm Brisbane (8am UTC)
echo "📧 Creating daily digest rule..."
aws events put-rule \
  --name "careerflow-daily-digest" \
  --schedule-expression "cron(0 8 * * ? *)" \
  --description "Careerflow daily digest email — 6pm Brisbane" \
  --region "$REGION" 2>&1

# Add Lambda as target for daily digest
aws events put-targets \
  --rule "careerflow-daily-digest" \
  --region "$REGION" \
  --targets "Id"="1","Arn"="$FUNCTION_ARN","Input"='{"action":"daily-digest"}' 2>&1

echo "✅ Daily digest rule created"

# 3. Grant EventBridge permission to invoke Lambda
echo "🔐 Granting EventBridge permission to invoke Lambda..."
aws lambda add-permission \
  --function-name "$FUNCTION_NAME" \
  --region "$REGION" \
  --statement-id "eventbridge-hourly-scan" \
  --action "lambda:InvokeFunction" \
  --principal "events.amazonaws.com" \
  --source-arn "arn:aws:events:${REGION}:${ACCOUNT_ID}:rule/careerflow-hourly-scan" 2>/dev/null || true

aws lambda add-permission \
  --function-name "$FUNCTION_NAME" \
  --region "$REGION" \
  --statement-id "eventbridge-daily-digest" \
  --action "lambda:InvokeFunction" \
  --principal "events.amazonaws.com" \
  --source-arn "arn:aws:events:${REGION}:${ACCOUNT_ID}:rule/careerflow-daily-digest" 2>/dev/null || true

echo "✅ Permissions granted"

echo ""
echo "✅ EventBridge setup complete!"
echo ""
echo "Rules created:"
echo "  - careerflow-hourly-scan: every hour → Lambda checks per-user schedules"
echo "  - careerflow-daily-digest: 8am UTC (6pm Brisbane) → sends digest email"
echo ""
echo "To test:"
echo "  aws lambda invoke --function-name $FUNCTION_NAME --payload '{\"action\":\"scheduled\"}' response.json"
echo "  aws lambda invoke --function-name $FUNCTION_NAME --payload '{\"action\":\"daily-digest\"}' response.json"
echo ""
echo "To delete rules:"
echo "  aws events remove-targets --rule careerflow-hourly-scan --ids 1"
echo "  aws events delete-rule --name careerflow-hourly-scan"
echo "  aws events remove-targets --rule careerflow-daily-digest --ids 1"
echo "  aws events delete-rule --name careerflow-daily-digest"
