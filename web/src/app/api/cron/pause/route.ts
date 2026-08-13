import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

// Path to the pause flag file, in the project root's data directory
const PAUSE_FILE = path.resolve(process.cwd(), "..", "data", ".pause_scans");

export async function GET() {
  try {
    const isPaused = fs.existsSync(PAUSE_FILE);
    return NextResponse.json({ paused: isPaused });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const { pause } = await req.json();

    if (pause) {
      if (!fs.existsSync(PAUSE_FILE)) {
        // Create the file
        fs.writeFileSync(PAUSE_FILE, "Paused from Dashboard");
      }
    } else {
      if (fs.existsSync(PAUSE_FILE)) {
        // Delete the file
        fs.unlinkSync(PAUSE_FILE);
      }
    }

    return NextResponse.json({ paused: pause, success: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
