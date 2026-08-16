import fs from 'fs';
const p = '/Users/ilse/.gemini/antigravity-ide/brain/85320cf7-8fe6-4439-8db7-92d6e6981072/task.md';
let content = fs.readFileSync(p, 'utf8');
content = content.replace('- `[ ]` Update `generatePersonalizedEmail` in `auto-apply.mjs`', '- `[x]` Update `generatePersonalizedEmail` in `auto-apply.mjs`');
content = content.replace('- `[ ]` Update `web/src/components/pipeline-view.tsx` to include', '- `[x]` Update `web/src/components/pipeline-view.tsx` to include');
content = content.replace('- `[ ]` Update `web/src/components/pipeline-view.tsx` to send', '- `[x]` Update `web/src/components/pipeline-view.tsx` to send');
content = content.replace('- `[ ]` Update `web/src/app/api/status/route.ts`', '- `[x]` Update `web/src/app/api/status/route.ts`');
fs.writeFileSync(p, content);
