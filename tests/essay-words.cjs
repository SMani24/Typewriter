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
app.extensions["dictionary"].pronunciation=lambda word_id: {"id":word_id,"available":["uk"],"preferred":"uk","uploaded":False,"alternative":None}
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
    const baseline=(await api('/export')).attempts.length;
    assert(await page.evaluate(async()=>{const row=document.querySelector('#word-list .library-row');await refresh();return row===document.querySelector('#word-list .library-row');}),'Unchanged notebook rows survive a refresh');
    await page.locator('.nav-item[data-page="essay"]').click();const area=page.locator('#essay-body');await area.waitFor({state:'visible'});
    await area.fill('1. First item');await area.press('End');await area.press('Enter');assert.equal(await area.inputValue(),'1. First item\n2. ');
    await area.type('Second item');await area.press('Tab');assert.equal(await area.inputValue(),'1. First item\n    2. Second item');await area.press('Shift+Tab');assert.equal(await area.inputValue(),'1. First item\n2. Second item');
    await area.press('Control+z');assert.equal(await area.inputValue(),'1. First item\n    2. Second item');
    await area.fill('- First');await area.press('End');await area.press('Enter');assert.equal(await area.inputValue(),'- First\n- ');await area.press('Enter');assert.equal(await area.inputValue(),'- First\n');
    const draft='A neccessary change. My CV lists the downsides of the enviroment.';
    await area.fill(draft);await page.locator('#essay-highlight').check();await page.waitForFunction(()=>document.querySelectorAll('#essay-highlight-content mark').length===2);
    await page.locator('#essay-words-open').click();await page.waitForFunction(()=>document.querySelectorAll('.essay-word-row').length===2);
    assert.equal(await page.locator('.essay-word-row input[type="checkbox"]').count(),0);
    const row=word=>page.locator('.essay-word-row').filter({has:page.locator('.essay-word-source strong',{hasText:word})});
    await row('neccessary').locator('input').fill('necessary');await row('neccessary').locator('input').press('Enter');await page.waitForSelector('#essay-intake-dialog[open]');
    assert.match(await page.locator('#essay-intake-dialog').textContent(),/outside practice/);await page.locator('#essay-intake-confirm').click();await page.waitForSelector('#essay-intake-dialog',{state:'hidden'});
    let notebook=(await api('/state')).words;assert.equal(notebook.find(w=>w.word==='necessary').essay_pending,true);assert.equal((await api('/export')).attempts.length,baseline);
    await page.locator('[data-close="essay-words-dialog"]').first().click();await area.fill(draft+' An accomodation.');await page.locator('#essay-words-open').click();
    await page.waitForFunction(()=>document.querySelectorAll('.essay-word-row').length===3);
    assert.equal(await page.locator('.essay-word-source strong').first().textContent(),'accomodation');assert(await row('neccessary').locator('input').isDisabled());
    await row('enviroment').locator('input').fill('environment');await row('enviroment').locator('[data-add-row]').click();await page.locator('#essay-intake-confirm').click();await page.waitForSelector('#essay-intake-dialog',{state:'hidden'});
    notebook=(await api('/state')).words;assert.equal(notebook.find(w=>w.word==='environment').preparation_queue,'manual');assert.equal(notebook.find(w=>w.word==='environment').practice_ready,false);
    await row('accomodation').locator('input').fill('accommodation');await row('accomodation').locator('[data-add-row]').click();await page.locator('input[name="essay-intake-mode"][value="llm"]').check();await page.locator('#essay-intake-auto-voice').uncheck();await page.locator('#essay-intake-confirm').click();await page.waitForSelector('#essay-intake-dialog',{state:'hidden'});
    assert.equal((await api('/state')).words.find(w=>w.word==='accommodation').preparation_queue,'llm');
    const token=await page.locator('meta[name="typewriter-token"]').getAttribute('content');
    const replyFile=path.join(directory,'queued.zip');const response=await page.request.post(base+'/api/preparation/export',{headers:{'X-Typewriter-Token':token},data:{size:20}});assert(response.ok());fs.writeFileSync(replyFile,await response.body());
    const reply=execFileSync(path.join(__dirname,'..','.venv','bin','python'),['-c',`import json,sys,zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
 p=z.read(next(n for n in z.namelist() if n!='README.md')).decode()
 d=json.loads(p.split(chr(96)*3+'json\\n')[1].split('\\n'+chr(96)*3)[0])
 assert len(d['words'])==1 and d['words'][0]['word']=='accommodation'
 d['words'][0].update(definition='A place to stay.',sentence='We booked accommodation near the station for our trip.',tip='Two c and two m letters.',distractors=['A means of transport.','A written agreement.','A financial penalty.'])
 print(json.dumps(d))`,replyFile],{encoding:'utf8'});
    await api('/preparation/import','POST',{text:reply});assert.equal((await api('/state')).words.find(w=>w.word==='accommodation').practice_ready,true);
    await page.locator('[data-close="essay-words-dialog"]').first().click();await page.locator('.nav-item[data-page="words"]').click();
    const environment=(await api('/state')).words.find(w=>w.word==='environment');await page.locator(`[data-edit="${environment.id}"]`).click();
    assert(await page.locator('#word-queue-note').isVisible());await page.locator('#word-form textarea[name="definition"]').fill('The surroundings in which something lives.');await page.locator('#activate-word').check();await page.locator('#word-submit').click();await page.waitForSelector('#word-dialog',{state:'hidden'});
    assert.equal((await api('/state')).words.find(w=>w.id===environment.id).practice_ready,true);
    await page.locator('.nav-item[data-page="essay"]').click();await area.fill('CV downsides AnkiAutomata neccessary.');await area.evaluate(node=>node.setSelectionRange(18,18));await area.press('Control+.');await page.waitForSelector('#personal-dictionary-dialog[open]');
    assert.equal(await page.locator('#personal-word').inputValue(),'AnkiAutomata');await page.locator('#save-personal-word').click();await page.waitForFunction(()=>document.querySelector('#personal-word-count').textContent.includes('1 saved'));
    await page.locator('[data-close="personal-dictionary-dialog"]').click();await page.waitForFunction(()=>document.querySelectorAll('#essay-highlight-content mark').length===1);
    await page.locator('#essay-words-open').click();await page.waitForSelector('#essay-words-dialog[open]');assert.equal(await row('AnkiAutomata').count(),0);
    await page.locator('[data-close="essay-words-dialog"]').first().click();await area.fill('A definate mistake.');await page.locator('#essay-words-open').click();await page.waitForFunction(()=>document.querySelector('.essay-word-source strong').textContent==='definate');
    await row('definate').locator('[data-discard-row]').click();assert.equal(await row('definate').count(),0);await page.locator('[data-close="essay-words-dialog"]').first().click();await page.locator('#essay-words-open').click();await page.waitForSelector('#essay-words-dialog[open]');assert.equal(await row('definate').count(),0);
    await page.locator('[data-close="essay-words-dialog"]').first().click();await page.locator('#essay-save').click();await page.waitForFunction(()=>document.querySelector('#essay-save-status').textContent==='Saved on this computer.');
    await page.reload();await page.waitForSelector('#app-content:not([hidden])');assert.equal((await api('/essay/dictionary')).words[0],'ankiautomata');
    await page.setViewportSize({width:390,height:844});await page.locator('.nav-item[data-page="essay"]').click();await page.locator('#essay-words-open').click();await page.waitForSelector('#essay-words-dialog[open]');assert(await page.locator('#essay-words-dialog').evaluate(node=>node.scrollWidth<=node.clientWidth));await screenshot('essay-intake-mobile');
    assert.deepEqual(errors,[]);console.log('Essay workflow passed: list continuation, Tab/outdent/undo, current flags merged first, persistent icon discard, manual/LLM queues, existing-word evidence, personal dictionary shortcut, protected writing, and mobile layout.');
  }finally{if(browser)await browser.close();server.kill('SIGTERM');await new Promise(resolve=>server.once('exit',resolve));fs.rmSync(directory,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
