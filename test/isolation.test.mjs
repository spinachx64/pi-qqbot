import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';
const home=fs.mkdtempSync(path.join(os.tmpdir(),'qq-isolation-test-'));
const previousHome=process.env.HOME;process.env.HOME=home;
const jiti=createJiti(import.meta.url,{alias:{'@earendil-works/pi-coding-agent':fileURLToPath(new URL('./pi-api-stub.mjs',import.meta.url))}});
const waitFor=async(predicate)=>{for(let i=0;i<200;i++){if(predicate())return;await new Promise(r=>setTimeout(r,5));}throw new Error('Timed out waiting for scheduler');};
try{
 const {default:extension,createInitialState}=await jiti.import('../index.ts');
 const {IsolationHub}=await jiti.import('../isolation.ts');
 const {QQApi}=await jiti.import('../qq/api.ts');
 const {parseQuote}=await jiti.import('../qq/quote.ts');
 const {GroupHistoryStore}=await jiti.import('../group-history.ts');
 const sends=[],runs=[],histories=new Map(),runtimes=[],modelSelections=[],imageRequests=[];
 const cfg={allowlist:[],queue:{max:5,ack:true},approve:{tools:[],remember:true},progress:{enabled:false,intervalMs:30000},commands:{passthrough:false},markdownReply:false,appId:'test-bot'};
 const api=new QQApi({restBase:'https://qq.test',getToken:async()=> 'fake',fetchFn:async(url,o)=>{sends.push({url,body:JSON.parse(o.body)});return Response.json({});}});
 const hub=new IsolationHub(createInitialState,home);
 let fileCounter=0,current;
 function bind(file=path.join(home,'old-mixed-session.jsonl')){
  let valid=true;
  let runtimeModel={provider:file.includes("old-mixed")?"working-provider":"builtin-provider",id:"model"};
  const state=hub.stateFor(hub.nextTarget??hub.activeTarget);
  state.attachmentFetch=async url=>{imageRequests.push(url);return new Response(Buffer.from('isolated-image'),{headers:{'content-type':'image/png'}});};
  const events=new Map(),commands=new Map();
  const assertFresh=()=>{if(!valid)throw new Error('OLD RUNTIME USED');};
  const pi={setModel:async model=>{assertFresh();runtimeModel=model;modelSelections.push(model);return true;},on:(n,f)=>events.set(n,f),registerCommand:(n,c)=>commands.set(n,c),registerTool(){},getCommands:()=>[],getAllTools:()=>[],
   sendUserMessage:async(text,options)=>{assertFresh();if(text.startsWith('/qq_dispatch ')){assert.equal(options?.expandPromptTemplates,true,'internal command must not become model input');return commands.get('qq_dispatch').handler(text.split(' ')[1],ctx);}
    if(text.startsWith('/qq '))return commands.get('qq').handler(text.slice(4),ctx);
    const history=histories.get(file)??[];runs.push({target:hub.activeTarget,file,text,history:[...history]});history.push(text);histories.set(file,history);
    fs.writeFileSync(file,JSON.stringify(history));
   }};
  const ctx={sessionManager:{getSessionFile:()=>{assertFresh();return file;}},waitForIdle:async()=>{assertFresh();},
   newSession:async options=>{assertFresh();hub.beforeShutdown('new');valid=false;const fresh=bind(path.join(home,`session-${++fileCounter}.jsonl`));await events.get('noop')?.();hub.started(fresh.ctx);await options?.withSession?.(fresh.ctx);return{cancelled:false};},
   switchSession:async (next,options)=>{assertFresh();hub.beforeShutdown('resume');valid=false;const fresh=bind(next);hub.started(fresh.ctx);await options?.withSession?.(fresh.ctx);return{cancelled:false};},
   abort:()=>{assertFresh();state.cancelled=true;},get model(){assertFresh();return runtimeModel;}};
  extension(pi,{state,isolationHub:hub});
  const runtime={pi,ctx,state,events,file,invalidate:()=>{valid=false;}};runtimes.push(runtime);current=runtime;return runtime;
 }
 const initial=bind();
 const groupHistory=new GroupHistoryStore('test-bot');initial.state.groupHistory=groupHistory;
 initial.state.cfg=cfg;initial.state.api=api;initial.state.account={name:'test',appId:'test-bot'};initial.state.registryCtx=initial.ctx;
 hub.captureTransport(initial.state);
 const msg=(target,id,content,metadata={})=>({openid:target,senderOpenid:'member-'+target,msgId:id,content,attachments:[],...metadata});
 const quote=(text)=>parseQuote({message_scene:{ext:['ref_msg_idx=shared-reference==']},msg_elements:[{msg_idx:'shared-reference==',content:text}]});
 const imageQuote=(text,group)=>parseQuote({message_scene:{ext:['ref_msg_idx=shared-reference==']},msg_elements:[{msg_idx:'shared-reference==',content:text,
  attachments:[{url:`https://multimedia.nt.qq.com.cn/download?rkey=signature-${group}`,content_type:'image/png',filename:'image.png'}]}]});
 await hub.receive(msg('group:A','a1','secret-A',{senderName:'同昵称',senderOpenid:'member-A-one',...quote('仅属于群 A 的引用')}));
 await waitFor(()=>runs.length===1);
 assert.equal(runs[0].target,'group:A');assert.deepEqual(runs[0].history,[]);
 assert.notEqual(runs[0].file,initial.file,'mixed history must not be adopted');
 const aState=hub.stateFor('group:A');aState.approver.setAutoAllow(true);
 const beforeRollRuntimes=runtimes.length;
 for(const target of ['group:A','group:B']){
  await hub.receive(msg(target,'roll-'+target,'/roll',{senderName:'阿强'}));
  assert.match(sends.at(-1).body.content,/^阿强掷出了([1-9]|[1-9]\d|100)\(1-100\)$/);
  assert.equal(sends.at(-1).url,'https://qq.test/v2/groups/'+target.slice(6)+'/messages');
  assert.equal(sends.at(-1).body.msg_id,'roll-'+target);
  assert.equal(hub.stateFor(target).queue.size,0,'roll bypasses isolation queues in active and inactive groups');
 }
 assert.equal(runs.length,1);assert.equal(runtimes.length,beforeRollRuntimes,'roll never switches sessions');
 assert.equal(hub.activeTarget,'group:A');assert.equal(aState.busy,true);assert.equal(aState.approver.autoAllowed,true);
 await hub.receive(msg('group:B','b1','secret-B',{senderName:'同昵称',senderOpenid:'member-B-one',...quote('将被取消的群 B 引用')}));
 await hub.receive(msg('private-C','c1','secret-C'));
 await hub.receive(msg('group:A','a2','remember A',{senderName:'同昵称',senderOpenid:'member-A-two',...imageQuote('群 A 的第二条引用','A')}));
 assert.equal(aState.queue.size,1);assert.equal(hub.stateFor('group:B').queue.size,1);
 const rawA=aState.queue.list()[0].rawMessage;
 assert.equal(rawA.content,'remember A','IsolationHub retains raw control/routing text');
 assert.equal(rawA.senderName,'同昵称');assert.equal(rawA.senderOpenid,'member-A-two');
 assert.equal(rawA.refMsgIdx,'shared-reference==');assert.equal(rawA.quotedText,'群 A 的第二条引用');
 assert.equal(rawA.quotedAttachments[0].url,'https://multimedia.nt.qq.com.cn/download?rkey=signature-A');
 assert.equal(imageRequests.length,0,'queued rawMessage does not download before its conversation is dispatched');
 assert.equal(aState.queue.list()[0].text,'remember A','augmentation is deferred until handleMessage');
 // /queue and /cancel on B must not touch running A or queued C.
 await hub.receive(msg('group:B','bq','  /queue',{senderName:'同昵称',...quote('/cancel')}));
 assert(sends.at(-1).body.content.includes('secret-B'));
 assert(!sends.at(-1).body.content.includes('secret-A'));
 await hub.receive(msg('group:B','bc','/cancel',{senderName:'同昵称',...quote('不应被转给模型的引用')}));
 assert.equal(hub.stateFor('group:B').queue.size,0);assert.equal(aState.busy,true);assert.equal(hub.stateFor('private-C').queue.size,1);
 assert.equal(aState.cancelled,false);
 await hub.receive(msg('group:B','b2','secret-B-new',{senderName:'同昵称',senderOpenid:'member-B-two',...imageQuote('只属于群 B 的新引用','B')}));
 const settle=async answer=>{current.state.replyBuffer.append(answer);await current.events.get('agent_settled')();};
 await settle('answer-A');await waitFor(()=>runs.length===2);
 assert.equal(runs[1].target,'group:B');assert.deepEqual(runs[1].history,[]);
 assert(runs[1].text.includes('成员ID："member-B-two"'));assert(runs[1].text.includes('只属于群 B 的新引用'));
 assert(!runs[1].text.includes('群 A 的引用'));assert(!runs[1].text.includes('将被取消的群 B 引用'));
 assert.deepEqual(imageRequests,['https://multimedia.nt.qq.com.cn/download?rkey=signature-B']);
 const bImage=/^引用图片路径 (.+)$/m.exec(runs[1].text)?.[1];assert(bImage);assert(fs.existsSync(bImage));
 assert(!runs[1].text.includes('rkey='));
 assert.equal(current.state.approver.autoAllowed,false,'approval settings are not shared');
 assert.equal(current.state.groupHistory,groupHistory,'the bound history source survives a group session replacement');
 await settle('answer-B');await waitFor(()=>runs.length===3);
 assert.equal(runs[2].target,'private-C');assert.deepEqual(runs[2].history,[]);assert.equal(runs[2].text,'secret-C');
 await settle('answer-C');await waitFor(()=>runs.length===4);
 assert.equal(runs[3].target,'group:A');assert.equal(runs[3].history.length,1);
 assert(runs[3].history[0].includes('仅属于群 A 的引用'));assert(runs[3].history[0].includes('成员ID："member-A-one"'));
 assert(runs[3].text.includes('群 A 的第二条引用'));assert(runs[3].text.includes('成员ID："member-A-two"'));
 assert(!runs[3].text.includes('群 B'));assert(!runs[3].history[0].includes('群 B'));
 const aImage=/^引用图片路径 (.+)$/m.exec(runs[3].text)?.[1];assert(aImage);assert(fs.existsSync(aImage));
 assert.notEqual(aImage,bImage);assert(!runs[3].text.includes(bImage));assert(!runs[3].text.includes('rkey='));
 assert.deepEqual(imageRequests,['https://multimedia.nt.qq.com.cn/download?rkey=signature-B','https://multimedia.nt.qq.com.cn/download?rkey=signature-A']);
 assert.equal(runs[3].text.split('[QQ群消息]').length-1,1,'rawMessage route does not double-wrap input');
 assert.equal(runs[3].file,runs[0].file,'same group resumes its existing history');
 assert.equal(current.state.approver.autoAllowed,true,'group-specific approval state preserved');
 assert.equal(hub.stateFor('group:A'),aState);
 assert.equal(current.state.groupHistory,groupHistory,'history source remains available when resuming group A');
 assert.equal(new Set(runs.slice(0,3).map(r=>r.file)).size,3);
 await settle('answer-A2');
 console.log('PASS real handlers: distinct group/private histories, round-robin serial execution, fresh runtime binding');
 console.log('PASS queue views, cancellation, approval memory and queued work remain conversation-local');
 console.log('PASS rawMessage deferral preserves names and quotes; same-named members and shared ref indices do not mix across groups');
 console.log('PASS quoted images download after conversation dispatch and retain separate paths across groups');

 const store=path.join(home,'.pi/agent/qq-isolation');
 const index=JSON.parse(fs.readFileSync(path.join(store,fs.readdirSync(store)[0],'sessions.json'),'utf8'));
 assert.equal(index.sessions['group:A'],runs[0].file);
 assert.equal(index.sessions['group:B'],runs[1].file);
 assert.equal(index.sessions['private-C'],runs[2].file);
 assert(!Object.values(index.sessions).includes(initial.file));
 assert.equal(modelSelections.length,3);assert(modelSelections.every(m=>m.provider==='working-provider'));
 console.log('PASS durable index, mixed history excluded, new chats inherit the working model');

 // Restart-like hub: no active owner, but previous file for A must be resumed.
 const replacement=new IsolationHub(createInitialState,home);
 const local=replacement.stateFor(null);local.cfg=cfg;local.api=api;local.account={name:'test',appId:'test-bot'};
 let issued,switched;
 replacement.bind({sendUserMessage:async text=>{issued=text.split(' ')[1];}},local,{
  handle:async(_pi,s,message)=>{assert.equal(message.openid,'group:A');s.busy=true;},start(){},control:()=>false,reply:async()=>{},interaction:()=>false});
 replacement.captureTransport(local);
 await replacement.receive(msg('group:A','restart-a','after restart'));await waitFor(()=>issued);
 await replacement.dispatch(issued,{waitForIdle:async()=>{},switchSession:async(file,o)=>{
  switched=file;const s=replacement.stateFor('group:A');replacement.bind({},s,{handle:async()=>{},start(){},control:()=>false,reply:async()=>{},interaction:()=>false});
  replacement.started({sessionManager:{getSessionFile:()=>file}});await o.withSession({sessionManager:{getSessionFile:()=>file}});return{cancelled:false};},newSession:async()=>{throw new Error('Must resume saved A');}});
 assert.equal(switched,runs[0].file);
 console.log('PASS restart restores the correct conversation file');

 await hub.receive(msg('group:A','blocked-resume','/resume'));
 await waitFor(()=>sends.some(s=>s.body.content?.includes('跨会话历史')));
 assert.equal(runs.length,4,'history browsing command never reaches a model');
 console.log('PASS cross-session history selection is blocked');
 // Failure to switch must never run a queued message in the previous history.
 const failing=new IsolationHub(createInitialState,path.join(home,'fail'));
 const local2=failing.stateFor(null);local2.cfg=cfg;local2.api=api;local2.account={name:'test',appId:'test-bot'};
 let failureToken,executed=false;
 failing.bind({sendUserMessage:async t=>{failureToken=t.split(' ')[1];}},local2,{handle:async()=>{executed=true;},start(){},control:()=>false,reply:async()=>{},interaction:()=>false});
 failing.captureTransport(local2);await failing.receive(msg('group:X','fail-x','private X'));
 await waitFor(()=>failureToken);
 await failing.dispatch(failureToken,{waitForIdle:async()=>{},newSession:async()=>({cancelled:true})});
 assert.equal(executed,false);
 console.log('PASS cancelled switch fails closed without using another conversation');
 hub.beforeShutdown('quit');replacement.beforeShutdown('quit');failing.beforeShutdown('quit');
 await groupHistory.stop();
 console.log('All isolation regression checks passed; no live QQ or model requests.');
}finally{if(previousHome===undefined)delete process.env.HOME;else process.env.HOME=previousHome;fs.rmSync(home,{recursive:true,force:true});}
