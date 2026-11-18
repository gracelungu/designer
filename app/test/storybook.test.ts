import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { DevProcess, findRunningStorybook, storybookPorts, waitingForAnswer } from '../src/server/project';

async function fakeStorybook(importPaths: string[]) {
  const s = createServer((req, res) => {
    if (req.url === '/index.json') {
      const entries = Object.fromEntries(importPaths.map((p, i) => [`s${i}`, { importPath: p }]));
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ v: 5, entries }));
    } else res.writeHead(404).end();
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return { port: (s.address() as AddressInfo).port, close: () => new Promise<void>((r) => s.close(() => r())) };
}

describe('reusing a running Storybook', () => {
  it('reads the port from the storybook script first', () => {
    expect(storybookPorts('storybook dev -p 6100')).toEqual([6100, 6006, 6007, 6008, 6009]);
    expect(storybookPorts('storybook dev --port=7000 --no-open')[0]).toBe(7000);
    expect(storybookPorts(undefined)[0]).toBe(6006);
  });

  it("finds this project's Storybook and ignores another project's", async () => {
    const sb = await fakeStorybook(['./src/Button.stories.tsx', './src/Card.stories.tsx']);
    try {
      const script = `storybook dev -p ${sb.port}`;
      expect(await findRunningStorybook(['src/Button.stories.tsx'], script, ['127.0.0.1'])).toBe(`http://127.0.0.1:${sb.port}`);
      // monorepo: Storybook runs in a package folder
      expect(await findRunningStorybook(['packages/ui/src/Card.stories.tsx'], script, ['127.0.0.1'])).toBe(`http://127.0.0.1:${sb.port}`);
      expect(await findRunningStorybook(['src/Other.stories.tsx'], script, ['127.0.0.1'])).toBeUndefined();
    } finally {
      await sb.close();
    }
  });

  it('an adopted server is reused and never stopped by Designer', async () => {
    const d = new DevProcess('storybook');
    d.adopt('/p', 'http://127.0.0.1:6006');
    expect(await d.start('/p')).toBe('http://127.0.0.1:6006');
    d.stop();
    expect(d.url).toBeUndefined();
    expect(d.adopted).toBe(false);
  });

  it('notices a dev server waiting for a yes/no answer', () => {
    expect(waitingForAnswer('\x1b[?25l\x1b[2K\x1b[1G? Port 6106 is not available. Would you like to run Storybook on port 6107 instead? › (Y/n)')).toBe(
      'Port 6106 is not available. Would you like to run Storybook on port 6107 instead? › (Y/n)',
    );
    expect(waitingForAnswer('info => Starting manager..\nLocal: http://localhost:6006/')).toBeUndefined();
  });

  it('stops and explains instead of hanging when a command asks a question', async () => {
    const d = new DevProcess('dev');
    const q = `node -e "process.stdout.write('? Install missing packages? (Y/n)'); setInterval(() => {}, 1000)"`;
    await expect(d.start(process.cwd(), q)).rejects.toThrow(/asks? a question|stopped to ask/);
    expect(d.proc).toBeUndefined();
  });
});
