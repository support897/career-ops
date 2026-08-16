import fs from 'fs';
import path from 'path';

function fixTsv(p) {
  if (!fs.existsSync(p)) return;
  const content = fs.readFileSync(p, 'utf8');
  const rows = content.trim().split('\n');
  let changed = false;
  const newRows = rows.map(r => {
    const parts = r.split('\t');
    if (parts.length >= 6) {
      if (parts[4].includes('/5') && parts[5] === 'Evaluated') {
        const temp = parts[4];
        parts[4] = parts[5];
        parts[5] = temp;
        changed = true;
      }
    }
    return parts.join('\t');
  });
  if (changed) {
    fs.writeFileSync(p, newRows.join('\n') + '\n', 'utf8');
    console.log('Fixed', p);
  }
}

const dirs = ['batch/tracker-additions', 'batch/tracker-additions/merged'];
for (const dir of dirs) {
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.tsv')) fixTsv(path.join(dir, f));
    }
  }
}

