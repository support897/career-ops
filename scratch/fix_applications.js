import fs from 'fs';

const p = 'data/applications.md';
if (fs.existsSync(p)) {
  const content = fs.readFileSync(p, 'utf8');
  const rows = content.trim().split('\n');
  let changed = false;
  const newRows = rows.map(r => {
    if (r.startsWith('|')) {
      const parts = r.split('|').map(x => x.trim());
      // Header: | Num | Date | Company | Role | Status | Score | PDF | Report | Notes |
      // Indices:
      // 0: (empty)
      // 1: Num
      // 2: Date
      // 3: Company
      // 4: Role
      // 5: Status
      // 6: Score
      if (parts.length >= 7) {
        if (parts[5].includes('/5') && parts[6] === 'Evaluated') {
          const temp = parts[5];
          parts[5] = parts[6];
          parts[6] = temp;
          changed = true;
          // Reconstruct the row
          return '| ' + parts.slice(1, -1).join(' | ') + ' |';
        }
      }
    }
    return r;
  });
  if (changed) {
    fs.writeFileSync(p, newRows.join('\n') + '\n', 'utf8');
    console.log('Fixed applications.md');
  } else {
    console.log('No rows needed fixing in applications.md');
  }
}
