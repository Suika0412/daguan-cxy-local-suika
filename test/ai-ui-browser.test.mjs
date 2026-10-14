import { listenHttp } from './http-fixture.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
let playwright;try {playwright=createRequire(import.meta.url)(process.env.DAGUAN_PLAYWRIGHT_MODULE || 'playwright');}catch{}
async function port(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const n=s.address().port;await new Promise(r=>s.close(r));return n>=12000?n:port();}
async function fixture(t){
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'daguan-ai-ui-'));const n=await port();
 const service=spawn(process.execPath,[path.join(ROOT,'local-server/server.mjs')],{cwd:ROOT,env:{...process.env,PORT:String(n),DAGUAN_DATA_DIR:path.join(temp,'data'),DAGUAN_OPEN_BROWSER:'0'},windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});
 t.after(async()=>{if(service.exitCode==null){service.send({type:'shutdown'});await Promise.race([once(service,'close'),new Promise(r=>setTimeout(r,3000))]);if(service.exitCode==null)service.kill();}await fs.rm(temp,{recursive:true,force:true});});
 const base=`http://127.0.0.1:${n}`;
 let healthy=false;for(let i=0;i<100;i++){try{if((await fetch(base+'/api/health')).ok){healthy=true;break;}}catch{}await new Promise(r=>setTimeout(r,50));}
 assert.ok(healthy,'temporary service starts');return {base,temp};
}
const skip=!playwright && 'Install Playwright or set DAGUAN_PLAYWRIGHT_MODULE';

test('AI 配置真实交互：新增、模型、测试、Key 保留、流式设置和旧版共享', {skip,timeout:60000},async t=>{
 const {base}=await fixture(t);
 const chatCalls=[];
 const upstream=http.createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');
  if(req.url.endsWith('/models')){res.end(JSON.stringify({data:[{id:'math-model'},{id:'vision-model'}]}));return;}
  let raw='';for await(const chunk of req) raw+=chunk;chatCalls.push(JSON.parse(raw));await new Promise(r=>setTimeout(r,350));res.end(JSON.stringify({choices:[{message:{content:'<think>秘密</think>测试通过'}}]}));
 });await listenHttp(upstream);
 t.after(()=>new Promise(r=>{upstream.closeAllConnections();upstream.close(r);}));
 const browser=await playwright.chromium.launch({headless:true, ...(process.env.DAGUAN_CHROMIUM_EXECUTABLE ? {executablePath:process.env.DAGUAN_CHROMIUM_EXECUTABLE} : {})});t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:1280,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/state/events',route=>route.abort());await page.goto(base+'/index.html?ui=new');await page.waitForLoadState('networkidle');await page.waitForFunction('AppState.categories');
 await page.evaluate(()=>App.showSettings());
 const host=page.locator('#ai-services-settings');await host.getByRole('button',{name:'新增服务',exact:true}).click();
 const form=host.locator('form');await form.locator('[name=name]').fill('我的测试 API');await form.locator('[name=baseUrl]').fill(`http://127.0.0.1:${upstream.address().port}/v1`);await form.locator('[name=key]').fill('test-only-key');
 await form.getByRole('button',{name:'保存服务',exact:true}).click();await host.locator('[data-status]').filter({hasText:'服务已保存'}).waitFor();
 await form.locator('[name=baseUrl]').fill('file:///invalid-api');await form.getByRole('button',{name:'保存服务',exact:true}).click();await host.locator('[data-status]').filter({hasText:'只支持 HTTP'}).waitFor();
 assert.equal(await form.locator('[name=name]').inputValue(),'我的测试 API');assert.equal(await form.locator('[name=baseUrl]').inputValue(),'file:///invalid-api');
 await form.locator('[name=baseUrl]').fill(`http://127.0.0.1:${upstream.address().port}/v1`);
 await form.getByRole('button',{name:'获取模型列表',exact:true}).click();await host.locator('[data-status]').filter({hasText:'已获取 2 个模型'}).waitFor();
 assert.equal(await form.locator('datalist option').count(),2);
 await form.locator('[name=model]').fill('math-model');
 await form.getByRole('button',{name:'文本连接测试',exact:true}).click();await host.locator('[data-status]').filter({hasText:'请先保存当前配置'}).waitFor();await form.locator('[name=streaming]').uncheck();await form.getByRole('button',{name:'保存服务',exact:true}).click();await host.locator('[data-status]').filter({hasText:'服务已保存'}).waitFor();
 await form.getByRole('button',{name:'文本连接测试',exact:true}).click();await host.locator('[data-status]').filter({hasText:'文本连接测试通过'}).waitFor();
 await form.getByRole('button',{name:'图片能力测试',exact:true}).click();await host.locator('[data-status]').filter({hasText:'图片能力测试通过'}).waitFor();
 assert.doesNotMatch(await host.innerText(),/秘密|test-only-key/);
 await page.evaluate(async()=>{AppState.currentCategory=AppState.categories.categories.find(n=>UIRenderer.findNodeById(n,331));await App.enterChapterQuestions(UIRenderer.findNodeById(AppState.currentCategory,331));App.toggleAI();});
 assert.equal(await page.locator('#ai-streaming-new').isChecked(),false);
 await page.locator('#ai-input').fill('请讲解');await page.locator('#ai-send-btn').click();
 assert.equal(await page.locator('#ai-profile-select-new').isDisabled(),true);assert.equal(await page.locator('#ai-streaming-new').isDisabled(),true);
 await page.waitForFunction('!AppState.aiBusy');assert.equal(chatCalls.at(-1).stream,false);assert.doesNotMatch(await page.locator('#ai-messages').innerText(),/秘密/);
 if(!await page.locator('#ai-streaming-new').isVisible()) await page.locator('#ai-settings-btn').click();
 await page.locator('#ai-streaming-new').check();await page.waitForFunction('AIService.activeProfile().streaming === true');
 await page.evaluate(()=>App.showSettings());
 await host.getByRole('button',{name:'新增服务',exact:true}).click();assert.equal(await form.locator('[name=name]').inputValue(),'');
 await form.locator('[name=name]').fill('第二个服务');await form.locator('[name=baseUrl]').fill(`http://127.0.0.1:${upstream.address().port}/v1`);await form.locator('[name=model]').fill('vision-model');await form.getByRole('button',{name:'保存服务',exact:true}).click();await host.locator('[data-status]').filter({hasText:'服务已保存'}).waitFor();
 assert.equal((await(await fetch(base+'/api/ai/profiles')).json()).profiles.length,2);
 await page.goto(base+'/legacy.html?ui=old');await page.waitForLoadState('networkidle');await page.waitForSelector('#ai-services-settings .ai-service-item',{state:'attached'});
 await page.evaluate(()=>document.getElementById('dlg-appearance').showModal());
 const old=page.locator('#ai-services-settings');assert.equal(await old.locator('.ai-service-item').count(),2);
 await old.locator('.ai-service-item').filter({hasText:'我的测试 API'}).getByRole('button',{name:'编辑',exact:true}).click();
 assert.equal(await old.locator('[name=model]').inputValue(),'math-model');assert.equal(await old.locator('[name=streaming]').isChecked(),true);
 assert.equal(await old.locator('[name=key]').inputValue(),'');assert.equal(errors.length,0,errors.join('\n'));
});

test('单题和连续模式：长回答独立滚动，拖宽不丢草稿，批注与小屏没有外层空白', {skip,timeout:60000},async t=>{
 const {base}=await fixture(t);const browser=await playwright.chromium.launch({headless:true, ...(process.env.DAGUAN_CHROMIUM_EXECUTABLE ? {executablePath:process.env.DAGUAN_CHROMIUM_EXECUTABLE} : {})});t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:1280,height:900}});await page.route('**/api/state/events',route=>route.abort());await page.goto(base+'/index.html?ui=new');await page.waitForLoadState('networkidle');await page.waitForFunction('AppState.categories');
 await page.evaluate(async()=>{AppState.currentCategory=AppState.categories.categories.find(n=>UIRenderer.findNodeById(n,331));await App.enterChapterQuestions(UIRenderer.findNodeById(AppState.currentCategory,331));App.toggleAI();});
 await page.locator('#ai-input').fill('我的草稿');
 await page.evaluate(()=>{document.getElementById('ai-messages').innerHTML='<div class="ai-message assistant"><div class="ai-message-bubble">'+Array.from({length:100},(_,i)=>`<p>解题步骤 ${i}</p>`).join('')+renderMarkdown('$$'+Array.from({length:60},(_,i)=>'x_{'+i+'}').join('+')+'$$')+'</div></div>';});
 const handle=page.locator('.ai-panel-resize');await handle.focus();await handle.press('End');
 const maxWidth=await page.locator('#app-main').evaluate(e=>Math.round(e.getBoundingClientRect().width-360));assert.equal(Number(await handle.getAttribute('aria-valuenow')),maxWidth);assert.ok(maxWidth>620);
 const box=await handle.boundingBox();await page.mouse.move(box.x+3,box.y+50);await page.mouse.down();await page.mouse.move(box.x+103,box.y+50);await page.mouse.up();
 assert.equal(Number(await handle.getAttribute('aria-valuenow')),maxWidth-100);assert.equal(await page.locator('#ai-input').inputValue(),'我的草稿');
 const heights=await page.evaluate(()=>{const main=document.getElementById('app-main'),messages=document.getElementById('ai-messages');messages.scrollTop=messages.scrollHeight;main.scrollTop=main.scrollHeight;return {outer:main.scrollTop,message:messages.scrollTop,client:main.clientHeight,scroll:main.scrollHeight};});
 assert.equal(heights.outer,0);assert.ok(heights.message>1000);assert.ok(heights.scroll<=heights.client+2);
 await page.evaluate(()=>App.toggleAnnotation());assert.ok(await page.locator('#ai-input').isVisible());
 await page.evaluate(()=>App.toggleAnnotation());
 await page.evaluate(async()=>{await App.changeQuestionMode('multi');});
 await page.waitForSelector('.multi-question-view');await page.evaluate(()=>{const m=document.getElementById('ai-messages');m.innerHTML='<p>'+('长回答 '.repeat(3000))+'</p>';m.scrollTop=m.scrollHeight;});
 const multi=await page.evaluate(()=>{const m=document.getElementById('ai-messages');return {top:document.getElementById('ai-panel').getBoundingClientRect().top,content:document.getElementById('app-main').getBoundingClientRect().top,message:m.scrollTop,outer:document.getElementById('app-main').scrollTop};});
 assert.ok(Math.abs(multi.top-multi.content)<=2,JSON.stringify(multi));assert.ok(multi.message>0);
 await page.evaluate(async()=>{await App.changeQuestionMode('single');});assert.equal(await page.locator('#app-main').evaluate(e=>e.scrollTop),0);
 await page.setViewportSize({width:500,height:800});assert.equal(await page.locator('#ai-panel').evaluate(e=>Math.round(e.getBoundingClientRect().width)),500);
 assert.equal(await handle.isVisible(),false);
 await page.setViewportSize({width:1280,height:900});await page.reload();await page.waitForLoadState('networkidle');await page.waitForFunction('AppState.categories');
 await page.evaluate(async()=>{AppState.currentCategory=AppState.categories.categories.find(n=>UIRenderer.findNodeById(n,331));await App.enterChapterQuestions(UIRenderer.findNodeById(AppState.currentCategory,331));App.toggleAI();});
 assert.equal(Number(await page.locator('.ai-panel-resize').getAttribute('aria-valuenow')),maxWidth-100);
 await page.goto(base+'/legacy.html?ui=old&entry=chapters');await page.waitForLoadState('networkidle');
 await page.locator('[data-chapter-id="223"]').click();await page.locator('[data-chapter-id="321"]').click();
 await page.locator('[data-chapter-id="327"]').click();await page.locator('[data-chapter-id="331"]').click();await page.locator('#chapter-menu').waitFor({state:'hidden'});
 if (!await page.locator('#btn-single-ai').isVisible()) await page.locator('#mode-single').click();await page.locator('#btn-single-ai').click();
 await page.locator('#ai-prompt').fill('旧版草稿');const oldHandle=page.locator('#ai-resize-handle');await oldHandle.focus();await oldHandle.press('End');
 assert.equal(await oldHandle.getAttribute('aria-valuenow'),'620');assert.equal(await page.locator('#ai-prompt').inputValue(),'旧版草稿');
 const oldScroll=await page.evaluate(()=>{const msg=document.getElementById('ai-messages');msg.innerHTML='<div class="ai-message">'+('<p>旧版长回答</p>'.repeat(100))+'</div>';msg.scrollTop=msg.scrollHeight;const body=document.querySelector('.ai-drawer-body');body.scrollTop=body.scrollHeight;return {messages:msg.scrollTop,outer:body.scrollTop,height:body.clientHeight,scroll:body.scrollHeight};});
 assert.ok(oldScroll.messages>1000,JSON.stringify(oldScroll));assert.equal(oldScroll.outer,0);assert.ok(oldScroll.scroll<=oldScroll.height+2);
});

test('新版阅读：导航、展开、设置、段落跳转、草稿和流式阅读位置', {skip,timeout:60000},async t=>{
 const {base}=await fixture(t);
 const browser=await playwright.chromium.launch({headless:true, ...(process.env.DAGUAN_CHROMIUM_EXECUTABLE ? {executablePath:process.env.DAGUAN_CHROMIUM_EXECUTABLE} : {})});t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:1920,height:1080},serviceWorkers:'block'});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/state/events',route=>route.abort());await page.goto(base+'/index.html?ui=new');await page.waitForLoadState('networkidle');await page.waitForFunction('AppState.categories');
 await page.evaluate(async()=>{
  AppState.aiProfiles=[{id:'reading-fixture',name:'阅读测试',model:'数学模型',streaming:true}];AppState.aiProfileId='reading-fixture';
  AIService.loadHistory=async()=>[{role:'user',content:'请详细讲解这道题。'},{role:'assistant',content:'## 答案\n选 D。\n\n## 简短思路\n从线性无关的定义出发，验证每个向量都不能由其余向量表示。\n\n## 详细推导\n'+Array.from({length:45},(_,i)=>`### 第 ${i+1} 步\n明确知识点、适用条件与题干信息，再进行推导。\n\n`).join('')+'## 方法与易错点\n两两线性无关不能推出整体线性无关。'}];
  AppState.currentCategory=AppState.categories.categories.find(n=>UIRenderer.findNodeById(n,127));await App.enterChapterQuestions(UIRenderer.findNodeById(AppState.currentCategory,127),2);App.toggleAI();
 });
 await page.waitForSelector('#ai-section-nav button');
 assert.equal(await page.locator('#ai-section-nav button').count(),4);
 const input=page.locator('#ai-input');await input.fill('保留这份追问草稿');
 const originalWidth=await page.locator('.ai-panel-resize').getAttribute('aria-valuenow');
 await page.locator('#ai-expand-btn').click();
 const ratio=()=>page.evaluate(()=>document.getElementById('ai-panel').getBoundingClientRect().width/document.getElementById('app-main').getBoundingClientRect().width);
 const waitForExpanded=()=>page.waitForFunction(()=>Math.abs(document.getElementById('ai-panel').getBoundingClientRect().width/document.getElementById('app-main').getBoundingClientRect().width-.55)<.005);
 assert.ok(Math.abs(await ratio()-.55)<.005);
 await page.locator('#btn-toggle-nav').click();assert.equal(await page.locator('#app-nav').isVisible(),false);assert.ok(Math.abs(await ratio()-.55)<.005);
 assert.equal(await input.inputValue(),'保留这份追问草稿');
 const expandedHandle=page.locator('.ai-panel-resize');const expandedWidth=Number(await expandedHandle.getAttribute('aria-valuenow'));
 await expandedHandle.focus();await expandedHandle.press('ArrowLeft');assert.equal(Number(await expandedHandle.getAttribute('aria-valuenow')),expandedWidth+16);
 await expandedHandle.press('End');assert.ok(await ratio()>.7);assert.ok(await page.locator('#app-main').evaluate(e=>e.getBoundingClientRect().width)-Number(await expandedHandle.getAttribute('aria-valuenow'))>=359);
 assert.equal(await page.evaluate(()=>localStorage.getItem('daguan_ai_drawer_width_v1')),null);
 await page.locator('#ai-expand-btn').click();assert.equal(await page.locator('.ai-panel-resize').getAttribute('aria-valuenow'),originalWidth);
 await page.locator('#ai-expand-btn').click();
 await page.locator('#ai-section-nav button').filter({hasText:'简短思路'}).click();
 const readingTop=await page.locator('#ai-messages').evaluate(e=>e.scrollTop);
 await page.locator('#ai-expand-btn').click();assert.equal(await page.locator('#ai-messages').evaluate(e=>e.scrollTop),readingTop);
 await page.locator('#ai-settings-btn').click();assert.equal(await page.locator('#ai-profile-select-new').evaluate(e=>document.activeElement===e),true);
 await page.locator('#ai-include-private-new').check();assert.ok(await page.locator('#ai-private-status').isVisible());
 await page.locator('#ai-include-private-new').press('Escape');assert.equal(await page.locator('#ai-panel-settings').isVisible(),false);assert.equal(await page.locator('#ai-settings-btn').evaluate(e=>document.activeElement===e),true);
 await input.fill(Array.from({length:12},(_,i)=>'追问 '+i).join('\n'));
 const inputSize=await input.evaluate(e=>({height:e.clientHeight,scroll:e.scrollHeight,line:parseFloat(getComputedStyle(e).lineHeight)}));assert.ok(inputSize.height<inputSize.line*6);assert.ok(inputSize.scroll>inputSize.height);
 await input.fill('请详细讲解');
 await page.evaluate(()=>{
  AIService.chatStream=async()=>new Response(new ReadableStream({start(controller){window.readingStream=controller;}}),{headers:{'Content-Type':'text/event-stream'}});
  window.sendReadingDelta=content=>readingStream.enqueue(new TextEncoder().encode('data: '+JSON.stringify({type:'delta',content})+'\n\n'));
  window.readingRequest=App.sendAIMessage();
 });
 await page.waitForFunction('!!window.readingStream');
 await page.evaluate(()=>sendReadingDelta('## 答案\nD\n\n## 详细推导\n'+('线性无关的定义与推导过程。 '.repeat(1500))));
 await page.waitForFunction(()=>document.getElementById('ai-current-response').textContent.includes('推导过程'));
 await page.waitForFunction(()=>{const m=document.getElementById('ai-messages');return m.scrollHeight-m.scrollTop-m.clientHeight<10;});
 await page.locator('#ai-messages').evaluate(e=>{e.scrollTop=120;});await page.waitForFunction('!document.getElementById("ai-panel").reading.follow');
 await page.evaluate(()=>sendReadingDelta('\n\n## 方法与易错点\n不要遗漏适用条件。'));
 await page.waitForFunction(()=>document.getElementById('ai-current-response').textContent.includes('不要遗漏'));
 assert.equal(await page.locator('#ai-messages').evaluate(e=>e.scrollTop),120);assert.ok(await page.locator('#ai-latest-btn').isVisible());
 // Width and navigation changes while generating keep the same DOM and stream.
 await page.locator('#ai-expand-btn').click();await page.locator('#btn-toggle-nav').click();assert.equal(await page.evaluate('AppState.aiBusy'),true);
 assert.equal(await page.locator('#ai-messages').evaluate(e=>e.scrollTop),120);
 await input.fill('生成中保留的追问');
 assert.equal(await page.evaluate(async()=>{const panel=document.getElementById('ai-panel');await App.changeQuestionMode('multi');return document.getElementById('ai-panel')===panel;}),true);
 assert.equal(await page.evaluate('AppState.aiBusy'),true);assert.equal(await input.inputValue(),'生成中保留的追问');assert.equal(await page.locator('#ai-messages').evaluate(e=>e.scrollTop),120);
 assert.equal(await page.evaluate(async()=>{const panel=document.getElementById('ai-panel');await App.changeQuestionMode('single');return document.getElementById('ai-panel')===panel;}),true);
 assert.equal(await page.evaluate('AppState.aiBusy'),true);assert.equal(await page.locator('#ai-messages').evaluate(e=>e.scrollTop),120);
 await page.evaluate(async()=>{readingStream.close();await readingRequest;});
 assert.equal(await page.locator('#ai-messages').evaluate(e=>e.scrollTop),120);
 assert.equal(await page.locator('#ai-section-nav button').count(),3);
 await page.evaluate(()=>{const panel=document.getElementById('ai-panel');panel.querySelector('.ai-message.assistant:last-child .ai-message-bubble').innerHTML='<p>没有标题的回答</p>';DaguanAIReading.refreshSections();});assert.equal(await page.locator('#ai-section-nav').isVisible(),false);
 await page.locator('#ai-latest-btn').click();assert.equal(await page.locator('#ai-latest-btn').isVisible(),false);
 // Stop and delayed paints must not replace the partial answer after cancellation.
 await input.fill('再讲一个步骤');await page.evaluate(()=>{window.readingRequest=App.sendAIMessage();});
 await page.waitForFunction('AppState.aiBusy');await page.waitForFunction('!!window.readingStream');
 await page.evaluate(()=>{sendReadingDelta('保留部分推导');readingStream.error(new DOMException('已停止','AbortError'));});
 await page.evaluate(async()=>{await readingRequest;});assert.match(await page.locator('#ai-messages').innerText(),/已停止生成.*保留部分推导/s);
 await page.evaluate(()=>new Promise(r=>setTimeout(r,180)));assert.match(await page.locator('#ai-messages').innerText(),/已停止生成/);
 const capture=async(name)=>{if(process.env.DAGUAN_AI_SCREENSHOT_DIR){await fs.mkdir(process.env.DAGUAN_AI_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.DAGUAN_AI_SCREENSHOT_DIR,name+'.png')});}};
 await page.evaluate(async()=>{await UIRenderer.renderAIHistory(AppState.questions[AppState.currentQuestionIndex]);document.getElementById('ai-messages').scrollTop=0;});
 await capture('reading-1920');await page.setViewportSize({width:1366,height:768});await waitForExpanded();await capture('reading-1366');
 await page.evaluate(()=>{document.documentElement.style.setProperty('--ui-font-scale','1.5');DaguanAIPanelLayout.update();});
 await page.locator('#btn-toggle-nav').click();await waitForExpanded();
 const fontLayout=await page.evaluate(()=>{const body=document.querySelector('#ai-panel .ai-message.assistant .ai-message-bubble'),heading=body.querySelector('h2'),panel=document.getElementById('ai-panel');return {body:parseFloat(getComputedStyle(body).fontSize),heading:parseFloat(getComputedStyle(heading).fontSize),overflow:panel.scrollWidth>panel.clientWidth,inputBottom:document.querySelector('.ai-input-area').getBoundingClientRect().bottom};});
 assert.equal(fontLayout.body,21);assert.ok(fontLayout.heading<=fontLayout.body*1.25+.1);assert.equal(fontLayout.overflow,false);assert.ok(fontLayout.inputBottom<=768);await capture('reading-large-font');
 await page.locator('#btn-toggle-nav').click();await page.evaluate(()=>{document.documentElement.style.removeProperty('--ui-font-scale');DaguanAIPanelLayout.update();});await waitForExpanded();
 await page.evaluate(async()=>App.changeQuestionMode('multi'));await page.waitForSelector('.multi-question-view');await waitForExpanded();await capture('reading-multi');
 await page.setViewportSize({width:1024,height:768});await page.waitForFunction(()=>document.getElementById('ai-expand-btn').disabled);assert.equal(await page.locator('#ai-expand-btn').isDisabled(),true);
 await page.setViewportSize({width:500,height:800});assert.equal(await page.locator('#ai-panel').evaluate(e=>e.getBoundingClientRect().width),500);await capture('reading-small');
 await page.setViewportSize({width:1366,height:768});await page.locator('#btn-toggle-nav').click();await page.reload();await page.waitForLoadState('networkidle');assert.equal(await page.locator('#app-nav').isVisible(),false);
 assert.equal(errors.length,0,errors.join('\n'));
});

test('Electron 实际 preload：桌面顶栏不增加外层空白，消息和输入区均处于视口内', {skip:!playwright || process.platform!=='win32',timeout:60000},async t=>{
 const {base,temp}=await fixture(t);
 const resultFile=path.join(temp,'layout.json'),entry=path.join(temp,'electron-probe.cjs');
 await fs.writeFile(entry,`const {app,BrowserWindow}=require('electron');const fs=require('node:fs');app.setPath('userData',${JSON.stringify(path.join(temp,'electron'))});app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1320,height:860,webPreferences:{preload:${JSON.stringify(path.join(ROOT,'desktop/preload.cjs'))},contextIsolation:true,sandbox:true}});try{await win.loadURL(${JSON.stringify(base+'/index.html?ui=new')});for(let i=0;i<150;i++){if(await win.webContents.executeJavaScript('!!window.AppState?.categories && !!window.StateSync?.hydrated && !!document.querySelector(".subject-grid")'))break;await new Promise(r=>setTimeout(r,100));}await win.webContents.executeJavaScript(\`(async()=>{AppState.currentCategory=AppState.categories.categories.find(n=>UIRenderer.findNodeById(n,331));await App.enterChapterQuestions(UIRenderer.findNodeById(AppState.currentCategory,331));App.toggleAI()})()\`);await new Promise(r=>setTimeout(r,300));const result=await win.webContents.executeJavaScript(\`(()=>{document.getElementById('ai-messages').innerHTML='<p>'+('长回答 '.repeat(4000))+'</p>';const m=document.getElementById('app-main');m.scrollTop=m.scrollHeight;const msg=document.getElementById('ai-messages');msg.scrollTop=msg.scrollHeight;return {viewport:innerHeight,appBottom:document.querySelector('.app-container').getBoundingClientRect().bottom,outerScroll:m.scrollHeight,outerHeight:m.clientHeight,outerTop:m.scrollTop,inputBottom:document.querySelector('.ai-input-area').getBoundingClientRect().bottom,messageTop:msg.scrollTop};})()\`);fs.writeFileSync(${JSON.stringify(resultFile)},JSON.stringify(result));}catch(e){fs.writeFileSync(${JSON.stringify(resultFile)},JSON.stringify({error:e.message}));}app.exit();});`);
 const electronEnv={...process.env};delete electronEnv.ELECTRON_RUN_AS_NODE;
 const child=spawn(path.join(ROOT,'node_modules/electron/dist/electron.exe'),[entry],{env:electronEnv,windowsHide:true,stdio:['ignore','ignore','pipe']});
 let diagnostics='';child.stderr.on('data',chunk=>{diagnostics+=chunk;});
 t.after(()=>{if(child.exitCode==null)child.kill();});await once(child,'close');assert.equal(child.exitCode,0,diagnostics.slice(-3000));const result=JSON.parse(await fs.readFile(resultFile,'utf8'));
 assert.equal(result.error,undefined);assert.ok(result.appBottom<=result.viewport+2,JSON.stringify(result));assert.ok(result.outerScroll<=result.outerHeight+2);assert.equal(result.outerTop,0);assert.ok(result.inputBottom<=result.viewport);assert.ok(result.messageTop>0);
});

// 真实有效的小 PNG bytes：浏览器端 FileReader 读取后必须是可用的 image/png dataURL。
const PNG_1X1='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/5nR5WQAAAABJRU5ErkJggg==';
const PNG_2X2='iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVQI12P4z8BQz0AEYBxVSFUAAMWUBQ21o/oWAAAAAElFTkSuQmCC';
const dataUrl=b64=>`data:image/png;base64,${b64}`;

// 在页面内安装真实 bytes 构造的文件入口，走真实 FileReader/剪贴板/拖放，不用伪造 dataURL 字符串。
function installPngHelper(){
 const make=(b64,name,type='image/png',pad=0)=>{const raw=atob(b64);const buf=new Uint8Array(raw.length+pad);for(let i=0;i<raw.length;i++)buf[i]=raw.charCodeAt(i);return new File([buf],name,{type});};
 window.__png={
  make,
  // 三条真实入口：点按选择(change)、拖放(drop)、粘贴截图(paste)。
  select(file){const dt=new DataTransfer();dt.items.add(file);const input=document.getElementById('ai-attach-input');input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));},
  selectMany(files){const dt=new DataTransfer();files.forEach(f=>dt.items.add(f));const input=document.getElementById('ai-attach-input');input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));},
  drop(file){window.__png.dropMany([file]);},
  dropMany(files){const zone=document.querySelector('#ai-panel .ai-input-area');const dt=new DataTransfer();files.forEach(f=>dt.items.add(f));zone.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:dt}));zone.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}));},
  paste(file,text){const input=document.getElementById('ai-input');const dt=new DataTransfer();if(file)dt.items.add(file);if(text!=null)dt.setData('text/plain',text);input.focus();const ev=new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:dt});input.dispatchEvent(ev);return ev.defaultPrevented;},
 };
}

 // 真实 /api/ai/chat 夹具：vision 已通过的档案 + mock 上游；failNext 让上游按次数返回 500。
async function imageFixture(t){
 const {base,temp}=await fixture(t);
 const calls=[];
 let failNext=0;
 const upstream=http.createServer(async(req,res)=>{
  if(String(req.url).endsWith('/models')){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{id:'vision-model'}]}));return;}
  let raw='';for await(const chunk of req) raw+=chunk;
  calls.push(JSON.parse(raw||'{}'));
  if(failNext>0){failNext-=1;res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'mock upstream failure'}}));return;}
  res.setHeader('Content-Type','application/json');
  res.end(JSON.stringify({choices:[{message:{content:'这是图片中的题目要点。'}}]}));
 });
 await listenHttp(upstream);
 t.after(()=>new Promise(r=>{upstream.closeAllConnections();upstream.close(r);}));
 const created=await fetch(base+'/api/ai/profiles',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'图片测试',baseUrl:`http://127.0.0.1:${upstream.address().port}/v1`,key:'test-only-key',model:'vision-model',capabilities:{text:true,vision:'passed'}})});
 assert.equal(created.status,200,'vision 档案创建成功');
 const profile=(await created.json()).profile;
 const browser=await playwright.chromium.launch({headless:true,...(process.env.DAGUAN_CHROMIUM_EXECUTABLE?{executablePath:process.env.DAGUAN_CHROMIUM_EXECUTABLE}:{})});
 t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:1280,height:900}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/state/events',route=>route.abort());
 await page.goto(base+'/index.html?ui=new');await page.waitForLoadState('networkidle');await page.waitForFunction('AppState.categories');
 // 状态同步就绪后再挂附件：避免 StateSync 完成时的题目重绘在投递图片的过程中重建 AI 面板。
 await page.waitForFunction(()=>!window.StateSync || window.StateSync.hydrated !== false);
 await page.evaluate(async()=>{AppState.currentCategory=AppState.categories.categories.find(n=>UIRenderer.findNodeById(n,331));await App.enterChapterQuestions(UIRenderer.findNodeById(AppState.currentCategory,331));});
 return {base,temp,page,errors,profile,calls,setFailNext:n=>{failNext=n;}};
}
const openAI=page=>page.evaluate(async()=>{await App.toggleAI();});

test('新版图片聊天：选择/拖放/粘贴截图进入预览并可移除，多次交互不串批', {skip,timeout:60000},async t=>{
 const {page,errors}=await imageFixture(t);
 await page.evaluate(installPngHelper);await openAI(page);await page.waitForSelector('#ai-attach-btn');
 // 面板稳定绑定后再投递：每个入口只投一次，直接等待精确数量；失败必须暴露，不做事件重放。
 const settled=()=>page.evaluate(()=>new Promise(r=>setTimeout(r,300)));
 await settled();
 await page.evaluate(({b64})=>window.__png.select(window.__png.make(b64,'选择图.png')),{b64:PNG_1X1});
 await page.waitForFunction(()=>document.querySelectorAll('#ai-attachment-previews .ai-attachment').length===1);
 assert.equal(await page.locator('#ai-attachment-previews .ai-attachment img').count(),1);
 assert.match(await page.locator('#ai-attachment-previews .ai-attachment-name').innerText(),/选择图\.png/);
 await page.evaluate(({b64})=>window.__png.drop(window.__png.make(b64,'拖放图.png')),{b64:PNG_2X2});
 await page.waitForFunction(()=>document.querySelectorAll('#ai-attachment-previews .ai-attachment').length===2);
 await page.evaluate(({b64})=>window.__png.paste(window.__png.make(b64,'粘贴图.png')),{b64:PNG_1X1});
 await page.waitForFunction(()=>document.querySelectorAll('#ai-attachment-previews .ai-attachment').length===3);
 assert.equal(await page.locator('#ai-attachment-previews .ai-attachment').count(),3);
 await page.locator('#ai-attachment-previews .ai-attachment-remove').first().click();
 await page.waitForFunction(()=>document.querySelectorAll('#ai-attachment-previews .ai-attachment').length===2);
 await page.evaluate(({b64})=>window.__png.paste(window.__png.make(b64,'再粘贴.png')),{b64:PNG_2X2});
 await page.waitForFunction(()=>document.querySelectorAll('#ai-attachment-previews .ai-attachment').length===3);
 await page.locator('#ai-attachment-previews .ai-attachment-remove').nth(1).click();
 await page.waitForFunction(()=>document.querySelectorAll('#ai-attachment-previews .ai-attachment').length===2);
 const src=await page.locator('#ai-attachment-previews .ai-attachment img').first().getAttribute('src');
 assert.match(src,/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/,'真实读取结果必须是可用的 PNG dataURL');
 assert.equal(errors.length,0,errors.join('\n'));
});

test('新版图片聊天：纯图片与图文发送，上游 content 含完整 dataURL', {skip,timeout:60000},async t=>{
 const {page,calls,errors}=await imageFixture(t);
 await page.evaluate(installPngHelper);await openAI(page);await page.waitForSelector('#ai-attach-btn');
 const expect=dataUrl(PNG_1X1);
 await page.evaluate(({b64})=>window.__png.drop(window.__png.make(b64,'图文.png')),{b64:PNG_1X1});
 await page.waitForFunction(()=>document.querySelectorAll('#ai-attachment-previews .ai-attachment:not(.ai-attachment-reading)').length===1);
 await page.locator('#ai-input').fill('请讲解这张图');await page.locator('#ai-send-btn').click();
 await page.waitForFunction('!AppState.aiBusy');
 await page.waitForSelector('#ai-messages .ai-message.user .ai-message-images img');
 assert.equal(await page.locator('#ai-messages .ai-message.user .ai-message-images img').count(),1);
 assert.equal(await page.locator('#ai-messages .ai-message.user .ai-message-images img').first().getAttribute('src'),expect);
 const parts=calls.at(-1).messages.at(-1).content;
 assert.ok(Array.isArray(parts),'图文请求 content 为数组');
 assert.equal(parts[0].type,'text');assert.match(parts[0].text,/请讲解这张图/);
 assert.equal(parts[1].type,'image_url');assert.equal(parts[1].image_url.url,expect,'dataURL 完整透传，未被截断');
 assert.equal(await page.locator('#ai-input').inputValue(),'');
 assert.equal(await page.locator('#ai-attachment-previews .ai-attachment').count(),0);
 const before=calls.length;
 await page.evaluate(({b64})=>window.__png.drop(window.__png.make(b64,'纯图.png')),{b64:PNG_2X2});
 await page.waitForFunction(()=>document.querySelectorAll('#ai-attachment-previews .ai-attachment:not(.ai-attachment-reading)').length===1);
 await page.locator('#ai-send-btn').click();
 await page.waitForFunction('!AppState.aiBusy');
 assert.equal(calls.length,before+1,'纯图片也发出一次请求');
 const pure=calls.at(-1).messages.at(-1).content;
 assert.ok(Array.isArray(pure));assert.equal(pure[1].image_url.url,dataUrl(PNG_2X2));
 assert.match(pure[0].text,/请结合图片回答我的问题/);
 assert.equal(errors.length,0,errors.join('\n'));
});

test('新版图片聊天：格式/大小/数量超限都明确可见且不进入预览', {skip,timeout:60000},async t=>{
 const {page,errors}=await imageFixture(t);
 await page.evaluate(installPngHelper);await openAI(page);await page.waitForSelector('#ai-attach-btn');
 const count=()=>page.locator('#ai-attachment-previews .ai-attachment').count();
 const toastText=()=>page.evaluate(()=>document.getElementById('daguan-toast')?.textContent||'');
 // 1) 格式不支持（此时仍有空位，确认拿到格式错误而不是数量错误）
 await page.evaluate(()=>window.__png.drop(window.__png.make('aGVsbG8=','文本.txt','text/plain')));
 await page.waitForFunction(()=>/不支持的图片格式/.test(document.getElementById('daguan-toast')?.textContent||''));
 assert.match(await toastText(),/文本\.txt/,{message:'提示要指出具体文件'});
 assert.equal(await count(),0);
 // 2) 单图超过 2MiB（真实 bytes 大小）
 await page.evaluate(()=>window.__png.drop(new File([new Uint8Array(2*1024*1024+16)],'超大.png',{type:'image/png'})));
 await page.waitForFunction(()=>/图片超过 2MiB/.test(document.getElementById('daguan-toast')?.textContent||''));
 assert.equal(await count(),0);
 // 3) 一次投 5 张：超过剩余名额，整批拒绝
 await page.evaluate(({b64})=>window.__png.dropMany(Array.from({length:5},(_,i)=>window.__png.make(b64,`多${i}.png`))),{b64:PNG_1X1});
 await page.waitForFunction(()=>/剩余名额只有 4 张/.test(document.getElementById('daguan-toast')?.textContent||''));
 assert.equal(await count(),0);
 // 4) 先放满 4 张，再加第 5 张：明确提示上限且不截断已有附件
 await page.evaluate(({b64})=>window.__png.dropMany(Array.from({length:4},(_,i)=>window.__png.make(b64,`满${i}.png`))),{b64:PNG_1X1});
 await page.waitForFunction(()=>document.querySelectorAll('#ai-attachment-previews .ai-attachment:not(.ai-attachment-reading)').length===4);
 await page.evaluate(({b64})=>window.__png.drop(window.__png.make(b64,'第五张.png')),{b64:PNG_1X1});
 await page.waitForFunction(()=>/最多只能添加 4 张图片/.test(document.getElementById('daguan-toast')?.textContent||''));
 assert.equal(await count(),4,'整批拒绝不截断已有附件');
 assert.equal(errors.length,0,errors.join('\n'));
});

test('新版图片聊天：4 张各 ≤2MiB 但整体请求超 10MiB 时明确提示并保留附件与文字', {skip,timeout:60000},async t=>{
 const {page,calls,errors}=await imageFixture(t);
 await page.evaluate(installPngHelper);await openAI(page);await page.waitForSelector('#ai-attach-btn');
 await page.evaluate(()=>new Promise(r=>setTimeout(r,300)));
 // 4 张有效 PNG，每张原文件 ≤2MiB，但 4 张 base64 相加使整个请求 JSON 超过 10MiB。
 await page.evaluate(({b64})=>{
  const pad=2*1024*1024-128; // 每条严格小于 2MiB 上限，四张相加却超过 10MiB
  const files=Array.from({length:4},(_,i)=>window.__png.make(b64,`大图${i}.png`,'image/png',pad));
  window.__png.dropMany(files);
 },{b64:PNG_1X1});
 await page.waitForFunction(()=>document.querySelectorAll('#ai-attachment-previews .ai-attachment:not(.ai-attachment-reading)').length===4);
 await page.locator('#ai-input').fill('请一起看这四张图');
 const before=calls.length;
 await page.locator('#ai-send-btn').click();
 await page.waitForFunction(()=>/超过 10MiB 上限/.test(document.getElementById('daguan-toast')?.textContent||''));
 assert.equal(calls.length,before,'超限请求不得调用上游');
 assert.equal(await page.locator('#ai-attachment-previews .ai-attachment').count(),4,'超限后附件保留');
 assert.equal(await page.locator('#ai-input').inputValue(),'请一起看这四张图','超限后文字保留');
 assert.equal(await page.locator('#ai-messages .ai-message.user').count(),0,'未发出用户消息');
 assert.equal(errors.length,0,errors.join('\n'));
});

test('新版图片聊天：切题清空附件，在途读取的过期批次不污染新题', {skip,timeout:60000},async t=>{
 const {page,errors}=await imageFixture(t);
 await page.evaluate(installPngHelper);await openAI(page);await page.waitForSelector('#ai-attach-btn');
 const firstId=await page.evaluate(()=>String(AppState.questions[AppState.currentQuestionIndex].id));
 await page.evaluate(({b64})=>window.__png.drop(window.__png.make(b64,'第一题图.png')),{b64:PNG_1X1});
 await page.waitForFunction(()=>document.querySelectorAll('#ai-attachment-previews .ai-attachment:not(.ai-attachment-reading)').length===1);
 await page.evaluate(()=>App.nextQuestion());
 await page.waitForFunction(id=>String(AppState.questions[AppState.currentQuestionIndex].id)!==id,firstId);
 await page.waitForFunction(()=>document.querySelectorAll('#ai-attachment-previews .ai-attachment').length===0);
 assert.equal(await page.locator('#ai-attachment-previews .ai-attachment').count(),0,'切题清空上一题附件');
 // 切题瞬间还留一个在途读取：其结果不得写入新题
 await page.evaluate(({b64})=>{window.__png.drop(window.__png.make(b64,'在途.png'));App.nextQuestion();},{b64:PNG_2X2});
 await page.evaluate(()=>new Promise(r=>setTimeout(r,400)));
 assert.equal(await page.locator('#ai-attachment-previews .ai-attachment').count(),0,'过期读取不写入新题');
 assert.equal(errors.length,0,errors.join('\n'));
});

test('新版图片聊天：上游失败后自动恢复同题图文，重试重发同一张图', {skip,timeout:60000},async t=>{
 const {page,calls,errors,setFailNext}=await imageFixture(t);
 await page.evaluate(installPngHelper);await openAI(page);await page.waitForSelector('#ai-attach-btn');
 const expect=dataUrl(PNG_1X1);
 await page.evaluate(({b64})=>window.__png.drop(window.__png.make(b64,'失败恢复.png')),{b64:PNG_1X1});
 await page.waitForFunction(()=>document.querySelectorAll('#ai-attachment-previews .ai-attachment:not(.ai-attachment-reading)').length===1);
 setFailNext(1);
 await page.locator('#ai-input').fill('这张图怎么做');await page.locator('#ai-send-btn').click();
 await page.waitForFunction(()=>/AI 暂时没有完成回答/.test(document.getElementById('ai-messages')?.textContent||''));
 assert.ok(await page.locator('.ai-retry-btn').count()>=1,'错误气泡提供重试');
 await page.waitForFunction(()=>document.querySelectorAll('#ai-attachment-previews .ai-attachment:not(.ai-attachment-reading)').length===1);
 assert.equal(await page.locator('#ai-attachment-previews .ai-attachment img').first().getAttribute('src'),expect,'恢复的图片与发送时一致');
 assert.equal(await page.locator('#ai-input').inputValue(),'这张图怎么做','恢复的文字与发送时一致');
 const before=calls.length;
 await page.locator('.ai-retry-btn').first().click();
 await page.waitForFunction('!AppState.aiBusy');
 const retried=calls.slice(before).filter(c=>Array.isArray(c.messages.at(-1).content));
 assert.ok(retried.length>=1,'重试后重新发出含图请求');
 assert.equal(retried.at(-1).messages.at(-1).content[1].image_url.url,expect,'重试发送同一张图');
 assert.equal(errors.length,0,errors.join('\n'));
});

test('新版图片聊天：纯文本粘贴不拦截，未通过 vision 时图文发送被明确拒绝且不丢图', {skip,timeout:60000},async t=>{
 const {base,page,calls,errors,profile}=await imageFixture(t);
 await page.evaluate(installPngHelper);await openAI(page);await page.waitForSelector('#ai-attach-btn');
 const prevented=await page.evaluate(()=>window.__png.paste(null,'纯文本粘贴'));
 assert.equal(prevented,false,'无文件粘贴不拦截默认行为');
 assert.equal(await page.locator('#ai-attachment-previews .ai-attachment').count(),0);
 // 纯文本发送仍走原契约：content 为字符串、images 为空数组
 await page.locator('#ai-input').fill('只问文字');await page.locator('#ai-send-btn').click();
 await page.waitForFunction('!AppState.aiBusy');
 assert.equal(typeof calls.at(-1).messages.at(-1).content,'string');
 assert.equal(Array.isArray(calls.at(-1).messages.at(-1).content),false,'纯文本请求不带 image_url 部件');
 assert.equal(await page.locator('#ai-messages .ai-message.user .ai-message-images').count(),0);
 // 档案不再通过 vision：附件在预览中，发送被明确拒绝且无请求、输入与附件保留
 await fetch(`${base}/api/ai/profiles/${profile.id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({capabilities:{text:true,vision:'unknown'}})});
 await page.evaluate(()=>AIService.loadProfiles());
 await page.evaluate(({b64})=>window.__png.drop(window.__png.make(b64,'视觉未过.png')),{b64:PNG_1X1});
 await page.waitForFunction(()=>document.querySelectorAll('#ai-attachment-previews .ai-attachment:not(.ai-attachment-reading)').length===1);
 const before=calls.length;
 await page.locator('#ai-input').fill('图文一起发');await page.locator('#ai-send-btn').click();
 await page.waitForFunction(()=>/未通过图片能力测试/.test(document.getElementById('daguan-toast')?.textContent||''));
 assert.equal(calls.length,before,'vision 未通过不发生上游请求');
 assert.equal(await page.locator('#ai-attachment-previews .ai-attachment').count(),1,'失败后附件保留');
 assert.equal(await page.locator('#ai-input').inputValue(),'图文一起发','失败后文字保留');
 assert.equal(errors.length,0,errors.join('\n'));
});

test('新版图片聊天：旧版 localStorage 偏好下，index.html?ui=new 仍停留在新版', {skip,timeout:60000},async t=>{
 const {base,page,errors}=await imageFixture(t);
 await page.evaluate(()=>localStorage.setItem('daguan_ui_version_v1','old'));
 // 只验证 index.html?ui=new 的解析优先级：?ui=new 必须压过旧偏好。
 // 已知 launcher 侧 ui-version 重定向优先级由 T3 修复，整合前本用例可能为红。
 await page.goto(base+'/index.html?ui=new');await page.waitForLoadState('networkidle');
 await page.waitForFunction('window.App && AppState && AppState.categories && document.documentElement.dataset.uiVersion==="new"');
 assert.equal(new URL(page.url()).pathname.endsWith('/index.html'),true,'没有被重定向到 legacy.html');
 assert.equal(new URL(page.url()).searchParams.get('ui'),'new');
 assert.equal(await page.evaluate(()=>document.documentElement.dataset.appVersion),'new');
 assert.equal(errors.length,0,errors.join('\n'));
});

test('新版图片聊天：真实 /api/ai/chat 非法图片返回 400 JSON 且不调用上游', {skip,timeout:60000},async t=>{
 const {base,calls}=await imageFixture(t);
 const profile=(await (await fetch(base+'/api/ai/profiles')).json()).profiles[0];
 const huge='data:image/png;base64,'+Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),Buffer.alloc(2*1024*1024,0x11)]).toString('base64');
 for(const [name,images,pattern] of [
  ['图片项不是字符串',[123],/图片只支持/],
  ['不是 dataURL',['https://example.com/a.png'],/图片只支持/],
  ['不支持的格式',['data:image/svg+xml;base64,'+Buffer.from('<svg/>').toString('base64')],/图片只支持/],
  ['非法 base64',['data:image/png;base64,%%%'],/图片只支持/],
  ['空内容',['data:image/png;base64,'],/图片只支持/],
  ['数量超过 4 张',Array.from({length:5},()=>dataUrl(PNG_1X1)),/最多上传 4 张/],
  ['解码后超过 2MiB',[huge],/超过 2 MiB/],
 ]){
  const before=calls.length;
  const res=await fetch(base+'/api/ai/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({profileId:profile.id,question:{id:'q1',stem:'看图'},prompt:'测试',images})});
  assert.equal(res.status,400,`${name} 应返回 400`);
  assert.match(res.headers.get('content-type')||'',/application\/json/,`${name} 应返回 JSON`);
  const payload=await res.json();
  assert.equal(payload.ok,false,`${name} 返回 ok:false`);
  assert.match(String(payload.error),pattern,`${name} 错误信息明确`);
  assert.equal(calls.length,before,`${name} 不产生上游调用`);
 }
 // 对照组：合法图片确实到达 mock 上游，证明上面的 400 不是夹具伪造状态
 const ok=await fetch(base+'/api/ai/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({profileId:profile.id,question:{id:'q1',stem:'看图'},prompt:'合法',images:[dataUrl(PNG_1X1)]})});
 assert.equal(ok.status,200);await ok.text();
 assert.equal(calls.length>=1,true,'合法请求确实到达上游');
});
