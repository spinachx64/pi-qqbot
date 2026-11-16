import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-qqbot-group-test-'));
const oldHome = process.env.HOME;
process.env.HOME = temporary;
const jiti = createJiti(import.meta.url, { alias: {
  '@earendil-works/pi-coding-agent': fileURLToPath(new URL('./pi-api-stub.mjs', import.meta.url)),
}});
try {
  const { QQGateway } = await jiti.import('../qq/gateway.ts');
  const { QQApi } = await jiti.import('../qq/api.ts');
  const { uploadRichMedia } = await jiti.import('../qq/upload.ts');
  const { default: extension, createInitialState, handleMessage, handleInteraction } = await jiti.import('../index.ts');
  const { MAX_REPLIES_PER_MSG_ID } = await jiti.import('../constants.ts');
  const calls = [];
  const api = new QQApi({ restBase: 'https://qq.test', getToken: async () => 'fake-token',
    fetchFn: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return new Response('{}', { status: 200 });
    },
  });
  const cfg = { allowlist: [], queue: { max: 5, ack: true }, approve: { tools: [], remember: true },
    progress: { enabled: false, intervalMs: 30000 }, commands: { passthrough: false }, markdownReply: false };
  const events = new Map();
  const prompts = [];
  const pi = { on: (name, fn) => events.set(name, fn), registerCommand() {}, registerTool() {},
    sendUserMessage: text => { prompts.push(text); }, getCommands: () => [], getAllTools: () => [] };
  const state = createInitialState();
  state.cfg = cfg; state.api = api;
  extension(pi, { state });
  const received = [];
  const gateway = new QQGateway({ getGatewayUrl: async () => '', getToken: async () => '', intents: 0,
    connected() {}, disconnected() {}, interaction() {}, message: msg => received.push(msg) });
  const frame = (group, id, text = '  你好') => ({ op: 0, t: 'GROUP_AT_MESSAGE_CREATE', s: 1,
    d: { group_openid: group, author: { member_openid: 'member-1' }, id, content: text,
      attachments: [{ url: 'https://files.test/a.png?rkey=temporary', content_type: 'image/png' }] } });
  gateway.handlePacket(frame('group-a', 'message-a'));
  gateway.handlePacket(frame('group-a', 'message-a'));
  assert.equal(received.length, 1, 'duplicate gateway event ignored');
  assert.equal(received[0].openid, 'group:group-a');
  assert.equal(received[0].senderOpenid, 'member-1');
  assert.equal(received[0].content, '你好');
  assert.equal(received[0].attachments.length, 1);
  gateway.handlePacket({ op: 0, t: 'GROUP_AT_MESSAGE_CREATE', d: { id: 'bad', author: { member_openid: 'm' } } });
  assert.equal(received.length, 1, 'malformed group frame ignored');
  gateway.handlePacket({ op: 0, t: 'C2C_MESSAGE_CREATE', d: { id: 'private-msg', author: { user_openid: 'private-user' }, content: 'hi' } });
  assert.equal(received[1].openid, 'private-user');
  assert.equal(received[1].groupOpenid, undefined);
  console.log('PASS gateway: group/private parsing, attachments, duplicate/malformed events');

  const msg = (target, id, content = 'hello') => ({ openid: target, senderOpenid: 'member-1', msgId: id, content, attachments: [] });
  await handleMessage(pi, state, api, cfg, msg('group:group-a', 'message-a'));
  assert.equal(state.currentOpenid, 'group:group-a');
  assert.equal(prompts.at(-1), 'hello');
  state.replyBuffer.append('answer A');
  await handleMessage(pi, state, api, cfg, msg('group:group-b', 'message-b', 'second task'));
  assert.equal(state.queue.size, 1);
  await events.get('agent_settled')();
  const a = calls.find(c => c.body.content === 'answer A');
  assert.equal(a.url, 'https://qq.test/v2/groups/group-a/messages');
  assert.equal(a.body.msg_id, 'message-a');
  assert.equal(state.currentOpenid, 'group:group-b');
  state.replyBuffer.append('answer B');
  await events.get('agent_settled')();
  const b = calls.find(c => c.body.content === 'answer B');
  assert.equal(b.url, 'https://qq.test/v2/groups/group-b/messages');
  assert.equal(b.body.msg_id, 'message-b');
  assert(!calls.some(c => c.url.includes('/users/group')));
  assert(!calls.some(c => c.body.content?.includes('收到，正在处理')));
  console.log('PASS integration: group dispatch, final passive reply, interleaved group queue routing, receipt stays off');

  const before = prompts.length;
  await handleMessage(pi, state, api, { ...cfg, allowlist: ['different-member'] }, msg('group:group-c', 'blocked'));
  assert.equal(prompts.length, before);
  await handleMessage(pi, state, api, { ...cfg, allowlist: ['member-1'] }, msg('group:group-c', 'allowed'));
  assert.equal(prompts.length, before + 1);
  state.replyBuffer.append('allowed answer');
  await events.get('agent_settled')();
  console.log('PASS group allowlist validates member identity, not group target');

  api.rememberMessage('group:media-group', 'media-msg');
  await api.sendC2CMedia('group:media-group', 'fake-media-info');
  assert.equal(calls.at(-1).url, 'https://qq.test/v2/groups/media-group/messages');
  assert.equal(calls.at(-1).body.msg_type, 7);
  assert.equal(calls.at(-1).body.msg_id, 'media-msg');
  api.rememberMessage('private-user', 'private-msg');
  await api.sendC2C('private-user', 'private answer');
  assert.equal(calls.at(-1).url, 'https://qq.test/v2/users/private-user/messages');
  assert.equal(calls.at(-1).body.msg_id, 'private-msg');
  console.log('PASS private compatibility and group media send');

  api.rememberMessage('group:expired', 'old-msg', Date.now() - 301000);
  const count = calls.length;
  await assert.rejects(api.sendC2C('group:expired', 'late'), /窗口已过期/);
  assert.equal(calls.length, count, 'expired groups never fall back to active or private sends');
  api.rememberMessage('group:quota', 'quota-msg');
  for (let i = 0; i < MAX_REPLIES_PER_MSG_ID; i++) await api.sendC2C('group:quota', `reply ${i}`);
  assert.equal(api.remainingReplies('group:quota'), 0);
  await assert.rejects(api.sendC2C('group:quota', 'extra'), /次数已用尽/);
  api.rememberMessage('group:quota', 'new-quota-msg');
  await api.sendC2C('group:quota', 'new request');
  assert.equal(calls.at(-1).body.msg_seq, 1);
  console.log('PASS group expiry, quota, and queue recovery after rejected sends');

  state.currentOpenid = 'group:approval-group';
  api.rememberMessage('group:approval-group', 'approval-msg');
  const pending = state.approver.register('test tool', () => {});
  const button = { group_openid: 'approval-group', group_member_openid: 'member-1',
    data: { resolved: { button_data: JSON.stringify({ t: 'approval', d: 'allow', s: pending.seq }) } } };
  assert.equal(handleInteraction(pi, state, { ...button, group_openid: 'wrong-group' }), false);
  assert.equal(handleInteraction(pi, state, button), true);
  assert.equal(await pending.done, 'allow');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(calls.at(-1).url, 'https://qq.test/v2/groups/approval-group/messages');
  console.log('PASS group interaction routes to the group and rejects other conversation approvals');

  const uploadCalls = [];
  const mediaFile = path.join(temporary, 'tiny.png'); fs.writeFileSync(mediaFile, 'tiny');
  const uploaded = await uploadRichMedia({ restBase: 'https://qq.test', openid: 'group:upload-group',
    getToken: async () => 'fake', filePath: mediaFile,
    fetchFn: async (url, options) => {
      uploadCalls.push(url);
      if (url.endsWith('/upload_prepare')) return Response.json({ upload_id: 'upload-1', block_size: 4,
        parts: [{ index: 0, block_size: 4, presigned_url: 'https://storage.test/part' }] });
      if (url.endsWith('/files')) return Response.json({ file_info: 'group-file-info', ttl: 60 });
      return Response.json({});
    } });
  assert.equal(uploaded.fileInfo, 'group-file-info');
  assert(uploadCalls.filter(u => u.startsWith('https://qq.test')).every(u => u.startsWith('https://qq.test/v2/groups/upload-group/')));
  console.log('PASS group upload prepare/part finish/files endpoints');

  await handleMessage(pi, state, api, cfg, msg('group:log-group', 'log-msg', 'x'.repeat(250) + '\napi_key=supersecretvalue'));
  const logDir = path.join(temporary, 'data/logs');
  const entries = fs.readdirSync(logDir).filter(f => f.endsWith('.jsonl')).flatMap(f => fs.readFileSync(path.join(logDir, f), 'utf8').trim().split('\n').map(JSON.parse));
  const logged = entries.find(e => e.messageId === 'log-msg');
  assert(logged.content.includes('x'.repeat(250)), 'conversation text is not truncated');
  assert(!logged.content.includes('supersecretvalue'), 'sensitive text is redacted');
  assert(entries.some(e => e.direction === 'out' && e.content === 'answer A'));
  assert(!JSON.stringify(entries).includes('fake-media-info'));
  console.log('PASS daily full conversation logs, secret redaction, successful outgoing replies');
  console.log('All group regression checks passed. No live QQ/model requests made.');
} finally {
  if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
  fs.rmSync(temporary, { recursive: true, force: true });
}
