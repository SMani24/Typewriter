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
    const id=(await api('/state')).words.find(w=>w.word==='necessary').id;
    const before=(await api('/export')).attempts.length;
    await review('necessary');await page.locator('[data-action="flag-practice-sentence"]').click();
    await page.waitForFunction(()=>document.querySelector('#answer').disabled);
    assert.match(await page.locator('#practice-feedback').textContent(),/Example flagged/);
    assert.equal((await api('/export')).attempts.length,before);
    assert.equal((await api('/state')).words.find(w=>w.id===id).clue,'');await end();
    await page.locator(`[data-edit="${id}"]`).click();
    assert.match(await page.locator('#sentence-status').textContent(),/flagged for improvement/);
    assert(await page.locator('[data-action="restore-sentence"]').isVisible());
    await page.locator('[data-action="flag-edit-meaning"]').click();
    await page.locator('[data-close="word-dialog"]').click();
    await page.locator('[data-action="offline-preparation"]').first().click();
    assert.match(await page.locator('#prompt-count').textContent(),/1 word/);
    await page.locator('[data-close="preparation-dialog"]').first().click();
    // Both kinds of clue can be repaired manually, or in a scoped external-LLM reply.
    await page.locator(`[data-edit="${id}"]`).click();
    await page.locator('#word-form textarea[name="sentence"]').fill('Regular practice is necessary if you want to improve your spelling.');
    await page.locator('#word-form textarea[name="definition"]').fill('Required for a particular purpose.');await page.locator('#word-submit').click();
    await page.waitForSelector('#word-dialog',{state:'hidden'});
    const repaired=(await api('/state')).words.find(w=>w.id===id);assert.equal(repaired.sentence_flagged,0);assert.equal(repaired.meaning_flagged,0);
    await api('/words','POST',{words:Array.from({length:26},(_,i)=>({word:'review'+String.fromCharCode(97+i),definition:'A useful clue.',sentence:'This review'+String.fromCharCode(97+i)+' example has enough words.'}))});
    await api('/settings','PUT',{review_session_size:0,meaning_enabled:false});await page.reload();await page.waitForSelector('#app-content:not([hidden])');
    await page.locator('.nav-item[data-page="settings"]').click();
    assert(await page.locator('#review-all-due').isChecked());assert.equal(await page.locator('#review-session-size').inputValue(),'0');
    await page.locator('.nav-item[data-page="today"]').click();assert.match(await page.locator('#hero-note').textContent(),/All 28 words/);
    await page.locator('[data-action="review"]').click();await page.waitForSelector('#practice-dialog[open]');
    assert.match(await page.locator('#practice-count').textContent(),/OF 28/);await end();
    await page.locator('.nav-item[data-page="settings"]').click();await page.locator('#review-all-due').uncheck();
    assert.equal(await page.locator('#review-session-size').inputValue(),'10');
    await page.locator('#review-session-size').fill('3');assert(!(await page.locator('#review-all-due').isChecked()));
    await page.locator('#settings-form button[type="submit"]').click();await page.reload();await page.waitForSelector('#app-content:not([hidden])');
    assert.equal(await page.locator('#review-session-size').inputValue(),'3');
    await page.locator('.nav-item[data-page="today"]').click();await page.locator('[data-action="review"]').click();await page.waitForSelector('#practice-dialog[open]');
    assert.match(await page.locator('#practice-count').textContent(),/OF 3/);await end();
    await page.setViewportSize({width:390,height:844});await page.locator('.nav-item[data-page="settings"]').click();
    assert(await page.locator('.session-length').evaluate(node=>node.scrollWidth<=node.clientWidth));
    assert.deepEqual(errors,[]);
    console.log('Clue requests passed: flag during practice without grading, queued examples and meanings, manual repair, all 28 due words by default, saved limits, all-due shortcut, and mobile layout.');
  }finally{if(browser)await browser.close();server.kill('SIGTERM');await new Promise(resolve=>server.once('exit',resolve));fs.rmSync(directory,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
