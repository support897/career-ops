import fs from 'fs';
const p = '/Users/ilse/.gemini/antigravity-ide/brain/85320cf7-8fe6-4439-8db7-92d6e6981072/task.md';
let content = fs.readFileSync(p, 'utf8');
content = content.replace('- `[ ]` Verify that `/api/status` correctly updates the database and tracker.', '- `[x]` Verify that `/api/status` correctly updates the database and tracker.');
fs.writeFileSync(p, content);
