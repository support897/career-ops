#!/bin/bash
# Setup EventBridge rule for Lambda scanning
# Run this after adding EventBridge permissions to your IAM user

set -e

echo "📅 Setting up EventBridge scheduled rule..."

# Create EventBridge rule for daily scanning at 6 AM UTC
aws events put-rule \
  --name "careerflow-scanner-daily-schedule" \
  --schedule-expression "cron(0 6 * * ? *)" \
  --state ENABLED \
  --description "Triggers Lambda scanning daily at 6 AM UTC"

# Add Lambda as target
aws events put-targets \
  --rule "careerflow-scanner-daily-schedule" \
  --targets "[{
    \"Id\": \"careerflow-scanner\",
    \"Arn\": \"arn:aws:lambda:us-east-1:357542024881:function:careerflow-scanner\"
  }]"

# Add permission for EventBridge to invoke Lambda
aws lambda add-permission \
  --function-name careerflow-scanner \
  --statement-id eventbridge-invoke \
  --action lambda:InvokeFunction \
  --principal events.amazonaws.com \
  --source-arn "arn:aws:events:us-east-1:357542024881:rule/careerflow-scanner-daily-schedule"

echo "✅ EventBridge rule created and linked to Lambda"
echo "   Rule: careerflow-scanner-daily-schedule"
echo "   Schedule: Daily at 6 AM UTC"
echo "   Target: careerflow-scanner Lambda"
