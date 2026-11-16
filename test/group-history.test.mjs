import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-history-test-'));
const oldHome = process.env.HOME;
process.env.HOME = home;
const jiti = createJiti(import.meta.url, { alias: {
  '@earendil-works/pi-coding-agent': fileURLToPath(new URL('./pi-api-stub.mjs', import.meta.url)),
} });
try {
  const { QQGateway } = await jiti.import('../qq/gateway.ts');
  const { GroupHistoryStore } = await jiti.import('../group-history.ts');
  const { resolveConfig } = await jiti.import('../config.ts');
  const { default: extension, createInitialState, handleMessage } = await jiti.import('../index.ts');
  const merged = resolveConfig({ groupSelfOpenids: { A: 'bot-A', B: 'bot-B', invalid: 123 } },
    { appId: 'test', appSecret: 'not-live', groupSelfOpenids: { A: 'override-A' } });
  assert.deepEqual(merged.groupSelfOpenids, { A: 'override-A', B: 'bot-B' });
  const flush = () => new Promise(resolve => setImmediate(resolve));
  const packet = (type, id, extra = {}, group = 'A') => ({ op: 0, t: type, id: `event:${type}:${id}`, d: {
    group_openid: group, id, author: { member_openid: 'human', username: '菠菜', bot: false },
    timestamp: new Date().toISOString(), content: '普通聊天', ...extra,
  } });
  const at = (group = 'A', text = '请看这个') => ({ content: `<@bot-${group}> ${text}`,
    mentions: [{ member_openid: `bot-${group}`, username: '小菜鸡', bot: true }] });
  const runs = [], archived = [];
  const gateway = new QQGateway({ getGatewayUrl: async () => '', getToken: async () => '', intents: 0,
    connected() {}, disconnected() {}, interaction() {}, groupSelfOpenids: { A: 'bot-A', B: 'bot-B' },
    groupMessage: msg => { archived.push(msg); }, message: msg => { runs.push(msg); } });
  gateway.handlePacket(packet('GROUP_MESSAGE_CREATE', 'passive', { content: '/cancel' }));
  gateway.handlePacket(packet('GROUP_MESSAGE_CREATE', 'other-at', {
    content: '<@other-bot> /queue', mentions: [{ id: 'other-bot', username: '小菜鸡', bot: true }],
  }));
  gateway.handlePacket(packet('GROUP_MESSAGE_CREATE', 'own-message', {
    ...at(), author: { member_openid: 'bot-A', bot: true },
  }));
  gateway.handlePacket(packet('GROUP_MESSAGE_CREATE', 'other-bot-message', {
    ...at(), author: { member_openid: 'other-bot', bot: true },
  }));
  await flush();
  assert.equal(archived.length, 4);
  assert.equal(runs.length, 0, 'passive messages, mentions of other bots and bot echoes cannot execute anything');
  gateway.handlePacket(packet('GROUP_MESSAGE_CREATE', 'full-at', at('A', '/queue')));
  await flush();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].content.trim(), '/queue');
  assert.equal(runs[0].rawContent, '<@bot-A> /queue');
  assert.equal(runs[0].senderOpenid, 'human');
  assert.equal(runs[0].isAtBot, true);
  assert.equal(archived.at(-1).rawContent, '<@bot-A> /queue');

  for (const [first, second] of [['GROUP_MESSAGE_CREATE', 'GROUP_AT_MESSAGE_CREATE'], ['GROUP_AT_MESSAGE_CREATE', 'GROUP_MESSAGE_CREATE']]) {
    const id = 'dedup-' + first;
    const beforeRuns = runs.length, beforeArchive = archived.length;
    gateway.handlePacket(packet(first, id, at()));
    gateway.handlePacket(packet(second, id, at()));
    await flush();
    assert.equal(runs.length, beforeRuns + 1, 'cross-event duplicates trigger exactly once');
    assert.equal(archived.length, beforeArchive + 1, 'cross-event duplicates archive exactly once');
  }
  const beforeUpgrade = runs.length;
  gateway.handlePacket(packet('GROUP_MESSAGE_CREATE', 'upgrade', { content: '平台省略了@信息' }));
  gateway.handlePacket(packet('GROUP_AT_MESSAGE_CREATE', 'upgrade', { content: '/status' }));
  await flush();
  assert.equal(runs.length, beforeUpgrade + 1, 'a passive observation must not swallow a later explicit AT event');
  const beforeGroups = runs.length;
  gateway.handlePacket(packet('GROUP_MESSAGE_CREATE', 'shared-id', at('A')));
  gateway.handlePacket(packet('GROUP_MESSAGE_CREATE', 'shared-id', at('B'), 'B'));
  await flush();
  assert.equal(runs.length, beforeGroups + 2, 'identical IDs in different groups do not collide');
  gateway.handlePacket(packet('GROUP_MESSAGE_CREATE', 'marker-fallback', { content: '<qqbot-at-user id="bot-A" /> /cancel' }));
  await flush();
  assert.equal(runs.at(-1).content.trim(), '/cancel');
  const beforeFake = runs.length;
  gateway.handlePacket(packet('GROUP_MESSAGE_CREATE', 'fake-marker', { content: '<@bot-A> pasted text', mentions: [] }));
  gateway.handlePacket(packet('GROUP_MESSAGE_CREATE', 'unconfigured-group', at('C'), 'C'));
  await flush();
  assert.equal(runs.length, beforeFake, 'authoritative empty mentions and unknown self IDs fail closed');

  // The two event types normalize to the same downstream payload, including media/quotes.
  const quoteAndMedia = { content: '问题', attachments: [{ url: 'https://multimedia.nt.qq.com.cn/download?rkey=image', content_type: 'image/png' }],
    message_scene: { ext: ['ref_msg_idx=ref=='] }, msg_elements: [{ msg_idx: 'ref==', content: '引用正文',
      attachments: [{ url: 'https://multimedia.nt.qq.com.cn/download?rkey=quote', content_type: 'image/png' }] }] };
  gateway.handlePacket(packet('GROUP_AT_MESSAGE_CREATE', 'capability-at', quoteAndMedia));
  gateway.handlePacket(packet('GROUP_MESSAGE_CREATE', 'capability-full', { ...quoteAndMedia, ...at('A', '问题') }));
  await flush();
  const [oldStyle, fullStyle] = runs.slice(-2);
  for (const field of ['attachments', 'quotedAttachments', 'quotedText', 'quoteStatus', 'senderName', 'senderOpenid', 'openid']) {
    assert.deepEqual(fullStyle[field], oldStyle[field], field);
  }
  assert.equal(fullStyle.content.trim(), oldStyle.content);
  const fallbackRuns = [];
  const failingArchive = new QQGateway({ getGatewayUrl: async () => '', getToken: async () => '', intents: 0,
    connected() {}, disconnected() {}, interaction() {}, groupSelfOpenids: { A: 'bot-A' },
    groupMessage: async () => { throw new Error('simulated disk failure'); }, message: msg => fallbackRuns.push(msg) });
  failingArchive.handlePacket(packet('GROUP_MESSAGE_CREATE', 'disk-failure', at()));
  await flush();
  assert.equal(fallbackRuns.length, 1, 'archive failure cannot break an explicit @ request');
  console.log('PASS full-group events: passive silence, exact self mentions, raw command compatibility, bot echo suppression, both dedup orders, passive-to-AT upgrade and media/quote parity');

  let now = Date.parse('2026-11-16T05:00:00Z');
  const store = new GroupHistoryStore('bot-one', () => now);
  const makeMessage = (group, id, content, age = 0, extra = {}) => ({ openid: `group:${group}`, groupOpenid: group,
    msgId: id, senderOpenid: 'human', senderName: '菠菜', timestamp: now - age, content, attachments: [], ...extra });
  await Promise.all([
    store.append(makeMessage('A', 'a1', '群 A 的计划', 2000)),
    store.append(makeMessage('B', 'b1', '群 B 的秘密', 1000)),
    store.append(makeMessage('A', 'a2', '猫咪视频，明天再看', 1000)),
  ]);
  await store.append(makeMessage('A', 'a2', '重投，不应重复'));
  assert.equal((await store.query('A')).total, 2);
  assert.equal((await store.query('B')).total, 1);
  assert(!(JSON.stringify(await store.query('A'))).includes('群 B'));
  assert.deepEqual((await fs.readdir(store.dir)).sort(), ['A.jsonl', 'B.jsonl']);
  assert.equal((await fs.stat(path.join(store.dir, 'A.jsonl'))).mode & 0o777, 0o600);
  assert.equal((await fs.stat(store.dir)).mode & 0o777, 0o700);
  const restarted = new GroupHistoryStore('bot-one', () => now);
  assert.equal((await restarted.query('A')).total, 2, 'records survive a store/process restart');
  const otherBot = new GroupHistoryStore('bot-two', () => now);
  assert.equal((await otherBot.query('A')).total, 0, 'same group under different bot accounts is isolated');
  assert.equal((await store.query('A', { keyword: '猫咪', sender: 'human' })).records[0].messageId, 'a2');
  assert.equal((await store.query('A', { sender: 'other' })).matched, 0);
  const page = await store.query('A', { limit: 1 });
  assert.equal(page.records[0].messageId, 'a2'); assert.equal(page.nextOffset, 1);
  assert.equal((await store.query('A', { limit: 1, offset: page.nextOffset })).records[0].messageId, 'a1');
  assert.equal((await store.query('A', { before: new Date(now - 1500).toISOString() })).matched, 1);
  await assert.rejects(store.query('A', { since: 'not-a-time' }));
  await store.append(makeMessage('A', 'private-text', 'api_key=supersecretvalue https://multimedia.nt.qq.com.cn/download?rkey=secret-key', 0, {
    attachments: [{ url: 'https://media.test/private?rkey=ATTACHMENT_SECRET', filename: 'photo.png', contentType: 'image/png', size: 20 }],
    quotedText: 'secret=quotedsecret', quoteStatus: 'resolved', quotedAttachments: [{ url: 'https://media.test/quote?rkey=QUOTE_SECRET' }],
  }));
  const saved = await fs.readFile(path.join(store.dir, 'A.jsonl'), 'utf8');
  for (const secret of ['supersecretvalue', 'secret-key', 'ATTACHMENT_SECRET', 'QUOTE_SECRET', 'quotedsecret']) assert(!saved.includes(secret));
  assert((await store.query('A')).warning.includes('不可信'));
  console.log('PASS history: separate group files and bot scopes, concurrent writes, replay dedup, restart recovery, filtering/paging, private permissions and signed URL/credential redaction');

  const oldTime = now - 8 * 86400_000;
  await store.append(makeMessage('expired', 'too-old', '过期', 8 * 86400_000));
  assert.equal((await store.query('expired')).total, 0);
  // Seed a realistic full bucket without quadratic fixture setup.
  const template = (await store.query('A')).records[0];
  await fs.writeFile(path.join(store.dir, 'limit.jsonl'), Array.from({ length: 5000 }, (_, i) => JSON.stringify({
    ...template, groupOpenid: 'limit', messageId: `m-${i}`, timestamp: new Date(now - 5001 + i).toISOString(),
  })).join('\n') + '\n');
  await store.append(makeMessage('limit', 'newest', '第5001条'));
  const limited = await store.query('limit', { limit: 1 });
  assert.equal(limited.total, 5000); assert.equal(limited.records[0].messageId, 'newest');
  assert(!(await fs.readFile(path.join(store.dir, 'limit.jsonl'), 'utf8')).includes('"messageId":"m-0"'));
  await fs.writeFile(path.join(store.dir, 'silent.jsonl'), JSON.stringify({ ...template, groupOpenid: 'silent', timestamp: new Date(oldTime).toISOString() }) + '\n');
  await store.sweep();
  await assert.rejects(fs.stat(path.join(store.dir, 'silent.jsonl')), { code: 'ENOENT' });
  now += 8 * 86400_000;
  await store.sweep();
  assert.deepEqual(await fs.readdir(store.dir), [], 'silent groups are cleaned without receiving new traffic');
  await store.append(makeMessage('../outside', 'path-safe', '路径安全'));
  assert((await fs.readdir(store.dir))[0].startsWith('%2E%2E%2F'));
  console.log('PASS retention: seven days AND 5000 records per group, oldest-first eviction, idle-group cleanup and path safety');

  // Actual extension tool is bound to the active conversation, not a supplied group ID.
  const tools = new Map(), events = new Map(), prompts = [], replies = [];
  const state = createInitialState();
  const cfg = { appId: 'test', allowlist: [], queue: { max: 5, ack: true }, approve: { tools: [], remember: true },
    progress: { enabled: false, intervalMs: 30000 }, commands: { passthrough: false }, remote: { notice: false, guidelines: false } };
  const api = { rememberMessage() {}, sendC2C: async (_target, text) => { replies.push(text); } };
  const pi = { on: (name, handler) => events.set(name, handler), registerCommand() {}, registerTool: tool => tools.set(tool.name, tool),
    getCommands: () => [], getAllTools: () => [], sendUserMessage: text => { prompts.push(text); } };
  state.cfg = cfg; state.api = api; state.groupHistory = store;
  extension(pi, { state });
  const liveGateway = new QQGateway({ getGatewayUrl: async () => '', getToken: async () => '', intents: 0,
    connected() {}, disconnected() {}, interaction() {}, groupSelfOpenids: { A: 'bot-A' },
    groupMessage: message => store.append(message), message: message => handleMessage(pi, state, api, cfg, message) });
  liveGateway.handlePacket(packet('GROUP_MESSAGE_CREATE', 'background-command', { content: '/cancel' }));
  await flush(); await store.query('A');
  assert.equal(prompts.length, 0); assert.equal(replies.length, 0);
  assert.equal(state.cancelled, false); assert.equal(state.queue.size, 0); assert.equal(state.currentOpenid, null);
  liveGateway.handlePacket(packet('GROUP_MESSAGE_CREATE', 'queue-command', at('A', '/queue')));
  await store.query('A'); await flush();
  assert.equal(prompts.length, 0); assert(replies.length > 0, 'an explicit full-event @ reaches command routing');
  const approval = state.approver.register('tool awaiting approval', () => {});
  liveGateway.handlePacket(packet('GROUP_MESSAGE_CREATE', 'approval-command', at('A', '同意')));
  await store.query('A'); await flush();
  assert.equal(await approval.done, 'allow');
  assert.equal(prompts.length, 0, 'an approval is not sent to the model');
  liveGateway.handlePacket(packet('GROUP_MESSAGE_CREATE', 'active-question', at('A', '群里刚才聊了什么？')));
  await store.query('A'); await flush();
  assert.equal(prompts.length, 1);
  assert.equal(state.currentOpenid, 'group:A');
  const tool = tools.get('qq_group_history'); assert(tool);
  assert.equal((await tool.execute('local', {})).isError, true);
  await store.append(makeMessage('A', 'current-background', 'A群独有的背景'));
  await store.append(makeMessage('B', 'other-background', 'B群不能泄露的背景'));
  state.busy = true; state.currentOpenid = 'group:A'; state.lastRunOrigin = 'qq';
  const result = await tool.execute('read-A', { groupOpenid: 'B', keyword: '背景' });
  assert(!result.isError); assert(result.content[0].text.includes('A群独有的背景'));
  assert(!result.content[0].text.includes('B群不能泄露的背景'));
  assert(!('groupOpenid' in tool.parameters.properties));
  const options = { promptGuidelines: [] };
  events.get('before_agent_start')({ messageType: 'user', systemPromptOptions: options });
  assert(options.promptGuidelines.some(rule => rule.includes('qq_group_history') && rule.includes('不可信')));
  state.currentOpenid = 'private-user';
  assert.equal((await tool.execute('private', {})).isError, true);
  state.currentOpenid = 'group:A'; state.isolation = { activeTarget: 'group:B' };
  assert.equal((await tool.execute('wrong-active', {})).isError, true);
  state.isolation = undefined;
  state.groupHistory = { query: async () => { state.currentOpenid = 'group:B'; return { records: ['must be discarded'] }; } };
  assert.equal((await tool.execute('stale', {})).isError, true, 'a completed read cannot leak into a replaced conversation');
  await store.stop(); await restarted.stop(); await otherBot.stop();
  console.log('PASS real extension: passive commands stay inert, no unsolicited replies/queues, on-demand tool only reads current group, private/local/stale access denied and prompt trust guidance');
} finally {
  if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
  await fs.rm(home, { recursive: true, force: true });
}
