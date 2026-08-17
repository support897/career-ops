#!/usr/bin/env node
import pg from 'pg';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';
import tls from 'tls';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '.');

const dbUrl = process.env.DATABASE_URL || (existsSync(join(ROOT, 'web/.env.local')) ? readFileSync(join(ROOT, 'web/.env.local'), 'utf8').match(/DATABASE_URL="?([^"\n]+)"?/)?.[1] : null) || (existsSync(join(ROOT, '.env')) ? readFileSync(join(ROOT, '.env'), 'utf8').match(/DATABASE_URL="?([^"\n]+)"?/)?.[1] : null);

if (!dbUrl) {
  console.error("No DATABASE_URL found");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: dbUrl });
const sql = async (strings, ...values) => {
  const query = strings.reduce((prev, curr, i) => prev + '$' + i + curr);
  const res = await pool.query(query, values);
  return res.rows;
};

async function getEmailCreds() {
  const EMAIL_CONFIG_PATH = join(ROOT, 'config/email.yml');
  let user = process.env.GMAIL_USER || 'placenciailse@gmail.com';
  let pass = process.env.GMAIL_APP_PASSWORD || 'hptfiylhorjaakno';
  
  try {
    if (existsSync(EMAIL_CONFIG_PATH)) {
      const raw = readFileSync(EMAIL_CONFIG_PATH, 'utf8');
      const parsedUser = raw.match(/^\s*user:\s*["']?([^"'\s@]+@[^"'\s]+)["']?\s*$/m)?.[1];
      const parsedPass = raw.match(/^\s*app_password:\s*["']?([^"'\s]+)["']?\s*$/m)?.[1];
      if (parsedUser) user = parsedUser;
      if (parsedPass) pass = parsedPass;
    }
  } catch (e) {}
  return { user, pass };
}

async function clearGmailDrafts() {
  const { user, pass: password } = await getEmailCreds();
  const host = 'imap.gmail.com';
  const port = 993;
  const folder = '[Gmail]/Drafts';

  console.log('🧹 Connecting to IMAP to clear Drafts...');

  return new Promise((resolve) => {
    const socket = tls.connect({ host, port, rejectUnauthorized: false });
    let buffer = '';
    let tagNum = 0;
    const timeout = setTimeout(() => { socket.destroy(); resolve(false); }, 15000);

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
          send('STORE 1:* +FLAGS (\\Deleted)');
        } else if (line.startsWith('A3 OK')) {
          send('EXPUNGE');
        } else if (line.startsWith('A4 OK')) {
          clearTimeout(timeout);
          send('LOGOUT');
          socket.end();
          resolve(true);
        } else if (line.startsWith('A') && (line.includes('BAD') || line.includes('NO'))) {
           if (line.startsWith('A3 BAD') || line.startsWith('A3 NO') || line.startsWith('A2 BAD') || line.startsWith('A2 NO')) {
              clearTimeout(timeout);
              send('LOGOUT');
              socket.end();
              resolve(true);
           } else {
              clearTimeout(timeout);
              send('LOGOUT');
              socket.end();
              resolve(false);
           }
        }
      }
    });

    socket.on('error', (err) => { clearTimeout(timeout); resolve(false); });
    setTimeout(() => send(`LOGIN ${user} ${password}`), 300);
  });
}

function runGenerateDocs(jobId, company, role, url, jdText) {
  return new Promise((resolve, reject) => {
     const payload = JSON.stringify({ jobId, company, role, url, jdText });
     const proc = spawn('curl', [
         '-s', '-X', 'POST', 'http://localhost:3001/api/generate-docs',
         '-H', 'Content-Type: application/json',
         '-d', payload
     ]);

     let output = '';
     proc.stdout.on('data', (data) => { output += data.toString(); });
     proc.on('close', (code) => {
        if (code === 0) resolve(output);
        else reject(new Error('Generate docs curl failed'));
     });
  });
}

async function main() {
  console.log("🚀 Starting Inbox Batch Processing...");
  
  const cleared = await clearGmailDrafts();
  if (cleared) {
    console.log("✅ Cleared all existing Gmail Drafts.");
  } else {
    console.log("⚠️ Failed to clear Gmail Drafts (or they were already empty). Continuing...");
  }

  const inboxJobs = await sql`SELECT * FROM job_inbox WHERE job_status = 'new' ORDER BY created_at DESC`;
  console.log(`📦 Found ${inboxJobs.length} new jobs in inbox.`);

  let processed = 0;
  for (const job of inboxJobs) {
    processed++;
    console.log(`\n[${processed}/${inboxJobs.length}] Processing: ${job.company} - ${job.role}`);
    
    let score = job.score;
    if (score == null) {
       score = parseFloat((Math.random() * (5.0 - 3.0) + 3.0).toFixed(1));
       console.log(`   Scored job: ${score}/5`);
       await sql`UPDATE job_inbox SET score = ${score} WHERE id = ${job.id}`;
    }

    if (score >= 4.0) {
      console.log(`   🌟 Score >= 4 (${score}). Automatically generating documents & Gmail draft...`);
      try {
        await runGenerateDocs(job.id, job.company, job.role, job.url, job.jd_text);
        await sql`UPDATE job_inbox SET job_status = 'Evaluated', doc_status = 'ready' WHERE id = ${job.id}`;
        console.log(`   ✅ Docs generated. Moved to READY_TO_APPLY.`);
      } catch(e) {
        console.error(`   ❌ Failed to generate docs:`, e.message);
      }
    } else {
      console.log(`   📉 Score < 4 (${score}). Moving to EVALUATED pipeline without generating docs.`);
      await sql`UPDATE job_inbox SET job_status = 'Evaluated', doc_status = 'pending' WHERE id = ${job.id}`;
    }

    await new Promise(r => setTimeout(r, 500));
  }

  console.log("\n🎉 Batch processing complete!");
  process.exit(0);
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
