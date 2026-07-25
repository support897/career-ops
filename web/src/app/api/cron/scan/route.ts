import { NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const lambda = new LambdaClient({
  region: process.env.AWS_REGION || "us-east-1",
  credentials: process.env.AWS_ACCESS_KEY_ID
    ? {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
      }
    : undefined,
});

function validateCronAuth(request: Request): boolean {
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    console.error("[Cron Scan] CRON_SECRET not configured");
    return false;
  }

  if (authHeader === `Bearer ${cronSecret}`) return true;

  const vercelCron = request.headers.get("x-vercel-cron");
  if (vercelCron) return true;

  return false;
}

export async function GET(request: Request) {
  if (!validateCronAuth(request)) {
    console.error("[Cron Scan] Unauthorized request");
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  console.log("[Cron Scan] Starting scheduled scan");

  const sql = neon(process.env.DATABASE_URL!);

  try {
    const users = await sql`
      SELECT id, user_id, scan_mode, scan_frequency_hours, preferred_days, preferred_hours,
             timezone, platforms, keywords, location_filter, last_scan_at
      FROM user_profiles
      WHERE scanning_enabled = true
        AND (
          (scan_mode = 'interval'
           AND (last_scan_at IS NULL
                OR last_scan_at + (scan_frequency_hours || ' hours')::interval <= NOW()))
          OR
          (scan_mode = 'schedule'
           AND EXTRACT(DOW FROM NOW() AT TIME ZONE COALESCE(timezone, 'UTC'))::int = ANY(preferred_days)
           AND EXTRACT(HOUR FROM NOW() AT TIME ZONE COALESCE(timezone, 'UTC'))::int = ANY(preferred_hours)
           AND (last_scan_at IS NULL OR last_scan_at < NOW() - INTERVAL '55 minutes'))
        )
    `;

    if (users.length === 0) {
      console.log("[Cron Scan] No active users due for scanning");
      return NextResponse.json({
        success: true,
        message: "No active users",
        scannedUsers: 0,
      });
    }

    console.log(`[Cron Scan] Found ${users.length} users to scan`);

    const results = [];
    const errors = [];
    const lambdaFunctionName = process.env.LAMBDA_FUNCTION_NAME || "careerflow-scanner";

    for (const user of users) {
      try {
        const payload = JSON.stringify({
          userId: user.user_id,
          action: "scan",
          platforms: user.platforms || undefined,
          keywords: user.keywords || undefined,
          location: user.location_filter?.[0] || undefined,
        });

        const command = new InvokeCommand({
          FunctionName: lambdaFunctionName,
          Payload: Buffer.from(payload),
        });

        const response = await lambda.send(command);

        if (response.FunctionError) {
          console.error(`[Cron Scan] Lambda error for ${user.user_id}:`, response.FunctionError);
          errors.push({
            userId: user.user_id,
            error: response.FunctionError,
          });
          continue;
        }

        const resultPayload = response.Payload
          ? JSON.parse(Buffer.from(response.Payload).toString())
          : {};

        const resultBody = resultPayload.body ? JSON.parse(resultPayload.body) : resultPayload;

        await sql`UPDATE user_profiles SET last_scan_at = NOW() WHERE user_id = ${user.user_id}`;

        results.push({
          userId: user.user_id,
          success: resultBody.success ?? resultPayload.statusCode === 200,
          newOffers: resultBody.newOffers || 0,
          totalFound: resultBody.totalFound || 0,
        });
      } catch (error) {
        console.error(`[Cron Scan] Error scanning user ${user.user_id}:`, error);
        errors.push({
          userId: user.user_id,
          error: error instanceof Error ? error.message : "unknown error",
        });
      }
    }

    await sql`
      INSERT INTO scan_runs (user_id, started_at, completed_at, users_scanned, new_offers, errors)
      VALUES ('system', NOW(), NOW(), ${users.length}, ${results.reduce((sum, r) => sum + (r.newOffers || 0), 0)}, ${errors.length})
    `;

    console.log(`[Cron Scan] Completed. Scanned: ${results.length}, Errors: ${errors.length}`);

    return NextResponse.json({
      success: true,
      scannedUsers: results.length,
      totalNewOffers: results.reduce((sum, r) => sum + (r.newOffers || 0), 0),
      errors: errors.length,
      results,
    });
  } catch (error) {
    console.error("[Cron Scan] Fatal error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "unknown error",
      },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  return GET(request);
}
