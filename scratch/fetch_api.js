fetch('http://localhost:3001/api/pipeline')
  .then(r => r.json())
  .then(data => {
    const apps = data.applications.map(a => ({ company: a.company, status: a.status, score: a.score }));
    console.table(apps);
  })
  .catch(console.error);
