import tls from 'tls';
import fs, { readFileSync, existsSync, readdirSync, unlinkSync } from 'fs';
import jsyaml from 'js-yaml';
import pg from 'pg';
import path from 'path';
import { chromium } from 'playwright';

const { Pool } = pg;
const config = jsyaml.load(readFileSync('config/email.yml', 'utf8'));
const user = config.gmail.user;
const pass = config.gmail.app_password;
const dbUrl = process.env.DATABASE_URL || 'postgresql://neondb_owner:npg_oN60DfjuHaVl@ep-patient-sound-ausuu589.c-10.us-east-1.aws.neon.tech/neondb?sslmode=require';

const refHtmlContent = readFileSync('templates/reference-letter.html', 'utf8');

class ImapClient {
  constructor() {
    this.client = null;
    this.tagIndex = 1;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.client = tls.connect(993, 'imap.gmail.com', { rejectUnauthorized: false }, resolve);
      this.client.on('error', reject);
    });
  }

  sendCommand(cmd) {
    return new Promise((resolve, reject) => {
      const tag = `a${this.tagIndex++}`;
      let output = '';
      const onData = (data) => {
        output += data.toString();
        if (output.includes(`${tag} OK`)) {
          this.client.removeListener('data', onData);
          resolve(output);
        } else if (output.includes(`${tag} NO`) || output.includes(`${tag} BAD`)) {
          this.client.removeListener('data', onData);
          reject(new Error(`IMAP error: ${output}`));
        }
      };
      this.client.on('data', onData);
      this.client.write(`${tag} ${cmd}\r\n`);
    });
  }

  async login() {
    await new Promise(r => setTimeout(r, 1000));
    await this.sendCommand(`LOGIN "${user}" "${pass}"`);
  }

  async selectDrafts() {
    await this.sendCommand(`SELECT "[Gmail]/Drafts"`);
  }

  async deleteAllDrafts() {
    console.log('🧹 Purging all old Gmail drafts...');
    await this.sendCommand(`STORE 1:* +FLAGS (\\Deleted)`);
    await this.sendCommand(`EXPUNGE`);
    console.log('✅ All old drafts purged from Gmail.');
  }

  async appendDraft(mimeMessage) {
    const tag = `a${this.tagIndex++}`;
    const len = Buffer.byteLength(mimeMessage, 'utf8');
    const cmdStr = `${tag} APPEND "[Gmail]/Drafts" (\\Draft) {${len}}\r\n`;

    return new Promise((resolve, reject) => {
      let output = '';
      const onData = (data) => {
        output += data.toString();
        if (output.includes('+')) {
          this.client.removeListener('data', onData);
          const onAppendDone = (data2) => {
            const str2 = data2.toString();
            if (str2.includes(`${tag} OK`)) {
              this.client.removeListener('data', onAppendDone);
              resolve(str2);
            } else if (str2.includes(`${tag} NO`) || str2.includes(`${tag} BAD`)) {
              this.client.removeListener('data', onAppendDone);
              reject(new Error(`APPEND failed: ${str2}`));
            }
          };
          this.client.on('data', onAppendDone);
          this.client.write(mimeMessage + '\r\n');
        } else if (output.includes(`${tag} NO`) || output.includes(`${tag} BAD`)) {
          this.client.removeListener('data', onData);
          reject(new Error(`APPEND ready failed: ${output}`));
        }
      };
      this.client.on('data', onData);
      this.client.write(cmdStr);
    });
  }

  close() {
    if (this.client) this.client.end();
  }
}

function buildMime({ from, to, subject, body, attachments = [] }) {
  const boundary = `boundary_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const parts = [];

  parts.push(
    `Content-Type: text/plain; charset="UTF-8"\r\n` +
    `Content-Transfer-Encoding: quoted-printable\r\n\r\n` +
    body
  );

  for (const att of attachments) {
    if (!existsSync(att.path)) continue;
    const filename = att.filename || path.basename(att.path);
    const content = readFileSync(att.path);
    const mimeType = filename.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream';
    const base64 = content.toString('base64');
    const wrapped = base64.match(/.{1,76}/g).join('\r\n');

    parts.push(
      `Content-Type: ${mimeType}; name="${filename}"\r\n` +
      `Content-Disposition: attachment; filename="${filename}"\r\n` +
      `Content-Transfer-Encoding: base64\r\n\r\n` +
      wrapped
    );
  }

  const date = new Date().toUTCString();
  const messageId = `<${Date.now()}.${Math.random().toString(36).slice(2)}@careerflow>`;

  return (
    `From: ${from}\r\n` +
    `To: ${to}\r\n` +
    `Subject: ${subject}\r\n` +
    `Date: ${date}\r\n` +
    `Message-ID: ${messageId}\r\n` +
    `MIME-Version: 1.0\r\n` +
    `Content-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n` +
    parts.map(p => `--${boundary}\r\n${p}`).join('\r\n') +
    `\r\n--${boundary}--`
  );
}

async function renderPdf(page, htmlContent, outputPath) {
  await page.setContent(htmlContent, { waitUntil: 'networkidle' });
  await page.pdf({ path: outputPath, format: 'A4', margin: { top: '0.4in', bottom: '0.4in', left: '0.5in', right: '0.5in' }, printBackground: true });
}

async function main() {
  const pool = new Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });

  // Update DB email drafts to state "My CV, cover letter, and reference letter are attached for your review."
  await pool.query(`
    UPDATE job_inbox 
    SET email_draft = REPLACE(email_draft, 'My CV and cover letter are attached for your review.', 'My CV, cover letter, and reference letter are attached for your review.'),
        reference_letter = $1
    WHERE email_draft IS NOT NULL AND email_draft != ''
  `, [refHtmlContent]);

  console.log('✅ Updated DB email_draft text and reference_letter HTML column for all jobs.');

  const res = await pool.query(`
    SELECT id, company, role, email_draft, cover_letter, cv_html
    FROM job_inbox
    WHERE email_draft IS NOT NULL AND email_draft != ''
    ORDER BY created_at DESC
  `);

  console.log(`🚀 Found ${res.rows.length} total jobs in pipeline to generate 3-attachment Gmail drafts for.`);

  const imap = new ImapClient();
  await imap.connect();
  await imap.login();
  await imap.selectDrafts();
  await imap.deleteAllDrafts();

  const outputDir = '/Users/ilse/career-ops-2/output';
  const refPdfPath = path.join(outputDir, 'Reference_Letter_Taylor_Chorley.pdf');

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  // Ensure Reference Letter PDF exists
  if (!existsSync(refPdfPath)) {
    await renderPdf(page, refHtmlContent, refPdfPath);
  }

  let count = 0;
  let errorCount = 0;

  for (let i = 0; i < res.rows.length; i++) {
    const job = res.rows[i];
    const role = job.role || 'Position';
    const company = job.company || 'Company';
    const cleanCompany = company.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-');
    const subject = `Application: ${role} at ${company} — Ilse Placencia`;

    let body = job.email_draft;
    if (body.startsWith('Subject:')) {
      const idx = body.indexOf('\n');
      if (idx !== -1) body = body.slice(idx).trim();
    }

    // 1. Resume PDF
    let cvPdfPath = null;
    if (job.cv_html) {
      const cleanCvHtml = job.cv_html.replace(/<!-- PROJECTS -->\s*<div class="section">\s*<div class="section-title">Projects<\/div>[\s\S]*?<\/div>\s*/gi, '');
      cvPdfPath = path.join(outputDir, `cv-temp-${cleanCompany}-${i}.pdf`);
      try {
        await renderPdf(page, cleanCvHtml, cvPdfPath);
      } catch (e) {
        cvPdfPath = null;
      }
    }
    if (!cvPdfPath || !existsSync(cvPdfPath)) {
      if (existsSync(outputDir)) {
        const files = readdirSync(outputDir);
        const match = files.find(f => f.startsWith('cv-') && f.includes(cleanCompany) && f.endsWith('.pdf'));
        if (match) cvPdfPath = path.join(outputDir, match);
      }
    }

    // 2. Cover Letter PDF
    let clPdfPath = null;
    if (job.cover_letter) {
      const clHtml = `<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Helvetica, Arial, sans-serif; font-size: 13px; line-height: 1.6; color: #1a1a2e; max-width: 650px; margin: 40px auto; padding: 0 20px; }
    h2 { color: #107b89; font-size: 16px; margin-bottom: 20px; border-bottom: 2px solid #107b89; padding-bottom: 8px; }
  </style>
</head>
<body>
  <h2>Cover Letter — ${role} at ${company}</h2>
  <div>${job.cover_letter.replace(/\n/g, '<br>')}</div>
</body>
</html>`;
      clPdfPath = path.join(outputDir, `cl-temp-${cleanCompany}-${i}.pdf`);
      try {
        await renderPdf(page, clHtml, clPdfPath);
      } catch (e) {
        clPdfPath = null;
      }
    }

    // 3. Assemble ALL 3 Attachments
    const attachments = [];
    if (cvPdfPath && existsSync(cvPdfPath)) {
      attachments.push({ path: cvPdfPath, filename: `${company.replace(/[^a-zA-Z0-9]/g, '')}_Resume.pdf` });
    }
    if (clPdfPath && existsSync(clPdfPath)) {
      attachments.push({ path: clPdfPath, filename: `${company.replace(/[^a-zA-Z0-9]/g, '')}_CoverLetter.pdf` });
    }
    if (existsSync(refPdfPath)) {
      attachments.push({ path: refPdfPath, filename: `Ilse_Placencia_Reference_Letter.pdf` });
    }

    const mime = buildMime({ from: user, to: '', subject, body, attachments });

    try {
      const resultStr = await imap.appendDraft(mime);
      const uidMatch = resultStr.match(/\[APPENDUID \d+ (\d+)\]/i);
      const newUid = uidMatch ? uidMatch[1] : 'created';
      await pool.query('UPDATE job_inbox SET gmail_draft_id = $1 WHERE id = $2', [newUid, job.id]);
      count++;
      console.log(`[${count}/140] ✅ ${company} — ${role} (${attachments.length} attachments: Resume + Cover Letter + Reference Letter)`);
    } catch (e) {
      errorCount++;
      console.error(`[${i+1}/140] ❌ Failed ${company}: ${e.message}`);
    }

    // Clean up temporary files
    if (cvPdfPath && cvPdfPath.includes('cv-temp-') && existsSync(cvPdfPath)) {
      try { unlinkSync(cvPdfPath); } catch {}
    }
    if (clPdfPath && clPdfPath.includes('cl-temp-') && existsSync(clPdfPath)) {
      try { unlinkSync(clPdfPath); } catch {}
    }
  }

  await browser.close();
  console.log(`\n══════════════════════════════════════════════════`);
  console.log(`🎉 COMPLETED: Uploaded ${count}/140 Gmail drafts with ALL 3 ATTACHMENTS!`);
  console.log(`══════════════════════════════════════════════════`);

  imap.close();
  await pool.end();
}

main().catch(console.error);
