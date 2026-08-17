# Careerflow Deployment Guide

## Architecture Overview

Careerflow uses a cloud-first architecture with:

- **Vercel**: Web dashboard hosting + Vercel Cron
- **AWS Lambda**: Job scanning engine (runs every 6 hours)
- **Self-hosted PostgreSQL**: single database for all data, running in Docker on the VPS
- **EventBridge**: Schedules Lambda executions

```
┌─────────────────────────────────────────────────────────────┐
│                    Careerflow Architecture                    │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  ┌─────────────┐     ┌─────────────┐     ┌─────────────┐    │
│  │   Vercel    │────▶│  Postgres   │◀────│  VPS runner │    │
│  │   Cron      │     │  PostgreSQL │     │ (Scanner)   │    │
│  │ (6 AM UTC)  │     │             │     │             │    │
│  └─────────────┘     └─────────────┘     └─────────────┘    │
│         │                   │                   │            │
│         ▼                   ▼                   ▼            │
│  ┌─────────────┐     ┌─────────────┐     ┌─────────────┐    │
│  │   Web App   │     │  Dashboard  │     │  EventBridge│    │
│  │  (Next.js)  │     │  (React)    │     │ (Scheduler) │    │
│  └─────────────┘     └─────────────┘     └─────────────┘    │
│                                                               │
└─────────────────────────────────────────────────────────────┘
```

## Quick Start

### 1. Set Up PostgreSQL

1. The database runs in Docker on the VPS (container `career-ops-postgres`).
2. Create a new project (or use existing)
3. Copy the connection string
4. Update `.env`:
   ```
   DATABASE_URL=postgresql://username:password@host/database?sslmode=require
   ```
5. Run the schema:
   ```bash
   psql $DATABASE_URL < schema.sql
   ```

### 2. Deploy Lambda Function

**Option A: Automated (Recommended)**
```bash
./setup-aws.sh
```

**Option B: Manual**
```bash
# Build Lambda package
cd lambda
npm install --production
cd ..

# Create zip
zip -r function.zip lambda/ scan.mjs scan-ats-full.mjs portals.yml providers/ lib/ config/ modes/ templates/ data/

# Deploy to AWS
aws lambda create-function \
  --function-name careerflow-scanner \
  --runtime nodejs22.x \
  --role arn:aws:iam::YOUR_ACCOUNT:role/lambda-role \
  --handler index.handler \
  --zip-file fileb://function.zip \
  --timeout 900 \
  --memory-size 1024 \
  --environment "Variables={DATABASE_URL=YOUR_DB_URL,CRON_SECRET=YOUR_SECRET}"
```

### 3. Deploy Web App to Vercel

```bash
# Install Vercel CLI
npm i -g vercel

# Deploy
vercel deploy

# Or link to existing project
vercel link
vercel deploy --prod
```

### 4. Set Up Environment Variables in Vercel

Go to Vercel Dashboard → Settings → Environment Variables:

```
DATABASE_URL=postgresql://...
CRON_SECRET=your-secure-secret
LAMBDA_SCAN_URL=https://your-lambda-url.lambda-url.region.on.aws/
```

## Cost Breakdown

### AWS Lambda (Free Tier)
- **Requests**: 1M free/month ✅
- **Duration**: 400,000 GB-seconds free/month ✅
- **Typical usage**: ~$0/month

### Self-hosted PostgreSQL
- **Storage**: 512 MB free ✅
- **Compute**: 191.9 compute-hours/month free ✅
- **Typical usage**: ~$0/month

### Vercel (Free Tier)
- **Bandwidth**: 100 GB/month ✅
- **Serverless Functions**: 100 hours/month ✅
- **Cron Jobs**: Once per day on Hobby ✅
- **Typical usage**: ~$0/month

### Total Monthly Cost: $0

## Monitoring

### Check Lambda Logs
```bash
aws logs tail /aws/lambda/careerflow-scanner --follow
```

### Check Scan Runs
```sql
SELECT * FROM scan_runs ORDER BY started_at DESC LIMIT 10;
```

### Check User Activity
```sql
SELECT user_id, last_scan_at, scanning_enabled 
FROM user_profiles 
WHERE scanning_enabled = true;
```

## Troubleshooting

### Lambda Timeout
If scanning takes too long:
1. Check Lambda logs for slow operations
2. Reduce number of platforms per scan
3. Increase Lambda memory (1024 → 2048 MB)

### Database Connection Errors
1. Verify DATABASE_URL in .env
2. Check the Postgres container for connection limits: `docker exec career-ops-postgres psql -U career_admin -d career_ops -c "SHOW max_connections;"`
3. Ensure SSL mode is enabled

### Vercel Cron Not Running
1. Check vercel.json configuration
2. Verify CRON_SECRET is set
3. Check Vercel dashboard for cron job status

## Manual Operations

### Trigger Manual Scan
```bash
# Via Lambda function URL
curl -X POST https://your-lambda-url/ \
  -H "Content-Type: application/json" \
  -d '{"action":"scheduled","userId":"system"}'

# Via AWS CLI
aws lambda invoke \
  --function-name careerflow-scanner \
  --payload '{"action":"scheduled","userId":"system"}' \
  response.json
```

### Scan Single User
```bash
curl -X POST https://your-lambda-url/ \
  -H "Content-Type: application/json" \
  -d '{"action":"scan","userId":"user123"}'
```

### Update Scan Schedule
```bash
# Change to every 6 hours
aws events put-rule \
  --name careerflow-scanner-daily-schedule \
  --schedule-expression "cron(0 */6 * * ? *)"
```

## Security Notes

1. **Never commit .env files** - Use Vercel environment variables
2. **Rotate CRON_SECRET** regularly
3. **Use IAM roles** instead of access keys
4. **Enable Vercel Authentication** for production
5. **Monitor Lambda invocations** for unusual activity

## Next Steps

1. Set up monitoring alerts (CloudWatch, Vercel)
2. Configure custom domain
3. Add authentication (Clerk, Auth.js)
4. Set up CI/CD pipeline
