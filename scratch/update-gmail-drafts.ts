import dotenv from "dotenv";
import path from "path";
import tls from "tls";
import fs from "fs";
import { fileURLToPath } from "url";

dotenv.config({ path: path.join(__dirname, "../web/.env.local") });

import { getSql } from "../web/src/lib/db";
import { createGmailDraft } from "../lib/gmail-draft.mjs";

const user = process.env.GMAIL_USER || 'placenciailse@gmail.com';
const password = process.env.GMAIL_APP_PASSWORD || 'hptfiylhorjaakno';
const folder = '[Gmail]/Drafts';

// Connect and delete existing drafts with subject starting with [career-ops] or Application:
function deleteOldDrafts() {
  return new Promise((resolve, reject) => {
    console.log("Connecting to IMAP to clean up old drafts...");
    const socket = tls.connect({ host: 'imap.gmail.com', port: 993, rejectUnauthorized: false });
    let buffer = '';
    let tagNum = 0;
    const timeout = setTimeout(() => { socket.destroy(); reject(new Error('IMAP timeout')); }, 25000);

    function send(cmd) {
      tagNum++;
      socket.write('A' + tagNum + ' ' + cmd + '\r\n');
    }

    socket.on('data', (data) => {
      buffer += data.toString();
      const lines = buffer.split('\r\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line) continue;

        if (line.startsWith('A1 OK')) {
          send(`SELECT "${folder}"`);
        } else if (line.startsWith('A2 OK')) {
          // Search for drafts with career-ops or Application in subject
          send('SEARCH OR SUBJECT "[career-ops]" SUBJECT "Application:"');
        } else if (line.startsWith('* SEARCH')) {
          const ids = line.replace('* SEARCH', '').trim().split(/\s+/).filter(Boolean);
          if (ids.length > 0) {
            console.log(`Found old drafts: ${ids.join(', ')}. Deleting...`);
            send(`STORE ${ids.join(',')} +FLAGS (\\Deleted)`);
          } else {
            console.log("No existing drafts found to delete.");
            send('LOGOUT');
            socket.end();
            clearTimeout(timeout);
            resolve(true);
          }
        } else if (line.startsWith('A3 OK')) {
          send('EXPUNGE');
        } else if (line.startsWith('A4 OK')) {
          send('LOGOUT');
          socket.end();
          clearTimeout(timeout);
          resolve(true);
        } else if (line.includes('BAD') || line.includes('NO')) {
          console.warn("IMAP Warning:", line);
        }
      }
    });

    socket.on('error', reject);
    setTimeout(() => send(`LOGIN ${user} ${password}`), 300);
  });
}

async function run() {
  // 1. Delete the old drafts first
  try {
    await deleteOldDrafts();
  } catch (e) {
    console.warn("Delete old drafts failed or timed out, proceeding to create drafts:", e.message);
  }

  // 2. Fetch jobs from DB with score >= 3.0
  const sql = getSql();
  const rows = await sql`
    SELECT id, company, role, url, cover_letter, email_draft
    FROM job_inbox
    WHERE score >= 3.0
  `;

  console.log(`Re-creating drafts for ${rows.length} jobs...`);
  const root = path.join(__dirname, "..");
  const outputDir = path.join(root, "output");

  for (const row of rows) {
    const cleanCompany = row.company.toLowerCase().replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-");
    let attachments = [];

    if (fs.existsSync(outputDir)) {
      const files = fs.readdirSync(outputDir);
      
      // Find CV PDF
      const cvMatch = files.filter(f => f.startsWith("cv-") && f.includes(cleanCompany) && f.endsWith(".pdf"))
                           .sort((a, b) => fs.statSync(path.join(outputDir, b)).mtimeMs - fs.statSync(path.join(outputDir, a)).mtimeMs)[0];
      if (cvMatch) {
        attachments.push({
          path: path.join(outputDir, cvMatch),
          filename: `${row.company.replace(/[^a-zA-Z0-9]/g, "")}_Resume.pdf`
        });
      }

      // Find Cover Letter PDF
      const clMatch = files.filter(f => (f.startsWith("cl-") || f.startsWith("cover-letter-")) && f.includes(cleanCompany) && f.endsWith(".pdf"))
                           .sort((a, b) => fs.statSync(path.join(outputDir, b)).mtimeMs - fs.statSync(path.join(outputDir, a)).mtimeMs)[0];
      if (clMatch) {
        attachments.push({
          path: path.join(outputDir, clMatch),
          filename: `${row.company.replace(/[^a-zA-Z0-9]/g, "")}_Cover_Letter.pdf`
        });
      }
    }

    const subject = `Application: ${row.role} at ${row.company} — Ilse Placencia`;
    const emailBody = row.email_draft || row.cover_letter || "";

    console.log(`Creating Gmail draft for ${row.company} (${row.role})...`);
    const res = await createGmailDraft({
      from: user,
      to: "",
      subject,
      body: emailBody,
      attachments
    });

    if (res.success) {
      console.log(`   ✅ Draft created. UID: ${res.uid}`);
      // Update gmail_draft_id in database
      await sql`
        UPDATE job_inbox
        SET gmail_draft_id = ${res.uid || 'created'}
        WHERE id = ${row.id}
      `;
    } else {
      console.error(`   ❌ Failed: ${res.error}`);
    }
  }

  console.log("All drafts successfully re-created and updated!");
  process.exit(0);
}

run().catch(err => {
  console.error("Run failed:", err);
  process.exit(1);
});
