/* Focused checks for the notebook's feature/bug queue, without provider requests. */
const {chromium}=require('playwright');
const {spawn,execFileSync}=require('node:child_process');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const net=require('node:net');
const assert=require('node:assert/strict');
(async()=>{
  const probe=net.createServer();
  await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
  const port=probe.address().port;
  await new Promise(resolve=>probe.close(resolve));
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'typewriter-updates-'));
  const script=`import sys,wave,math,struct
from pathlib import Path
from typewriter.web import create_app
p=Path(sys.argv[1])
app=create_app(p,p/"no-keys",background=False)
s=app.extensions["store"]
s.save_settings({"preparation_method":"manual","audio_enabled":False,"definition_enabled":False,"meaning_enabled":False})
ids=s.add_words([{"word":w,"definition":d,"sentence":sentence,"tip":"Practise the letters."} for w,d,sentence in [("necessary","Required.","This change is necessary."),("missing","Absent.","One piece is missing.")]])["added"]
(p/"audio").mkdir()
with wave.open(str(p/"audio"/"00000000000000000000000000000000.wav"),"wb") as a:
    a.setparams((1,2,16000,0,"NONE","not compressed"))
    a.writeframes(b"".join(struct.pack("<h",int(5000*math.sin(2*math.pi*440*i/16000))) for i in range(8000)))
s.set_audio(ids[0],file="00000000000000000000000000000000.wav",verified=True)
s.set_audio(ids[1],file="00000000000000000000000000000000.wav",verified=True)
app.extensions["dictionary"].lookup=lambda word,**kwargs: {"audio":{"us":"https://dictionary.cambridge.org/color-us.mp3"} if word=="color" else {},"senses":[]}
def no_network(*args,**kwargs):
    raise AssertionError("No provider requests allowed in browser checks")
app.extensions["network"].request=no_network
s.attempt(ids[0],{'answer':'necessary','mode':'review'})
app.extensions['dictionary'].pronunciation=lambda word_id: {'id':word_id,'available':['uk'],'preferred':'uk','uploaded':True,'alternative':None}
app.run(host="127.0.0.1",port=int(sys.argv[2]),debug=False,threaded=True)`;
  const server=spawn(path.join(__dirname,'..','.venv','bin','python'),['-u','-c',script,directory,String(port)],{cwd:path.join(__dirname,'..'),stdio:['ignore','ignore','pipe']});
  let startupErrors='';server.stderr.on('data',chunk=>startupErrors+=chunk);
  let browser;
  try {
    const base=`http://127.0.0.1:${port}`;
    let ready=false;
    for(let i=0;i<100;i++) {
      try {if((await fetch(base+'/api/health')).ok) {ready=true;break;}}catch{}
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert(ready,startupErrors);
    browser=await chromium.launch({headless:true,executablePath:process.env.TYPEWRITER_BROWSER_PATH || '/opt/google/chrome/chrome',args:['--no-sandbox']});
    const page=await browser.newPage({viewport:{width:1360,height:1050}});
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    async function screenshot(name) {
      if(!process.env.TYPEWRITER_SCREENSHOTS)return;
      fs.mkdirSync(process.env.TYPEWRITER_SCREENSHOTS,{recursive:true});
      await page.screenshot({path:path.join(process.env.TYPEWRITER_SCREENSHOTS,name+'.png'),animations:'disabled'});
    }
    await page.addInitScript(()=>{
      window.audioCalls=0;window.audioTimes=[];window.audioEnds=[];
      const original=HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play=function(...args) {
        if(this.id==='pronunciation'){window.audioCalls++;window.audioTimes.push(performance.now());if(!this._observed){this._observed=true;this.addEventListener('ended',()=>window.audioEnds.push(performance.now()));}}
        return original.apply(this,args);
      };
    });
    await page.goto(base);await page.waitForSelector('#app-content:not([hidden])');
    async function api(url,method='GET',data) {
      return page.evaluate(async({url,method,data})=>{
        const response=await fetch('/api'+url,{method,headers:{'Content-Type':'application/json','X-Typewriter-Token':document.querySelector('meta[name="typewriter-token"]').content},...(data!==undefined?{body:JSON.stringify(data)}:{})});
        const result=await response.json();assertResponse(response,result);return result;
        function assertResponse(response,result) {if(!response.ok) throw new Error(result.error);}
      },{url,method,data});
    }
    async function review(word) {
      await page.locator('.nav-item[data-page="words"]').click();
      await page.locator('#word-search').fill(word);
      if(await page.locator('#selection-bar').isVisible()) await page.locator('[data-action="clear-selection"]').click();
      await page.getByRole('checkbox',{name:'Select '+word,exact:true}).check();
      await page.locator('[data-action="review-selected"]').click();
      await page.waitForSelector('#practice-dialog[open]');
    }
    async function end() {await page.keyboard.press('Escape');await page.locator('[data-action="close-practice"]').click();}
    async function drill(){
      await page.locator('.nav-item[data-page="today"]').click();await page.locator('[data-action="choose-drill"]').click();await page.locator('#drill-search').fill('necessary');await page.locator('#drill-form button[type="submit"]').click();
    }
    await api('/settings','PUT',{autoplay_drill:true,play_after_answer:true,audio_repeat_gap_seconds:2});await page.evaluate(()=>refresh());
    await drill();await page.waitForFunction(()=>window.audioCalls===1);
    await page.keyboard.press('Alt+p');assert.equal(await page.evaluate(()=>window.audioCalls),1,'A manual duplicate is dropped');
    await page.locator('#answer').fill('wrong');await page.keyboard.press('Enter');await page.locator('#answer-form[data-result="incorrect"]').waitFor();
    assert.equal(await page.evaluate(()=>window.audioCalls),1,'An automatic answer replay in the cooldown is dropped');
    await page.keyboard.press('Enter');await page.locator('#drill-autoplay-toggle').click();
    await page.waitForTimeout(2200);assert.equal(await page.evaluate(()=>window.audioCalls),1,'Dropped requests never play later');
    await page.keyboard.press('Alt+p');await page.waitForFunction(()=>window.audioCalls===2);
    await page.locator('#answer').fill('necessary');await page.keyboard.press('Enter');await page.locator('#answer-form[data-result="correct"]').waitFor();await page.waitForTimeout(2200);assert.equal(await page.evaluate(()=>window.audioCalls),2,'Drill mute includes answer-feedback audio');await end();
    await drill();await page.waitForFunction(()=>window.audioCalls===3);assert.equal(await page.locator('#drill-autoplay-toggle').getAttribute('aria-pressed'),'false');await end();
    // A different word bypasses the cooldown, and a rejected play can be retried immediately.
    await page.evaluate(async()=>{
      const original=HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play=function(){if(this.id==='pronunciation' && window.rejectNextPlay){window.rejectNextPlay=false;return Promise.reject(new DOMException('Gesture required','NotAllowedError'));}return original.call(this);};
      window.rejectNextPlay=true;
      const word=state.words.find(w=>w.word==='missing');word.audio_flagged=false;
      practice={mode:'drill',queue:[word],index:0,quizSettings:{...state.settings,audio_repeat_gap_seconds:10}};
      document.querySelector('#practice-active').hidden=false;
      await listen(true);await listen(true);
    });
    await page.waitForFunction(()=>window.audioCalls===4);await page.evaluate(()=>{stopPronunciation();practice=null;});

    await api('/settings','PUT',{sentence_enabled:false,definition_enabled:false,audio_enabled:true,meaning_enabled:false,autoplay_audio:false,play_after_answer:false,audio_pause_minutes:2});await page.evaluate(()=>refresh());
    const before=await api('/export');await review('necessary');await page.locator('#pause-audio').click();await page.locator('#practice-summary').waitFor({state:'visible'});
    const after=await api('/export');assert.deepEqual(after.attempts,before.attempts);assert.deepEqual(after.words,before.words);
    assert((await api('/state')).settings.audio_enabled);assert(Date.parse((await api('/state')).audio_pause_until)>Date.now()+110000);
    await page.locator('[data-action="close-practice"]').click();await page.reload();await page.locator('#app-content').waitFor({state:'visible'});assert(await page.locator('#audio-pause-note').isVisible());
    await page.locator('[data-action="resume-audio"]').click();await page.waitForFunction(()=>document.querySelector('#audio-pause-note').hidden);
    await api('/settings','PUT',{sentence_enabled:true});await page.evaluate(()=>refresh());await review('necessary');assert(await page.locator('#pause-audio').isVisible());await page.locator('#pause-audio').click();
    await page.waitForFunction(()=>document.querySelector('#practice-label').textContent.includes('MISSING WORD'));assert.equal((await api('/export')).attempts.length,before.attempts.length);await end();await api('/practice/audio-pause','POST',{resume:true});await page.evaluate(()=>refresh());

    const original=(await api('/state')).words.find(w=>w.word==='necessary');
    await page.getByRole('button',{name:'Add words',exact:true}).click();await page.locator('#word-form input[name="word"]').fill('NECESSARY');await page.locator('#word-form textarea[name="definition"]').fill('Do not silently overwrite.');await page.locator('#word-submit').click();await page.locator('#duplicate-dialog').waitFor({state:'visible'});
    assert.equal((await api('/state')).words.find(w=>w.id===original.id).definition,original.definition);
    await page.locator('[data-edit-duplicate]').click();await page.waitForFunction(()=>document.querySelector('#word-dialog').open && document.querySelector('#word-form textarea[name=definition]').value==='Required.');assert.equal(await page.locator('#word-form textarea[name="definition"]').inputValue(),original.definition);await page.locator('#word-form textarea[name="definition"]').fill('Required for a particular purpose.');await page.locator('#word-submit').click();await page.locator('#word-dialog').waitFor({state:'hidden'});
    assert.equal((await api('/state')).words.find(w=>w.id===original.id).definition,'Required for a particular purpose.');
    await page.getByRole('button',{name:'Add words',exact:true}).click();await page.getByRole('button',{name:'A list of words',exact:true}).click();await page.locator('textarea[name="bulk"]').fill('necessary\nreliable');await page.locator('#word-submit').click();await page.locator('#duplicate-dialog').waitFor({state:'visible'});await page.locator('#duplicate-new-only').click();await page.locator('#word-dialog').waitFor({state:'hidden'});await page.locator('#duplicate-keep').click();
    assert.equal((await api('/state')).words.filter(w=>w.word==='necessary').length,1);assert((await api('/state')).words.some(w=>w.word==='reliable'));

    await page.locator('.nav-item[data-page="settings"]').click();await page.locator('#advanced-settings summary').click();await page.locator('[name="audio_repeat_gap_seconds"]').fill('0.8');await page.locator('[name="audio_pause_minutes"]').fill('7');await page.locator('#settings-form button[type="submit"]').click();await page.waitForFunction(()=>document.querySelector('#settings-unsaved-note').hidden);
    assert.equal((await api('/state')).settings.audio_repeat_gap_seconds,0.8);assert.equal((await api('/state')).settings.audio_pause_minutes,7);
    await page.setViewportSize({width:390,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.locator('#advanced-settings').scrollIntoViewIfNeeded();await screenshot('advanced-audio-mobile');
    const report=page.waitForRequest(request=>request.url().endsWith('/api/diagnostics'));
    const recorded=page.waitForResponse(response=>response.url().endsWith('/api/diagnostics'));
    await page.evaluate(()=>TypewriterDiagnostics.report('error',{filename:location.origin+'/static/essay_words.js',lineno:41,colno:7,message:'private-canary-do-not-send'}));
    const payload=(await report).postDataJSON();assert.deepEqual(Object.keys(payload).sort(),['column','kind','line','source']);assert.equal((await recorded).status(),202);
    const diagnosticLog=await (await page.request.get(base+'/api/logs/export')).text();assert(diagnosticLog.includes('essay_words.js'));assert(!diagnosticLog.includes('private-canary-do-not-send'));
    assert.deepEqual(errors,[]);console.log('Audio controls passed: dropped manual/automatic duplicate requests, immediate failure retry, session-only drill mute, manual replay, temporary audio-only pause and resume, unchanged grades, fallback exercises, duplicate confirmation/editing/bulk additions, advanced settings and mobile layout.');
  }finally{if(browser)await browser.close();server.kill('SIGTERM');await new Promise(resolve=>{if(server.exitCode!==null)resolve();else server.once('exit',resolve);});fs.rmSync(directory,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
