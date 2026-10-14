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
app.extensions["dictionary"].lookup=lambda word,**kwargs: {"audio":{"us":"https://dictionary.cambridge.org/color-us.mp3"} if word=="color" else {},"senses":[]}
def no_network(*args,**kwargs):
    raise AssertionError("No provider requests allowed in browser checks")
app.extensions["network"].request=no_network
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
    async function checkHelp(engine) {
      if(!await page.locator('#review-ranking-help').evaluate(d=>d.open)) await page.locator('#review-ranking-help summary').click();
      const text=await page.locator('#review-ranking-help').innerText();
      assert(text.includes('Using '+engine));
      assert(text.includes('Every fifth normal spelling question'));
      assert(text.includes('Meanings have their own ranking'));
      if(engine==='FSRS') {
        assert(text.includes('lowest estimated chance of recall'));
        assert(text.includes('90% retention'));
        assert(text.includes('several times in one day'));
        assert(!text.includes('last eight spaced spelling recalls'));
        assert(!text.includes('1, 3, 7, 14, then 30 days'));
      } else {
        assert(text.includes('last eight spaced spelling recalls'));
        assert(text.includes('1, 3, 7, 14, then 30 days'));
        assert(!text.includes('90% retention'));
      }
    }
    await page.locator('.nav-item[data-page="settings"]').click();
    assert((await page.locator('#scheduler-current').innerText()).includes('Legacy'));
    await checkHelp('Legacy');
    await page.locator('#scheduler-switch').click();
    await page.waitForSelector('#scheduler-dialog[open]');
    assert((await page.locator('#scheduler-workload').innerText()).includes('2 due now'));
    assert.equal((await api('/state')).settings.scheduler,'legacy');
    await checkHelp('Legacy');
    for(const width of [1360,390]) {
      await page.setViewportSize({width,height:1000});
      assert(await page.locator('#scheduler-dialog').evaluate(d=>d.scrollWidth<=d.clientWidth));
    }
    await page.setViewportSize({width:1360,height:1050});
    await screenshot('scheduler-preview');
    // Cancel is read-only.
    await page.locator('#scheduler-dialog [data-close]').first().click();
    assert.equal((await api('/state')).settings.scheduler,'legacy');
    await page.locator('#scheduler-switch').click();
    await page.locator('#scheduler-confirm').click();
    await page.waitForFunction(()=>document.querySelector('#scheduler-current').textContent.includes('FSRS'));
    assert.equal((await api('/state')).settings.scheduler,'fsrs');
    await checkHelp('FSRS');
    await page.reload();await page.waitForSelector('#app-content:not([hidden])');
    await page.locator('.nav-item[data-page="settings"]').click();
    assert((await page.locator('#scheduler-current').innerText()).includes('FSRS'));
    await checkHelp('FSRS');
    // A preview becomes stale when another tab changes data.
    await page.locator('#scheduler-switch').click();
    await page.waitForSelector('#scheduler-dialog[open]');
    await api('/settings','PUT',{audio_volume:80});
    await page.locator('#scheduler-confirm').click();
    await page.waitForFunction(()=>document.querySelector('#scheduler-switch-error').textContent.includes('out of date'));
    assert.equal((await api('/state')).settings.scheduler,'fsrs');
    await page.locator('[data-action="refresh-scheduler-preview"]').click();
    await page.waitForFunction(()=>document.querySelector('#scheduler-confirm').hidden===false);
    await page.locator('#scheduler-dialog [data-close]').first().click();
    // FSRS spelling, due-state changes, Enter corrections/advancement and number-key quizzes.
    await api('/settings','PUT',{sentence_enabled:true,meaning_enabled:true,quiz_interval_min:1,quiz_interval_max:1});
    await page.reload();await page.waitForSelector('#app-content:not([hidden])');
    await page.locator('.nav-item[data-page="today"]').click();
    await page.locator('[data-action="review"]').click();
    await page.waitForSelector('#practice-dialog[open]');
    let previewRejected=false;
    try {await api('/scheduler/preview','POST',{target:'legacy'});} catch(e) {previewRejected=e.message.includes('End your practice');}
    assert(previewRejected);
    await page.locator('#answer').fill('wrong');await page.keyboard.press('Enter');
    await page.waitForSelector('.letter-diff');
    await page.keyboard.press('Enter');
    await page.locator('#answer').fill('necessary');await page.keyboard.press('Enter');
    await page.waitForFunction(()=>document.querySelector('#practice-feedback').textContent.includes('corrected'));
    await page.keyboard.press('Enter');
    await page.waitForSelector('.meaning-choice');
    await page.keyboard.press('1');
    await page.waitForFunction(()=>document.querySelector('#answer').disabled && !document.querySelector('#answer-submit').hidden);
    await page.keyboard.press('Enter');
    await page.waitForFunction(()=>document.querySelector('#practice-mode').textContent.includes('SPELLING'));
    await page.locator('#answer').fill('missing');await page.keyboard.press('Enter');
    await page.waitForFunction(()=>document.querySelector('#practice-feedback').textContent.includes('Correct spelling'));
    await end();
    // FSRS also preserves keyboard audio-only practice and deliberate drills.
    await api('/settings','PUT',{sentence_enabled:false,meaning_enabled:false,audio_enabled:true});
    await page.reload();await page.waitForSelector('#app-content:not([hidden])');
    await review('necessary');await page.waitForSelector('#practice-dialog[open]');
    await page.waitForFunction(()=>document.querySelector('#pronunciation').currentTime>0);
    await page.locator('#answer').fill('necessary');await page.keyboard.press('Enter');
    await page.waitForFunction(()=>document.querySelector('#practice-feedback').textContent.includes('Correct spelling'));
    await end();
    await page.locator('.nav-item[data-page="today"]').click();
    await page.locator('[data-action="choose-drill"]').click();
    await page.locator('#drill-search').fill('necessary');await page.locator('#drill-search').press('Enter');
    await page.locator('#drill-form button[type="submit"]').click();
    await page.waitForSelector('#practice-dialog[open]');
    await page.locator('#answer').fill('necessary');await page.keyboard.press('Enter');
    await page.waitForFunction(()=>document.querySelector('#practice-feedback').textContent.includes('Correct spelling'));
    await end();
    const saved=await api('/export');
    assert(saved.attempts.some(a=>a.scheduler==='fsrs' && a.fsrs_rating===1));
    assert(saved.attempts.some(a=>a.scheduler==='fsrs' && a.fsrs_rating===3));
    assert.equal(saved.scheduling.selected,'fsrs');
    assert(saved.attempts.filter(a=>['correction','meaning','drill'].includes(a.mode)).every(a=>a.fsrs_rating===0));
    // Return to Legacy without losing history, then reopen and finish a short review.
    await page.locator('.nav-item[data-page="settings"]').click();
    await page.locator('#scheduler-switch').click();await page.locator('#scheduler-confirm').click();
    await page.waitForFunction(()=>document.querySelector('#scheduler-current').textContent.includes('Legacy'));
    assert.equal((await api('/export')).attempts.length,saved.attempts.length);
    await checkHelp('Legacy');
    await page.locator('.nav-item[data-page="progress"]').click();
    assert((await page.locator('#spaced-progress').innerText()).includes('spaced spelling recalls'));
    await page.locator('.nav-item[data-page="settings"]').click();
    // Scheduler card stays readable at every text size on a phone.
    for(const size of ['small','default','large','extra-large']) {
      await api('/settings','PUT',{text_size:size});
      await page.reload();await page.waitForSelector('#app-content:not([hidden])');
      await page.locator('.nav-item[data-page="settings"]').click();
      await page.setViewportSize({width:390,height:1000});
      await checkHelp('Legacy');
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),size+' scheduler settings overflow');
    }
    assert.deepEqual(errors,[]);
    console.log('Scheduler browser checks passed: preview/cancel/confirm, stale revisions, persisted opt-in/rollback, active-session guard, keyboard correction/quizzes, separated evidence, engine-specific help before/after switching and reload, and mobile text sizes.');
  } finally {
    if(browser) await browser.close();server.kill('SIGTERM');
    await new Promise(resolve=>{if(server.exitCode!==null)resolve();else server.once('exit',resolve);});
    fs.rmSync(directory,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
