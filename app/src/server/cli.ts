// `npx designer` / `npm start`: run Designer as a local server and open it in the browser.
import { execFile } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './index.js';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const { url, close } = await startServer({
  port: Number(flag('port') ?? process.env.DESIGNER_PORT ?? 4818),
  staticDir: join(here, '..', 'web'),
  token: process.env.DESIGNER_TOKEN,
  initialProject: flag('project') ? resolve(flag('project')!) : undefined,
  workspace: process.env.DESIGNER_WORKSPACE || undefined,
  // dist/server -> app/demo
  demoDir: join(here, '..', '..', 'demo'),
});
console.log(`Designer is running at ${url}`);
if (!args.includes('--no-open')) execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], () => undefined);
process.on('SIGINT', () => {
  close();
  process.exit(0);
});
