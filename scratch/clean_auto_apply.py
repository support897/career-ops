import re
import sys

def clean_file(filepath):
    with open(filepath, 'r') as f:
        content = f.read()

    # 1. Remove import
    content = content.replace("import { generateLLMReferenceLetter, generateLLMCoverLetter } from './lib/llm-cv-builder.mjs';\n", "")
    
    # 2. Remove LLM Cover letter logic
    # Find the LLM cover letter block
    llm_cl_pattern = r"    if \(useLlm && llmDocs\.cover_letter !== false\) \{\n      console\.log\(`   📄 Generating Cover Letter via LLM\.\.\.`\);\n      try \{.*?✅ LLM Cover Letter PDF generated: \$\{finalClPath\}`\);\n      \} catch \(e\) \{\n        console\.log\(`   ⚠️  LLM Cover Letter failed: \$\{e\.message\.slice\(0, 80\)\}`\);\n      \}\n    \}\n\n    if \(!coverLetterText\) \{\n      if \(clGeneratorFn\) \{"
    
    # Replace with just the native check
    content = re.sub(llm_cl_pattern, "    if (clGeneratorFn) {", content, flags=re.DOTALL)
    
    # Remove the extra closing brace from the if (!coverLetterText) block
    # It looks like:
    #         } catch (e) {
    #           console.log(`   ⚠️  Native Cover Letter failed: ${e.message.slice(0, 80)}`);
    #         }
    #       }
    #     }
    # We want to change the last two braces to one brace
    cl_end_pattern = r"        \}\n      \}\n    \}\n\n    // 3\. Reference Letter Generation"
    content = re.sub(cl_end_pattern, "        }\n      }\n\n    // 3. Reference Letter Generation", content)

    # 3. Remove LLM Reference letter logic
    llm_rl_pattern = r"    if \(useLlm && llmDocs\.reference_letter !== false\) \{\n      console\.log\(`   📄 Generating Reference Letter via LLM\.\.\.`\);\n      try \{\n        generatedRefLetterHtml = await generateLLMReferenceLetter\(profileForDoc, jdText\);\n        console\.log\(`   ✅ LLM Reference Letter generated\.`\);\n      \} catch \(e\) \{\n        console\.log\(`   ⚠️  LLM Reference Letter failed: \$\{e\.message\.slice\(0, 80\)\}`\);\n      \}\n    \}\n\n    if \(!generatedRefLetterHtml\) \{\n      if \(rlGeneratorFn\) \{"
    content = re.sub(llm_rl_pattern, "    if (rlGeneratorFn) {", content, flags=re.DOTALL)
    
    rl_end_pattern = r"        \}\n      \}\n    \}\n    \n    // Generate PDF for Reference Letter"
    content = re.sub(rl_end_pattern, "        }\n      }\n    \n    // Generate PDF for Reference Letter", content)

    # 4. Remove generationMethod LLM check
    gen_method_pattern = r"generationMethod: useLlm && llmDocs\.cv !== false \? 'llm' : 'keyword'"
    content = re.sub(gen_method_pattern, "generationMethod: 'keyword'", content)

    with open(filepath, 'w') as f:
        f.write(content)

if __name__ == "__main__":
    clean_file('auto-apply.mjs')
    print("Cleanup complete.")
