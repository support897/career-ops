import { NextResponse } from "next/server";
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

function validateAuth(request: Request): boolean {
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return false;
  if (authHeader === `Bearer ${cronSecret}`) return true;
  const vercelCron = request.headers.get("x-vercel-cron");
  if (vercelCron) return true;
  return false;
}

export async function GET(request: Request) {
  if (!validateAuth(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  console.log("[Cron Digest] Triggering Lambda daily-digest");

  try {
    const command = new InvokeCommand({
      FunctionName: process.env.LAMBDA_FUNCTION_NAME || "careerflow-scanner",
      Payload: Buffer.from(JSON.stringify({ action: "daily-digest" })),
    });

    const response = await lambda.send(command);

    if (response.FunctionError) {
      console.error("[Cron Digest] Lambda error:", response.FunctionError);
      return NextResponse.json({ error: response.FunctionError }, { status: 500 });
    }

    const result = response.Payload
      ? JSON.parse(Buffer.from(response.Payload).toString())
      : {};

    const body = result.body ? JSON.parse(result.body) : result;

    console.log(`[Cron Digest] Done. Success: ${body.success}, Message: ${body.message || body.messageId || "sent"}`);

    return NextResponse.json(body);
  } catch (error) {
    console.error("[Cron Digest] Error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "unknown" },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  return GET(request);
}
