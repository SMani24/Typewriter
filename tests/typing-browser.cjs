/* New measurements against real browser events and a temporary, offline notebook. */
const {chromium}=require('playwright');
const {spawn}=require('node:child_process');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const assert=require('node:assert/strict');
(async()=>{
  const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'typewriter-typing-'));
  const script=`import sys,wave,math,struct
from pathlib import Path
from typewriter.web import create_app
p=Path(sys.argv[1]);app=create_app(p,p/'no-keys',background=False);s=app.extensions['store']
s.save_settings(dict(preparation_method='manual',sentence_enabled=False,audio_enabled=False,meaning_enabled=False))
ids=s.add_words([dict(word=w,definition=d,sentence=sentence,tip='A spelling tip.') for w,d,sentence in [('necessary','Required.','It is necessary.'),('example','An illustration.','This is an example.')]])['added']
(p/'audio').mkdir();clip='00000000000000000000000000000000.wav'
with wave.open(str(p/'audio'/clip),'wb') as f:
 f.setparams((1,2,16000,0,'NONE','not compressed'));f.writeframes(b''.join(struct.pack('<h',int(5000*math.sin(2*math.pi*440*i/16000))) for i in range(8000)))
s.set_audio(ids[0],file=clip,verified=True)
def no_network(*args,**kwargs):raise AssertionError('No provider calls allowed')
app.extensions['network'].request=no_network
app.run(host='127.0.0.1',port=int(sys.argv[2]),debug=False,threaded=True)`;
  const server=spawn(path.join(__dirname,'..','.venv','bin','python'),['-u','-c',script,directory,String(port)],{cwd:path.join(__dirname,'..'),stdio:['ignore','ignore','pipe']});let output='';server.stderr.on('data',data=>output+=data);let browser;
  try{
    const base=`http://127.0.0.1:${port}`;let ready=false;
    for(let i=0;i<100;i++){try{if((await fetch(base+'/api/health')).ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,100));}assert(ready,output);
    browser=await chromium.launch({headless:true,executablePath:process.env.TYPEWRITER_BROWSER_PATH || '/opt/google/chrome/chrome',args:['--no-sandbox']});const page=await browser.newPage({viewport:{width:1360,height:1050}});const errors=[];const submissions=[];page.on('request',request=>{if(request.method()==='POST' && /\/api\/words\/\d+\/attempts$/.test(request.url()))submissions.push(request.postDataJSON());});page.on('pageerror',error=>errors.push(error.message));
    await page.goto(base);await page.locator('#app-content').waitFor({state:'visible'});
    async function api(url,method='GET',data){return page.evaluate(async({url,method,data})=>{const response=await fetch('/api'+url,{method,headers:{'Content-Type':'application/json','X-Typewriter-Token':document.querySelector('meta[name="typewriter-token"]').content},...(data===undefined?{}:{body:JSON.stringify(data)})});const result=await response.json();if(!response.ok)throw Error(result.error);return result;},{url,method,data});}
    const word=(await api('/state')).words.find(word=>word.word==='necessary');const field=page.locator('#answer');
    const history=async()=>(await api('/export')).attempts;
    async function configure(values){await api('/settings','PUT',values);await page.evaluate(()=>refresh());}
    async function review(){await page.evaluate(id=>startReview([id]),word.id);await page.waitForFunction(()=>document.activeElement===document.querySelector('#answer'));await page.evaluate(()=>new Promise(requestAnimationFrame));}
    async function type(text='necessary'){await field.pressSequentially(text,{delay:12});}
    async function submit(){await field.press('Enter');await page.waitForFunction(()=>practice.feedback).catch(async error=>{console.error('Submission context:',await page.evaluate(()=>({mode:practice?.mode,feedback:document.querySelector('#practice-feedback').textContent,status:document.querySelector('#toast').textContent,length:document.querySelector('#answer').value.length})));throw error;});}
    async function end(){await page.evaluate(()=>{finishPractice();});await page.locator('#practice-summary').waitFor({state:'visible'});await page.locator('[data-action="close-practice"]').click();await page.evaluate(()=>lastSessionEnd);}
    assert.equal((await api('/state')).settings.typing_metrics_enabled,false);await review();await type();await submit();assert(!('typing' in (await history()).at(-1)));await end();
    await page.locator('.nav-item[data-page="settings"]').click();await page.locator('[name="typing_metrics_enabled"]').check();await page.locator('[name="typing_input_method"]').selectOption('hardware');await page.locator('#settings-form button[type="submit"]').click();await page.waitForFunction(()=>document.querySelector('#settings-unsaved-note').hidden);
    await review();await type('privatedraftcanary');await field.press('Control+a');await type();await page.locator('#hint-button').focus();await page.waitForTimeout(30);await field.focus();
    await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});document.dispatchEvent(new Event('visibilitychange'));});await page.waitForTimeout(30);
    await page.evaluate(()=>{delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));});await type('x');await field.press('Backspace');await submit();
    let summary=(await history()).at(-1).typing;assert(summary);assert(summary.flags.includes('focus_loss'));assert(summary.flags.includes('hidden'));assert(summary.revision_events>=2);assert(summary.excluded_ms>=25);assert.equal(summary.input_method,'hardware');assert(!JSON.stringify(summary).includes('privatedraftcanary'));assert(!JSON.stringify(summary).includes('necessary'));assert((await history()).at(-1).correct);await end();
    await review();await page.evaluate(()=>{
      const field=document.querySelector('#answer');field.dispatchEvent(new CompositionEvent('compositionstart',{data:'x',bubbles:true}));
      field.dispatchEvent(new InputEvent('beforeinput',{inputType:'insertCompositionText',data:'x',isComposing:true,bubbles:true}));field.value='x';field.dispatchEvent(new InputEvent('input',{inputType:'insertCompositionText',data:'x',isComposing:true,bubbles:true}));field.dispatchEvent(new CompositionEvent('compositionend',{data:'x',bubbles:true}));
      field.select();field.dispatchEvent(new ClipboardEvent('paste',{bubbles:true}));field.dispatchEvent(new Event('drop',{bubbles:true}));field.dispatchEvent(new InputEvent('beforeinput',{inputType:'insertFromPaste',data:'necessary',bubbles:true}));field.value='necessary';field.dispatchEvent(new InputEvent('input',{inputType:'insertFromPaste',data:'necessary',bubbles:true}));
    });await submit();summary=(await history()).at(-1).typing;assert(summary);for(const flag of ['paste','drop','composition','untrusted_input'])assert(summary.flags.includes(flag));await end();
    await review();const before=(await history()).length;await type('unfinished');await end();assert.equal((await history()).length,before,'An abandoned question saves no attempt or summary');
    await review();await page.locator('#hint-button').click();await type();await submit();assert(!('typing' in (await history()).at(-1)));await end();
    await review();await type('nec');await page.locator('[data-action="edit-practice-word"]').click();await page.locator('[data-close="word-dialog"]').click();await field.press('Control+a');await type();await submit();assert(!submissions.at(-1).typing,'Opening the answer editor discards instrumentation');await end();
    await review();await type('wrong');await submit();assert((await history()).at(-1).typing);await field.press('Enter');await field.waitFor({state:'visible'});await type();await submit();assert.equal((await history()).at(-1).mode,'correction');assert(!('typing' in (await history()).at(-1)));await end();
    await page.locator('.nav-item[data-page="today"]').click();await page.locator('[data-action="choose-drill"]').click();await page.locator('#drill-search').fill('necessary');await page.locator('#drill-form button[type="submit"]').click();await page.waitForFunction(()=>document.activeElement===document.querySelector('#answer'));await type();await submit();assert.equal((await history()).at(-1).mode,'drill');assert(!('typing' in (await history()).at(-1)));await end();
    await configure({definition_enabled:false,meaning_enabled:true,quiz_interval_mode:'fixed',quiz_interval_min:1,quiz_interval_max:1});await page.evaluate(id=>startReview([id]),word.id);await page.locator('.meaning-choice').first().click();await page.waitForFunction(()=>practice.feedback);assert.equal((await history()).at(-1).mode,'meaning');assert(!('typing' in (await history()).at(-1)));await end();
    await configure({meaning_enabled:false,audio_enabled:true,autoplay_audio:true,audio_repeat_gap_seconds:0});await review();await page.waitForFunction(()=>document.querySelector('#pronunciation').ended);await type();await submit();summary=(await history()).at(-1).typing;assert(summary);assert.equal(summary.latency_basis,'audio-ended');assert.equal(summary.audio_plays,1);assert(summary.audio_duration_ms>300);assert(summary.excluded_ms>300);await end();
    await configure({audio_enabled:false,definition_enabled:true});await review();await type();let intercepted=false;
    await page.route(`**/api/words/${word.id}/attempts`,async route=>{if(!intercepted){intercepted=true;await route.fetch();await route.abort('failed');}else await route.continue();});
    await field.press('Enter');await page.locator('#answer-form[data-result="error"]').waitFor();const saved=await history();const frozen=saved.at(-1).typing;assert(frozen);await page.waitForTimeout(120);await submit();const retried=await history();assert.equal(retried.length,saved.length);assert.deepEqual(retried.at(-1).typing,frozen);await page.unroute(`**/api/words/${word.id}/attempts`);await end();
    await page.evaluate(id=>startReview([id],true),word.id);await page.waitForFunction(()=>document.activeElement===document.querySelector('#answer'));await page.evaluate(()=>new Promise(requestAnimationFrame));await type();await submit();assert(submissions.at(-1).typing);
    await field.press('Enter');await page.waitForFunction(()=>!practice.feedback && !answerBusy && document.querySelector('#answer').value==='');await type();await submit();assert(!submissions.at(-1).typing,'Endless repetitions are not re-instrumented');await end();
    await review();const requestsBefore=submissions.length;
    const editCost=await page.evaluate(()=>{const field=document.querySelector('#answer'),start=performance.now();for(let i=0;i<1000;i++){field.dispatchEvent(new InputEvent('beforeinput',{inputType:'insertText',data:'x',bubbles:true}));field.value='x';field.dispatchEvent(new InputEvent('input',{inputType:'insertText',data:'x',bubbles:true}));}return (performance.now()-start)/1000;});
    assert.equal(submissions.length,requestsBefore,'Input events do not send requests');assert(Number.isFinite(editCost));await end();
    await review();await type();await api('/settings','PUT',{typing_metrics_enabled:false});await submit();assert(!('typing' in (await history()).at(-1)),'A stale consenting tab cannot persist after consent is off');await end();
    await page.locator('.nav-item[data-page="settings"]').click();await page.locator('select[name="text_size"]').selectOption('large');await page.locator('#delete-typing-metrics').click();await page.waitForFunction(()=>document.querySelector('#typing-metrics-status').textContent.includes('Collection is off'));
    assert((await history()).every(attempt=>!attempt.typing));assert.equal(await page.locator('select[name="text_size"]').inputValue(),'large','Deleting preserves unrelated unsaved preferences');assert(await page.locator('#settings-unsaved-note').isVisible());
    await page.setViewportSize({width:390,height:844});assert(await page.locator('.typing-settings').evaluate(node=>node.scrollWidth<=node.clientWidth));
    console.log('Synthetic edit-event pair average (ms):',editCost.toFixed(4));assert.deepEqual(errors,[]);console.log('Typing browser checks passed: opt-in, real edits, focus/visibility, composition/paste/drop, privacy, eligible modes, audio readiness, retries, abandonment, stale consent and deletion.');
  }finally{if(browser)await browser.close();server.kill('SIGTERM');await new Promise(resolve=>server.once('exit',resolve));fs.rmSync(directory,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
