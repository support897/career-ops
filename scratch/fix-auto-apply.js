const fs = require("fs");
const path = require("path");

const filePath = path.join(__dirname, "../auto-apply.mjs");
let content = fs.readFileSync(filePath, "utf8");

// We find the index of "const manualPackage = {" and "try {" and clean up the block
const targetStr = `      // If VIP cookie apply failed or non-VIP, generate manual package
      if (!atsApplied) {
        const source = platform ? platform.charAt(0).toUpperCase() + platform.slice(1) : 'Job Board';
        const manualPackage = {
          company: job.company, role: job.role || job.title, url: job.url,
          source, score: jobScore, matchReasons,
          cv: finalCvPath, coverLetter: finalClPath,
          emailSubject, emailBody,
            // Save backup file draft if Gmail draft was not created successfully
    if (!gmailDraftId && !DRY_RUN) {`;

const replacement = `      // If VIP cookie apply failed or non-VIP, generate manual package
      if (!atsApplied) {
        const source = platform ? platform.charAt(0).toUpperCase() + platform.slice(1) : 'Job Board';
        const manualPackage = {
          company: job.company, role: job.role || job.title, url: job.url,
          source, score: jobScore, matchReasons,
          cv: finalCvPath, coverLetter: finalClPath,
          emailSubject, emailBody,
          instructions: \`Apply at: \${job.url}\\n\\nSteps:\\n1. Click link\\n2. Upload CV: \${finalCvPath}\\n3. Upload cover letter: \${finalClPath}\\n4. Submit\`,
        };
        const packagePath = join(__dirname, \`output/manual-apply-\${slug}-\${TODAY}.json\`);
        try {
          writeFileSync(packagePath, JSON.stringify(manualPackage, null, 2));
          console.log(\`   💾 Manual apply package saved: \${packagePath}\`);
        } catch (e) {
          console.log(\`   ⚠️  Failed to save manual package: \${e.message}\`);
        }
      }
    }

    // Save backup file draft if Gmail draft was not created successfully
    if (!gmailDraftId && !DRY_RUN) {`;

if (content.includes(targetStr)) {
  content = content.replace(targetStr, replacement);
  fs.writeFileSync(filePath, content, "utf8");
  console.log("SUCCESS: auto-apply.mjs syntax fixed successfully!");
} else {
  // Let's do a more robust substring check
  const startIdx = content.indexOf("// If VIP cookie apply failed or non-VIP, generate manual package");
  const endIdx = content.indexOf("const draftPath = join(__dirname, `output/draft-${slug}-${TODAY}.md`);");
  if (startIdx !== -1 && endIdx !== -1) {
    const brokenBlock = content.slice(startIdx, endIdx);
    content = content.replace(brokenBlock, replacement);
    fs.writeFileSync(filePath, content, "utf8");
    console.log("SUCCESS: auto-apply.mjs syntax fixed via offset range!");
  } else {
    console.error("ERROR: Target block not found!");
  }
}
