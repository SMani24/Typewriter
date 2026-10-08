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
    await review('missing');
    await page.locator('[data-action="listen"]').click();
    await page.waitForFunction(()=>document.querySelector('#playback-status').textContent.includes('No UK pronunciation available'));
    assert.equal(await page.locator('#toast').evaluate(el=>el.parentElement.id),'practice-dialog');
    assert(await page.locator('#toast').isVisible());
    await page.keyboard.press('Alt+p');
    await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('No UK pronunciation available'));
    assert.equal(await page.locator('#toast').evaluate(el=>el.parentElement.id),'practice-dialog');
    await page.setViewportSize({width:390,height:844});
    const warning=await page.locator('#toast').boundingBox();
    assert(warning && warning.y>=0 && warning.y+warning.height<=844,'Pronunciation warning stays within the mobile viewport');
    await screenshot('pronunciation-warning-mobile');
    await page.setViewportSize({width:1360,height:1050});
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
    const necessary=(await api('/state')).words.find(w=>w.word==='necessary');
    for(let i=0;i<2;i++) await api(`/words/${necessary.id}/attempts`,'POST',{answer:'neccessary',mode:'review'});
    await page.reload();await page.waitForSelector('#app-content:not([hidden])');
    await page.locator('.nav-item[data-page="today"]').click();
    assert((await page.locator('#drill-suggestions').innerText()).includes('necessary'));
    assert((await page.locator('#drill-suggestions').innerText()).includes('2 misses'));
    await screenshot('drill-suggestions');
    await page.locator('#drill-suggestions [data-drill]').click();
    await page.waitForSelector('#drill-dialog[open]');
    assert.equal(await page.locator('#drill-search').inputValue(),'necessary');
    assert((await page.locator('#drill-options').innerText()).includes('Suggested'));
    await page.locator('[data-close="drill-dialog"]').click();
    await api(`/words/${necessary.id}/attempts`,'POST',{answer:'necessary',mode:'drill'});
    assert((await api('/state')).words.find(w=>w.id===necessary.id).drill_recommended);
    await page.setViewportSize({width:390,height:844});
    await page.locator('.nav-item[data-page="words"]').click();
    assert((await page.locator('#word-list').innerText()).includes('Worth a drill'));
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.setViewportSize({width:1360,height:1050});
    for(let i=0;i<3;i++) await api(`/words/${necessary.id}/attempts`,'POST',{answer:'necessary',mode:'review'});
    await page.reload();await page.waitForSelector('#app-content:not([hidden])');
    await page.locator('.nav-item[data-page="today"]').click();
    assert(await page.locator('#drill-suggestions').isHidden());
    await page.locator('.nav-item[data-page="words"]').click();
    assert(!(await page.locator('#word-list').innerText()).includes('Worth a drill'));

    // Re-evaluation replies validate automatically, including files and stale replies.
    await page.locator('#word-search').fill('necessary');
    if(await page.locator('#selection-bar').isVisible()) await page.locator('[data-action="clear-selection"]').click();
    await page.getByRole('checkbox',{name:'Select necessary',exact:true}).check();
    await page.locator('[data-action="prepare-again"]').click();
    async function promptPayload(button,name) {
      const downloadEvent=page.waitForEvent('download');await button.click();
      const download=await downloadEvent;
      const file=path.join(directory,name+'.zip');await download.saveAs(file);
      return JSON.parse(execFileSync(path.join(__dirname,'..','.venv','bin','python'),['-c',`import sys,json,zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    text=z.read(next(n for n in z.namelist() if n!="README.md")).decode()
    print(json.dumps(json.loads(text.split(chr(96)*3+"json\\n")[1].split("\\n"+chr(96)*3)[0])))`,file],{encoding:'utf8'}));
    }
    const payload=await promptPayload(page.locator('[data-action="download-prompts"]'),'reevaluate');
    payload.words[0].definition='Essential for a particular purpose.';
    payload.words[0].sentence='Careful planning is necessary.';
    payload.words[0].tip='One c, two s.';
    payload.words[0].distractors=['Optional for a particular purpose.','Decorative rather than useful.','Unlikely to happen.'];
    const reply=JSON.stringify(payload);
    await page.locator('#prepared-response').fill(reply);
    await page.waitForFunction(()=>!document.querySelector('#apply-preparation').disabled);
    assert((await page.locator('#preparation-status').innerText()).includes('1 word ready to apply'));
    assert((await page.locator('#preparation-preview').innerText()).includes('Will replace'));
    await screenshot('automatic-reply-preview');

    // A delayed obsolete response must never re-enable Apply for newer invalid text.
    await page.evaluate(()=>{
      const original=window.fetch;window.delayNextPreview=true;
      window.fetch=async(...args)=>{
        const response=await original(...args);
        if(args[0]==='/api/preparation/preview' && window.delayNextPreview) {
          window.delayNextPreview=false;window.oldPreviewWaiting=true;
          await new Promise(resolve=>setTimeout(resolve,700));window.oldPreviewDelivered=true;
        }
        return response;
      };
    });
    await page.locator('#prepared-response').fill(reply+' ');
    await page.waitForFunction(()=>window.oldPreviewWaiting);
    await page.locator('#prepared-response').fill('{invalid}');
    await page.waitForFunction(()=>document.querySelector('#preparation-status').textContent.includes('Invalid JSON'));
    await page.waitForFunction(()=>window.oldPreviewDelivered);
    assert(await page.locator('#apply-preparation').isDisabled());
    assert((await page.locator('#preparation-status').innerText()).includes('line 1, column'));
    const invalid=structuredClone(payload);invalid.words[0].sentence='This omits the target.';
    await page.locator('#prepared-response').fill(JSON.stringify(invalid));
    await page.waitForFunction(()=>document.querySelector('#preparation-status').textContent.includes('necessary: the sentence'));
    assert(await page.locator('#apply-preparation').isDisabled());
    assert.equal((await api('/state')).words.find(w=>w.id===necessary.id).definition,necessary.definition);

    // A stalled local validation times out visibly and can be retried immediately.
    await page.evaluate(()=>{
      const original=window.fetch;
      window.fetch=(...args)=>{
        if(args[0]==='/api/preparation/preview') {
          window.fetch=original;
          return new Promise((resolve,reject)=>args[1].signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true}));
        }
        return original(...args);
      };
    });
    await page.locator('#prepared-response').fill(reply);
    await page.waitForFunction(()=>document.querySelector('#preparation-status').textContent.includes('Validation timed out'));
    assert.equal(await page.locator('#prepared-response').inputValue(),reply);
    assert(await page.locator('#apply-preparation').isDisabled());
    await page.locator('[data-action="preview-preparation"]').click();
    await page.waitForFunction(()=>!document.querySelector('#apply-preparation').disabled);
    await page.locator('[data-action="apply-preparation"]').click();
    await page.waitForFunction(()=>document.querySelector('#preparation-preview').textContent.includes('Reply imported'));
    assert.equal((await api('/state')).words.find(w=>w.id===necessary.id).definition,payload.words[0].definition);
    assert.equal(await page.locator('#prepared-response').inputValue(),reply);

    // The same reply cannot overwrite an imported replacement; export a new batch.
    await page.locator('#prepared-file').setInputFiles({name:'reply.json',mimeType:'application/json',buffer:Buffer.from(reply)});
    await page.waitForFunction(()=>document.querySelector('#preparation-status').textContent.includes('already imported'));
    assert(await page.locator('#apply-preparation').isDisabled());
    const fresh=await promptPayload(page.locator('[data-action="fresh-preparation"]'),'fresh');
    assert.notEqual(fresh.batch_id,payload.batch_id);
    assert.deepEqual(fresh.words.map(w=>w.word),['necessary']);
    assert(await page.locator('#prompt-reevaluate').isChecked());
    const noCalls=await api('/state');assert.equal(noCalls.enrichment.requests_today,0);
    await page.locator('[data-close="preparation-dialog"]').click();

    assert.deepEqual(errors,[]);
    console.log('Update checks passed: missing pronunciation warnings stay in front of practice for clicks and keyboard shortcuts, saved accent choice, silent preloading, replay without another request, playback cleanup, drill suggestions and picker labels, mobile layout, retirement after successful recall, automatic pasted/file previews, invalid and stale replies, obsolete-response protection, visible timeout and retry, and fresh re-evaluation prompts.');
  } finally {
    if(browser) await browser.close();
    server.kill('SIGTERM');
    await new Promise(resolve=>{if(server.exitCode!==null)resolve();else server.once('exit',resolve);});
    fs.rmSync(directory,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
