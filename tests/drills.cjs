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
    let notebook=(await api('/state')).words;
    const necessary=notebook.find(w=>w.word==='necessary').id;
    const missing=notebook.find(w=>w.word==='missing').id;
    for(const [id,count] of [[necessary,4],[missing,3]]) for(let i=0;i<count;i++) await api('/words/'+id+'/attempts','POST',{mode:'review',answer:'wrong'});
    await page.reload();await page.waitForSelector('#app-content:not([hidden])');
    const before=(await api('/state')).words.find(w=>w.id===necessary);
    assert.equal(await page.locator('#drill-suggestions [data-drill]').first().getAttribute('data-drill'),String(necessary));
    async function drill(word,target='10') {
      await page.locator('.nav-item[data-page="today"]').click();
      await page.locator('[data-action="choose-drill"]').click();
      await page.locator('#drill-search').fill(word);
      await page.locator('#drill-target').selectOption(target);
      await page.locator('#drill-form button[type="submit"]').click();
    }
    async function answer(text,final=false) {
      await page.locator('#answer').fill(text);await page.keyboard.press('Enter');
      if(final) await page.waitForSelector('#practice-summary:not([hidden])');
      else {
        await page.waitForSelector('#answer-form[data-result="'+(text==='wrong'?'incorrect':'correct')+'"]');
        await page.waitForFunction(()=>!document.getElementById('answer-submit').disabled);
        await page.keyboard.press('Enter');
        await page.waitForFunction(()=>!document.getElementById('answer').disabled);
      }
    }
    await drill('necessary');
    for(let i=0;i<10;i++) await answer('necessary',i===9);
    await page.waitForFunction(()=>document.getElementById('drill-result-note').textContent.includes('Recently drilled'));
    const cooled=(await api('/state')).words.find(w=>w.id===necessary);
    assert.equal(cooled.drill_priority,before.review_priority*0.25);
    for(const key of ['review_priority','reviews','stage','due','recent_mistakes']) assert.equal(cooled[key],before[key]);
    assert(cooled.drill_recommended);
    await screenshot('completed-drill-priority');
    await page.locator('[data-action="close-practice"]').click();
    await page.waitForFunction(id=>document.querySelector('#drill-suggestions [data-drill]')?.dataset.drill===String(id),missing);
    await page.locator('[data-action="choose-drill"]').click();
    await page.locator('#drill-search').fill('');
    assert((await page.locator('#drill-options [role="option"]').first().innerText()).startsWith('missing'));
    assert((await page.locator('#drill-options').innerText()).includes('Recently drilled'));
    await page.locator('#drill-search').fill('nec');
    assert((await page.locator('#drill-options [role="option"]').first().innerText()).startsWith('necessary'));
    await page.locator('[data-close="drill-dialog"]').click();
    // Ending early saves repetitions without awarding a new reduction.
    await drill('missing');
    for(let i=0;i<3;i++) await answer('missing');
    await page.keyboard.press('Escape');
    await page.waitForFunction(()=>document.getElementById('drill-result-note').textContent.includes('To lower its priority'));
    assert.equal((await api('/state')).words.find(w=>w.id===missing).drill_cooling,false);
    await page.locator('[data-action="close-practice"]').click();
    // Untargeted sessions also qualify; a failed completion has a visible safe retry.
    await drill('missing','0');
    await answer('wrong');await answer('wrong');
    for(let i=0;i<10;i++) await answer('missing');
    let fail=true;
    await page.route('**/api/words/*/drill-completion',async route=>{
      if(fail) {fail=false;await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Temporary connection issue.'})});}
      else await route.continue();
    });
    await page.keyboard.press('Escape');
    try {await page.waitForSelector('[data-action="retry-drill-completion"]:not([hidden])',{timeout:5000});}
    catch(error) {console.error('Completion request intercepted:',!fail,'Summary:',await page.locator('#practice-summary').innerText());throw error;}
    assert((await page.locator('#drill-result-note').innerText()).includes('Your repetitions are saved'));
    assert.equal((await api('/state')).words.find(w=>w.id===missing).drill_cooling,false);
    await page.locator('[data-action="retry-drill-completion"]').click();
    await page.waitForFunction(()=>document.getElementById('drill-result-note').textContent.includes('Recently drilled'));
    const retried=(await api('/state')).words.find(w=>w.id===missing);
    assert(retried.drill_cooling);assert.equal(retried.drill_priority,retried.review_priority*0.25);
    await page.unroute('**/api/words/*/drill-completion');
    await page.locator('[data-action="close-practice"]').click();
    // A failed recall immediately restores full drill priority.
    await review('necessary');
    await page.locator('#answer').fill('wrong');await page.keyboard.press('Enter');
    await page.waitForSelector('#answer-form[data-result="incorrect"]');
    const struggled=(await api('/state')).words.find(w=>w.id===necessary);
    assert.equal(struggled.drill_cooling,false);assert.equal(struggled.drill_priority,struggled.review_priority);
    await end();
    // Escape while the final answer is pending waits for its saved record.
    await drill('necessary','0');
    for(let i=0;i<9;i++) await answer('necessary');
    let release;const held=new Promise(resolve=>release=resolve);
    await page.route('**/api/words/*/attempts',async route=>{await held;await route.continue();});
    const sent=page.waitForRequest(r=>r.url().endsWith('/attempts')&&r.method()==='POST');
    await page.locator('#answer').fill('necessary');await page.keyboard.press('Enter');await sent;
    await page.keyboard.press('Escape');
    assert(await page.locator('#practice-summary').isHidden());
    assert.equal(await page.evaluate(()=>practice.endRequested),true);
    release();
    try {await page.waitForFunction(()=>document.getElementById('drill-result-note')?.textContent.includes('Recently drilled'),null,{timeout:5000});}
    catch(error) {console.error(await page.evaluate(()=>({open:document.getElementById('practice-dialog').open,summaryHidden:document.getElementById('practice-summary').hidden,note:document.getElementById('drill-result-note')?.textContent,endRequested:practice?.endRequested,busy:answerBusy,attempts:practice?.attempts,first:practice?.firstDrillAttempt,last:practice?.lastDrillAttempt})),errors);throw error;}
    assert.equal(await page.locator('.summary-stats strong').nth(0).innerText(),'10');
    await page.unroute('**/api/words/*/attempts');
    await page.locator('[data-action="close-practice"]').click();
    assert.deepEqual(errors,[]);
    console.log('Drill checks passed: completed and untargeted drills, temporary lower ordering, searchable words, unchanged recall, short sessions, visible safe retry, new struggles, and pending-answer completion.');
  } finally {
    if(browser) await browser.close();
    server.kill('SIGTERM');
    await new Promise(resolve=>{if(server.exitCode!==null)resolve();else server.once('exit',resolve);});
    fs.rmSync(directory,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
