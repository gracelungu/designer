// Stands in for a dev server: answers on a free port and prints its URL like Vite does.
require('http').createServer((q, s) => s.end('<!doctype html><div id="root">runnable app</div>')).listen(Number(process.env.PORT) || 0, '127.0.0.1', function () {
  console.log(`  Local:   http://localhost:${this.address().port}/`);
});
