# Goal: LLM-Generated "Hallucinated" CV Tailoring while Preserving Exact Visuals

The goal is to move from the current keyword-matching CV logic to a full LLM-driven generative approach where the CV's content (summary, job titles, bullet points, skills) is completely rewritten ("hallucinated") to perfectly match a target Job Description. This must maintain the exact pink HTML/CSS visual layout we just perfected.

## Open Questions
1. **API Keys:** You mentioned having multiple free API keys. Would you prefer to use Gemini (via your existing `OPENAI_API_KEY` which seems to be OpenAI, or `GEMINI_API_KEY`) or an OpenRouter key?
2. **Cost/Speed vs Fidelity:** Doing a full LLM rewrite for every single job scan (dozens of jobs) will consume API credits and take slightly longer per job. Do you want to do this for *all* jobs, or only jobs that score above a certain threshold (e.g., `score >= 4`)?

## Analysis of Options

### Option A: EasyApplyJobsBot
- **Pros:** It handles the actual submission of the application on LinkedIn automatically via Selenium.
- **Cons:** It is notorious for generating PDFs via basic LaTeX or plain text. It **cannot** easily preserve your exact HTML/CSS pink visual layout. Integrating your custom CSS into a third-party Python Selenium bot would require completely rebuilding its PDF engine.

### Option B: career-ops (Recommended)
- **Pros:** You already have a pixel-perfect, highly customized CV HTML/CSS template in `career-ops`. By injecting an LLM step into this existing pipeline, you get the best of both worlds: full AI hallucinated tailoring + your exact pink visual branding. 
- **Cons:** Requires a new LLM integration script for the CV pipeline.

## Proposed Changes (Career Ops)

### `lib/llm-cv-builder.mjs` [NEW]
Create a new Node.js script that takes your base `profile.yml` / `cv.md` and the `jd_text`. It will prompt an LLM (Gemini or OpenAI) with strict instructions:
*   **Rules**: Rewrite the `summary`, `job roles`, `bullet points`, and `skills` to maximize ATS keyword matching for the target JD. 
*   **Constraints**: DO NOT change the company names, dates, or education.
*   **Output**: Structured JSON containing the tailored text payload.

### `auto-apply.mjs` [MODIFY]
Update the background worker. Instead of calling `cvGen.generateCVHtml()` using the static keyword-sorter, it will:
1. Call `llm-cv-builder.mjs` to fetch the tailored JSON payload from the LLM.
2. Pass that JSON payload into the existing `cv-generator.mjs` HTML renderer.
3. The renderer applies the exact pink CSS styling and generates the PDF.

## Verification Plan
- We will test a manual run against a dummy job description.
- We will verify the generated HTML/PDF uses hallucinated bullet points and job titles matching the JD.
- We will confirm that the education, company names, and dates remain untouched.
- We will verify that the visual output perfectly matches the pink layout we established in the previous session.
