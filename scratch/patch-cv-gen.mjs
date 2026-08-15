import fs from 'fs';

let content = fs.readFileSync('lib/cv-generator.mjs', 'utf8');

const newFunc = `
import { generateLLMTailoredCV } from './llm-cv-builder.mjs';

/**
 * Generate CV HTML asynchronously (supports LLM mode).
 */
export async function generateCVHtmlAsync(profile, jdText, cvMdPath = null) {
  let payload;
  if (profile.cv_generation_mode === 'llm') {
    try {
      const basePayload = buildCVPayload(profile, jdText, cvMdPath);
      const cvText = loadCVData(cvMdPath).rawText || JSON.stringify(basePayload);
      const llmPayload = await generateLLMTailoredCV(profile, cvText, jdText);
      
      // Merge LLM tailored parts back into base payload
      payload = {
        ...basePayload,
        summary: llmPayload.summary || basePayload.summary,
        experience: llmPayload.experience || basePayload.experience,
        skills: llmPayload.skills || basePayload.skills
      };
    } catch (e) {
      console.error("[cv-generator] LLM Generation failed, falling back to keyword mode:", e.message);
      payload = buildCVPayload(profile, jdText, cvMdPath);
    }
  } else {
    payload = buildCVPayload(profile, jdText, cvMdPath);
  }

  const { resolve } = await import('path');
  const templatePath = resolve(__dirname, '..', 'templates', 'cv-template.html');
  const template = fs.readFileSync(templatePath, 'utf-8');

  let html = renderCVHtml(template, payload);
  let accentColor = profile?.style?.accent_color;
  
  if (!accentColor) {
    try {
      const profilePath = resolve(__dirname, '..', 'config', 'profile.yml');
      if (fs.existsSync(profilePath)) {
        const yamlStr = fs.readFileSync(profilePath, 'utf-8');
        const match = yamlStr.match(/accent_color:\s*["']?([^"'\r\n]+)["']?/);
        if (match && match[1]) {
          accentColor = match[1];
        }
      }
    } catch (e) {}
  }

  if (accentColor) {
    html = html.replace("</head>", \`<style>:root { --accent-color: \${accentColor}; }</style></head>\`);
  }
  return html;
}
`;

content = content.replace('export function generateCVHtml(', newFunc + '\nexport function generateCVHtml(');
// also replace the async call inside generateCV
content = content.replace('const html = generateCVHtml(profile, jdText);', 'const html = await generateCVHtmlAsync(profile, jdText);');
fs.writeFileSync('lib/cv-generator.mjs', content);
