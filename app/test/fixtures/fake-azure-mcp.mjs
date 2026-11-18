#!/usr/bin/env node
// A stand-in for the Azure DevOps MCP server (@azure-devops/mcp): the same stdio JSON-RPC protocol
// and tool names, with a small in-memory set of pull requests. Tests point DESIGNER_AZURE_MCP at it.
// The last argument is the organization, as with the real server. FAKE_AZURE_LOG records each call.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const org = process.argv[process.argv.length - 1];
const log = (o) => process.env.FAKE_AZURE_LOG && appendFileSync(process.env.FAKE_AZURE_LOG, JSON.stringify(o) + '\n');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
console.error(`fake azure mcp for ${org}`);
process.stdout.write('Azure DevOps MCP Server running on stdio\n'); // the real one logs a line like this too

const prs = [
  { pullRequestId: 42, title: 'Denser pricing cards', status: 'active', isDraft: false, createdBy: { displayName: 'Ada Lovelace' }, sourceRefName: 'refs/heads/design/pricing', targetRefName: 'refs/heads/main', creationDate: '2026-11-18T10:00:00Z' },
  { pullRequestId: 43, title: 'New sign-in screen', status: 'active', isDraft: true, createdBy: { displayName: 'Grace Hopper' }, sourceRefName: 'refs/heads/design/sign-in', targetRefName: 'refs/heads/main' },
];
const threads = {
  42: [
    { id: 7, status: 'active', threadContext: { filePath: '/src/Pricing.tsx', rightFileStart: { line: 12, offset: 1 } }, comments: [{ id: 1, author: { displayName: 'Ada Lovelace' }, content: 'Can the gap be 16px?', commentType: 'text', publishedDate: '2026-11-18T10:05:00Z' }] },
    { id: 8, status: 'active', comments: [{ id: 1, author: { displayName: 'Azure' }, content: 'Policy check passed', commentType: 'system' }] },
    { id: 9, status: 'fixed', comments: [{ id: 1, author: { displayName: 'Grace Hopper' }, content: 'Looks good overall', commentType: 'text' }] },
  ],
};

const tools = [
  'repo_get_repo_by_name_or_id',
  'repo_list_pull_requests_by_repo_or_project',
  'repo_list_pull_request_threads',
  'repo_reply_to_comment',
  'repo_create_pull_request_thread',
  'repo_resolve_comment',
  'wit_get_work_item',
].map((name) => ({ name, description: name, inputSchema: { type: 'object' } }));

function call(name, a) {
  log({ name, args: a });
  const repoOk = a.repositoryId === 'repo-guid-1';
  switch (name) {
    case 'repo_get_repo_by_name_or_id':
      if (a.repositoryNameOrId !== 'web') throw new Error('repository not found');
      return { id: 'repo-guid-1', name: 'web', project: { name: a.project } };
    case 'repo_list_pull_requests_by_repo_or_project':
      if (!repoOk) throw new Error('unknown repository ' + a.repositoryId);
      return prs;
    case 'repo_list_pull_request_threads':
      return threads[a.pullRequestId] ?? [];
    case 'repo_reply_to_comment': {
      const t = (threads[a.pullRequestId] ?? []).find((x) => x.id === a.threadId);
      if (!t) throw new Error('no thread');
      t.comments.push({ id: t.comments.length + 1, author: { displayName: 'Me' }, content: a.content, commentType: 'text' });
      return 'Comment successfully added to thread.';
    }
    case 'repo_create_pull_request_thread': {
      const list = (threads[a.pullRequestId] ??= []);
      const t = { id: 100 + list.length, status: 'active', comments: [{ id: 1, author: { displayName: 'Me' }, content: a.content, commentType: 'text' }] };
      list.push(t);
      return t;
    }
    case 'repo_resolve_comment': {
      const t = (threads[a.pullRequestId] ?? []).find((x) => x.id === a.threadId);
      t.status = a.status === 'Active' ? 'active' : 'fixed';
      return 'Thread updated.';
    }
    default:
      throw new Error('unknown tool ' + name);
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  const ok = (result) => out({ jsonrpc: '2.0', id: m.id, result });
  if (m.method === 'initialize') return ok({ protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'Azure DevOps MCP Server', version: 'fake' } });
  if (m.method === 'tools/list') return ok({ tools });
  if (m.method === 'tools/call') {
    try {
      const r = call(m.params.name, m.params.arguments ?? {});
      return ok({ content: [{ type: 'text', text: typeof r === 'string' ? r : JSON.stringify(r, null, 2) }] });
    } catch (e) {
      return ok({ content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
    }
  }
  out({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no method' } });
});
