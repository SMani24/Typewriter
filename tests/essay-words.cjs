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
    const text='🙂 I need accomodation and necesary. Accomodation needs speling. It is definately useful. Zzpropername.';
    const row=original=>page.locator('.essay-word-row').filter({has:page.locator('.essay-word-source strong',{hasText:new RegExp('^'+original+'$','i')})});
    async function openWords() {await page.locator('#essay-words-open').click();await page.waitForSelector('#essay-words-dialog[open]');await page.waitForFunction(()=>!document.querySelector('#essay-words-extract').disabled);}
    async function preview(payload,file=false) {
      if(!await page.locator('.essay-llm-review').evaluate(d=>d.open)) await page.locator('.essay-llm-review summary').click();
      if(file) await page.locator('#essay-words-file').setInputFiles({name:'reply.md',mimeType:'text/markdown',buffer:Buffer.from('```json\n'+JSON.stringify(payload)+'\n```')});
      else {await page.locator('#essay-words-reply').fill(JSON.stringify(payload));await page.locator('#essay-words-preview').click();}
      await page.waitForFunction(()=>!document.querySelector('#essay-words-use').disabled);
    }
    await page.locator('.nav-item[data-page="essay"]').click();await page.waitForFunction(()=>!document.querySelector('#essay-body').disabled);
    await page.locator('#essay-body').fill(text);
    await page.waitForFunction(()=>document.querySelector('#essay-save-status').textContent==='Saved on this computer.');
    assert.equal(await page.locator('#essay-highlight').isChecked(),false);
    // Extraction works while visual spelling hints are off.
    await openWords();assert.equal(await page.locator('.essay-word-row').count(),5);
    assert((await row('accomodation').innerText()).includes('2 occurrences'));
    assert.equal((await api('/state')).words.length,2);
    await row('accomodation').locator('input[type=text]').fill('accommodation');
    await row('accomodation').locator('input[type=text]').press('Enter');
    await page.waitForFunction(()=>document.querySelector('#essay-words-status').textContent.includes('1 new word added'));
    assert.equal((await api('/state')).words.filter(w=>w.word==='accommodation').length,1);
    await row('necesary').locator('input[type=text]').fill('necessary');
    assert(await row('necesary').getByRole('button',{name:'Add word',exact:true}).isDisabled());
    assert((await row('necesary').innerText()).includes('Already in your notebook'));
    // ZIP batches contain only selected flags; excerpts are off unless explicitly chosen.
    await page.locator('.essay-llm-review summary').click();
    await page.locator('#essay-words-size').fill('2');
    const downloaded=page.waitForEvent('download');await page.locator('#essay-words-export').click();const download=await downloaded;
    const archive=await download.path();
    const prompts=JSON.parse(execFileSync(path.join(__dirname,'..','.venv','bin','python'),['-c','import json,sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); print(json.dumps([z.read(n).decode() for n in z.namelist() if n!="README.md"]))',archive],{encoding:'utf8'}));
    assert.equal(prompts.length,2);assert(prompts.every(p=>!p.includes('"context":')));
    const replies=prompts.map(prompt=>JSON.parse(prompt.match(/```json\n([\s\S]*?)\n```/)[1]));
    const corrections={necesary:'necessary',speling:'spelling',definately:'definitely'};
    for(const reply of replies) for(const entry of reply.words) {
      const corrected=corrections[entry.original.toLowerCase()];Object.assign(entry,{action:corrected?'add':'skip',word:corrected || '',reason:corrected?'Check these letters.':'Possibly a proper name. <img src=x onerror=alert(1)>'});
    }
    // Manual work made after export wins over an older LLM suggestion.
    await row('speling').locator('input[type=text]').fill('written');
    await preview(replies[0]);assert.equal((await api('/state')).words.length,3);
    await page.locator('#essay-words-use').click();
    assert.equal(await row('speling').locator('input[type=text]').inputValue(),'written');
    await preview(replies[1],true);
    assert.equal(await page.locator('#essay-words-reply-preview img').count(),0);
    await page.locator('#essay-words-use').click();
    assert.equal(await row('Zzpropername').locator('input[type=checkbox]').isChecked(),false);
    assert.equal(await row('definately').locator('input[type=text]').inputValue(),'definitely');
    assert((await page.locator('#essay-words-add').innerText()).includes('2 ready words'));
    await screenshot('essay-word-review');
    // Manual review state survives closing and reloading this tab.
    await page.locator('#essay-words-dialog [data-close]').first().click();
    await page.reload();await page.waitForSelector('#app-content:not([hidden])');
    await page.locator('.nav-item[data-page="essay"]').click();await openWords();
    assert.equal(await row('speling').locator('input[type=text]').inputValue(),'written');
    await page.locator('#essay-words-add').click();
    await page.waitForFunction(()=>document.querySelector('#essay-words-status').textContent.includes('2 new words added'));
    let notebook=await api('/state');assert.deepEqual(notebook.words.map(w=>w.word).sort(),['accommodation','definitely','missing','necessary','written']);
    assert.equal(notebook.progress.reviews,0);assert.equal((await api('/essay')).body,text);
    // Replaying old suggestions cannot duplicate or replace saved work.
    await preview(replies[1]);await page.locator('#essay-words-use').click();
    assert(await page.locator('#essay-words-add').isDisabled());
    // Two different flags corrected to the same word are added only once.
    await page.locator('#essay-words-dialog [data-close]').first().click();
    await page.locator('#essay-body').fill('Speling and spelingg.');
    await openWords();await page.locator('#essay-words-extract').click();
    await page.waitForFunction(()=>document.querySelectorAll('.essay-word-row').length===2 && !document.querySelector('#essay-words-extract').disabled);
    for(const original of ['speling','spelingg']) await row(original).locator('input[type=text]').fill('spelling');
    assert((await page.locator('#essay-words-add').innerText()).includes('1 ready word'));
    await page.locator('#essay-words-add').click();
    await page.waitForFunction(()=>document.querySelector('#essay-words-status').textContent.includes('1 new word added'));
    assert.equal((await api('/state')).words.filter(w=>w.word==='spelling').length,1);
    // Empty drafts still allow importing earlier prompt replies, with no automatic adds.
    await page.locator('#essay-words-dialog [data-close]').first().click();await page.locator('#essay-body').fill('A valid essay.');
    await openWords();await page.locator('#essay-words-extract').click();
    await page.waitForFunction(()=>document.querySelectorAll('.essay-word-row').length===0 && !document.querySelector('#essay-words-extract').disabled);
    await preview(replies[0]);await page.locator('#essay-words-use').click();
    assert.equal(await page.locator('.essay-word-row').count(),2);
    assert.equal((await api('/state')).words.length,6);
    // Invalid replies show an error and never add words.
    await page.locator('#essay-words-reply').fill('not a response');await page.locator('#essay-words-preview').click();
    await page.waitForSelector('#essay-words-status.error');assert(await page.locator('#essay-words-use').isDisabled());
    assert.equal((await api('/state')).words.length,6);
    for(const width of [1360,390]) for(const size of ['small','default','large','extra-large']) {
      await api('/settings','PUT',{text_size:size});await page.evaluate(size=>document.documentElement.style.setProperty('--text-scale',({'small':.9,'default':1,'large':1.15,'extra-large':1.3})[size]),size);
      await page.setViewportSize({width,height:1000});
      assert(await page.locator('#essay-words-dialog').evaluate(d=>d.scrollWidth<=d.clientWidth),size+' review list at '+width);
    }
    assert.deepEqual(errors,[]);
    console.log('Essay-word checks passed: extraction with hints off, repeated flags, manual/Enter adds, existing words, prompt batching, paste/file reply preview, false flags, manual-edit protection, recovery, deduplicated batch adds, old replies, escaped content, invalid replies and all mobile text sizes.');
  } finally {
    if(browser) await browser.close();server.kill('SIGTERM');
    await new Promise(resolve=>{if(server.exitCode!==null)resolve();else server.once('exit',resolve);});
    fs.rmSync(directory,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
