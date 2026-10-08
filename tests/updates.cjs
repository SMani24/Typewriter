/* Focused checks for the notebook's feature/bug queue, without provider requests. */
const {chromium}=require('playwright');
const {spawn}=require('node:child_process');
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
app.extensions["dictionary"].lookup=lambda word: {"audio":{},"senses":[]}
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
    await review('missing');
    await page.locator('[data-action="listen"]').click();
    await page.waitForFunction(()=>document.querySelector('#playback-status').textContent.includes('No UK pronunciation available'));
    assert.equal(await page.locator('#toast').evaluate(el=>el.parentElement.id),'practice-dialog');
    assert(await page.locator('#toast').isVisible());
    await page.keyboard.press('Alt+p');
    await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('No UK pronunciation available'));
    assert.equal(await page.locator('#toast').evaluate(el=>el.parentElement.id),'practice-dialog');
    await end();

    await page.locator('.nav-item[data-page="settings"]').click();
    await page.locator('select[name="pronunciation_accent"]').selectOption('us');
    await page.getByRole('button',{name:'Save settings',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('#toast').textContent==='Settings saved.');
    await page.reload();await page.waitForSelector('#app-content:not([hidden])');
    assert.equal(await page.locator('select[name="pronunciation_accent"]').inputValue(),'us');
    let audioRequests=0;
    page.on('request',request=>{if(request.url().includes('/audio?'))audioRequests++;});
    await review('necessary');
    await page.waitForFunction(()=>document.querySelector('#pronunciation').readyState>=2);
    assert(await page.locator('#pronunciation').evaluate(a=>a.paused && a.currentTime===0));
    await page.locator('[data-action="listen"]').click();
    await page.waitForFunction(()=>document.querySelector('#pronunciation').currentTime>0);
    assert((await page.locator('#pronunciation').getAttribute('src')).includes('accent=us'));
    await page.waitForFunction(()=>document.querySelector('#pronunciation').ended);
    const loadedRequests=audioRequests;
    await page.locator('#answer').focus();
    await page.evaluate(()=>{window.replayStarted=false;document.querySelector('#pronunciation').addEventListener('playing',()=>window.replayStarted=true,{once:true});});
    await page.keyboard.press('Alt+p');
    await page.waitForFunction(()=>window.replayStarted);
    assert.equal(audioRequests,loadedRequests,'Replay must reuse the loaded clip');
    await end();
    assert(await page.locator('#pronunciation').evaluate(a=>a.paused && !a.hasAttribute('src')));
    assert.deepEqual(errors,[]);
    console.log('Update checks passed: missing pronunciation warnings stay in front of practice for clicks and keyboard shortcuts, saved accent choice, silent preloading, replay without another request, and playback cleanup.');
  } finally {
    if(browser) await browser.close();
    server.kill('SIGTERM');
    await new Promise(resolve=>{if(server.exitCode!==null)resolve();else server.once('exit',resolve);});
    fs.rmSync(directory,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
