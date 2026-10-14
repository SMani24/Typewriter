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
    }
    async function end() {await page.keyboard.press('Escape');await page.locator('[data-action="close-practice"]').click();}
    await page.locator('.nav-item[data-page="essay"]').click();
    await page.waitForFunction(()=>!document.getElementById('essay-body').disabled);
    assert.equal(await page.locator('#essay-body').getAttribute('spellcheck'),'false');
    assert.equal(await page.locator('#essay-body').getAttribute('autocorrect'),'off');
    const text='🙂 I need accomodation, colour and color.\n\n<script>alert("x")</script>';
    let checks=0;page.on('request',request=>{if(request.url().endsWith('/essay/spelling'))checks++;});
    await page.locator('#essay-title').fill('My practice essay');
    await page.locator('#essay-prompt').fill('Discuss both views.');
    await page.locator('#essay-body').fill(text);
    await page.waitForFunction(()=>document.getElementById('essay-save-status').textContent==='Saved on this computer.');
    assert.equal((await api('/essay')).body,text);assert.equal(checks,0);
    await page.locator('#essay-highlight').check();
    await page.waitForSelector('#essay-highlight-content mark');
    assert((await page.locator('#essay-highlight-content mark').allTextContents()).includes('accomodation'));
    assert.equal(await page.locator('#essay-highlight-content script').count(),0);
    assert.equal(await page.locator('#essay-body').inputValue(),text);
    if(process.env.TYPEWRITER_SCREENSHOTS) {
      fs.mkdirSync(process.env.TYPEWRITER_SCREENSHOTS,{recursive:true});
      await page.locator('.essay-paper').screenshot({path:path.join(process.env.TYPEWRITER_SCREENSHOTS,'essay-spelling.png')});
    }
    await page.locator('#essay-highlight').uncheck();
    const previous=checks;
    await page.locator('#essay-body').fill('Spelling hints stay off for accomodation.');
    await page.waitForTimeout(500);
    assert.equal(checks,previous);assert.equal(await page.locator('#essay-highlight-content mark').count(),0);
    // Newer typing must survive an older save response.
    let release;const held=new Promise(resolve=>release=resolve);let holdNext=true;
    await page.route('**/api/essay',async route=>{
      if(route.request().method()==='PUT'&&holdNext) {holdNext=false;await held;}
      await route.continue();
    });
    const pending=page.waitForRequest(r=>r.url().endsWith('/api/essay')&&r.method()==='PUT');
    await page.locator('#essay-body').fill('First draft while saving.');await pending;
    const newer='Newer writing must survive the previous save.';
    await page.locator('#essay-body').fill(newer);release();
    await page.waitForFunction(()=>document.getElementById('essay-save-status').textContent==='Saved on this computer.');
    assert.equal(await page.locator('#essay-body').inputValue(),newer);
    assert.equal((await api('/essay')).body,newer);await page.unroute('**/api/essay');
    // A failed save retains a per-tab recovery copy that survives reloading.
    await page.route('**/api/essay',async route=>{
      if(route.request().method()==='PUT') await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Temporary save failure.'})});
      else await route.continue();
    });
    const recovered='This unsaved writing should be recovered after refresh.';
    await page.locator('#essay-body').fill(recovered);
    await page.waitForFunction(()=>document.getElementById('essay-save-status').classList.contains('error'));
    assert.equal((await api('/essay')).body,newer);await page.unroute('**/api/essay');
    page.once('dialog',dialog=>dialog.accept());await page.reload();
    await page.waitForFunction(value=>document.getElementById('essay-body').value===value,recovered);
    await page.waitForFunction(()=>document.getElementById('essay-save-status').textContent==='Saved on this computer.');
    assert.equal((await api('/essay')).body,recovered);
    // Stale tabs do not overwrite a newer saved essay; recovery needs an explicit choice.
    const current=await api('/essay');await api('/essay','PUT',{...current,body:'Writing saved from another tab.'});
    const own='My separate draft stays available for download.';
    await page.locator('#essay-body').fill(own);
    await page.waitForFunction(()=>document.getElementById('essay-save-status').textContent.includes('another tab'));
    assert.equal((await api('/essay')).body,'Writing saved from another tab.');
    const download=page.waitForEvent('download');await page.locator('#essay-download').click();
    assert(fs.readFileSync(await (await download).path(),'utf8').includes(own));
    page.once('dialog',dialog=>dialog.accept());await page.reload();
    await page.waitForSelector('#essay-recovery:not([hidden])');
    assert.equal(await page.locator('#essay-body').inputValue(),'Writing saved from another tab.');
    await page.locator('#essay-restore').click();
    await page.waitForFunction(()=>document.getElementById('essay-save-status').textContent==='Saved on this computer.');
    assert.equal((await api('/essay')).body,own);
    for(const width of [1360,390]) for(const size of ['small','default','large','extra-large']) {
      await api('/settings','PUT',{text_size:size});await page.setViewportSize({width,height:1000});
      await page.reload();await page.waitForFunction(()=>!document.getElementById('essay-body').disabled);
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),size+' essay at '+width);
      assert(await page.locator('.essay-paper').evaluate(d=>d.scrollWidth<=d.clientWidth));
    }
    await page.locator('#essay-body').fill(('A necessary thought about accommodation.\n').repeat(60)+'accomodation');
    await page.locator('#essay-highlight').check();await page.waitForSelector('#essay-highlight-content mark');
    await page.locator('#essay-body').evaluate(a=>{a.scrollTop=300;a.dispatchEvent(new Event('scroll'));});
    assert((await page.locator('#essay-highlight-content').getAttribute('style')).includes('-300px'));
    assert.equal(await page.locator('#essay-highlights').evaluate(d=>d.clientWidth),await page.locator('#essay-body').evaluate(d=>d.clientWidth));
    await page.waitForFunction(()=>document.getElementById('essay-save-status').textContent==='Saved on this computer.');
    assert.deepEqual(errors,[]);
    console.log('Essay checks passed: exact local autosave, optional offline underlines, safe text rendering, newer edits during saves, reload recovery, tab conflicts, download, all text sizes, and scrolling highlights.');
  } finally {
    if(browser) await browser.close();server.kill('SIGTERM');
    await new Promise(resolve=>{if(server.exitCode!==null)resolve();else server.once('exit',resolve);});
    fs.rmSync(directory,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
