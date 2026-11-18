// Stands in for Storybook: serves an index.json listing this project's stories.
const entries = { 'inputs-pill--default': { id: 'inputs-pill--default', importPath: './src/Pill.stories.tsx' } };
require('http').createServer((q, s) => (q.url === '/index.json' ? s.end(JSON.stringify({ v: 5, entries })) : s.end('<div id="storybook-root"></div>'))).listen(0, '127.0.0.1', function () {
  console.log(`Storybook started\n  Local: http://localhost:${this.address().port}/`);
});
