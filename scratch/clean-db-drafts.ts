import dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.join(__dirname, "../web/.env.local") });

import { getSql } from "../web/src/lib/db";
import { getUserId } from "../web/src/lib/user-context";

async function run() {
  const sql = getSql();
  console.log("Reading jobs from database...");
  const rows = await sql`
    SELECT id, company, role, url, cover_letter, email_draft
    FROM job_inbox
    WHERE cover_letter IS NOT NULL OR email_draft IS NOT NULL
  `;
  console.log(`Found ${rows.length} jobs to update.`);

  for (const row of rows) {
    let changed = false;
    let coverLetter = row.cover_letter || "";
    let emailDraft = row.email_draft || "";

    // 1. Clean cover letter
    if (coverLetter) {
      const orig = coverLetter;
      // Remove dashes
      coverLetter = coverLetter
        .replace(/ — /g, ", ")
        .replace(/ —/g, ", ")
        .replace(/—/g, ", ")
        .replace(/ – /g, ", ")
        .replace(/ –/g, ", ")
        .replace(/–/g, ", ")
        .replace(/ - /g, ", ");

      // Correct CV attachment line
      coverLetter = coverLetter
        .replace(/I've attached my CV \(personalised for this job\)/gi, "I've attached my cv")
        .replace(/I've attached my CV \(personalized for this role\)/gi, "I've attached my cv")
        .replace(/I've attached my CV \(personalized for this job\)/gi, "I've attached my cv")
        .replace(/I've attached my CV \(tailored for this role\)/gi, "I've attached my cv")
        .replace(/I've attached my personalized CV/gi, "I've attached my cv")
        .replace(/I have attached my tailored CV/gi, "I've attached my cv");

      if (coverLetter !== orig) changed = true;
    }

    // 2. Clean email draft & ensure URL at the top
    if (emailDraft) {
      const orig = emailDraft;
      
      // Remove existing Apply Here prefix if present to avoid duplication
      emailDraft = emailDraft.replace(/^🔗 APPLY HERE:[^\n]+\n+/, "");
      emailDraft = emailDraft.replace(/^🔗 APPLY HERE:[^\n]+/, "");

      // Remove dashes
      emailDraft = emailDraft
        .replace(/ — /g, ", ")
        .replace(/ —/g, ", ")
        .replace(/—/g, ", ")
        .replace(/ – /g, ", ")
        .replace(/ –/g, ", ")
        .replace(/–/g, ", ")
        .replace(/ - /g, ", ");

      // Correct CV attachment line
      emailDraft = emailDraft
        .replace(/I've attached my CV \(personalised for this job\)/gi, "I've attached my cv")
        .replace(/I've attached my CV \(personalized for this role\)/gi, "I've attached my cv")
        .replace(/I've attached my CV \(personalized for this job\)/gi, "I've attached my cv")
        .replace(/I've attached my CV \(tailored for this role\)/gi, "I've attached my cv")
        .replace(/I've attached my personalized CV/gi, "I've attached my cv")
        .replace(/I have attached my tailored CV/gi, "I've attached my cv");

      // Prepend verified job URL
      const url = row.url || "";
      emailDraft = `🔗 APPLY HERE: ${url}\n\n` + emailDraft;

      if (emailDraft !== orig) changed = true;
    }

    if (changed) {
      console.log(`Updating job ${row.id} (${row.company} — ${row.role})...`);
      await sql`
        UPDATE job_inbox
        SET cover_letter = ${coverLetter}, email_draft = ${emailDraft}
        WHERE id = ${row.id}
      `;
    }
  }

  console.log("All database jobs successfully updated!");
  process.exit(0);
}

run().catch(err => {
  console.error("Database update failed:", err);
  process.exit(1);
});
