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
    const expanded=await page.locator('.essay-paper').boundingBox();
    await page.getByRole('button',{name:'Collapse navigation',exact:true}).click();
    assert.equal(await page.locator('.sidebar').evaluate(d=>d.getBoundingClientRect().width),76);
    assert.equal(await page.locator('#sidebar-toggle').getAttribute('aria-expanded'),'false');
    assert((await page.locator('.essay-paper').boundingBox()).width>expanded.width);
    await page.getByRole('button',{name:'My words',exact:true}).click();
    await page.getByRole('button',{name:'Essay studio',exact:true}).click();
    await screenshot('collapsed-essay-studio');
    for(const width of [1360,900,801,390]) for(const size of ['small','default','large','extra-large']) {
      await api('/settings','PUT',{text_size:size});await page.setViewportSize({width,height:1000});
      await page.reload();await page.waitForSelector('#app-content:not([hidden])');
      assert(await page.evaluate(()=>document.documentElement.classList.contains('sidebar-collapsed')));
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),size+' collapsed at '+width);
      if(width>800) {
        assert.equal(await page.locator('.sidebar').evaluate(d=>d.getBoundingClientRect().width),76);
        assert.equal(await page.locator('main').evaluate(d=>d.getBoundingClientRect().left),76);
        assert(await page.getByRole('button',{name:'Expand navigation',exact:true}).isVisible());
      } else {
        assert(await page.locator('#sidebar-toggle').isHidden());
        assert.equal(await page.locator('main').evaluate(d=>d.getBoundingClientRect().left),0);
      }
    }
    await page.setViewportSize({width:1360,height:1000});
    await page.getByRole('button',{name:'Expand navigation',exact:true}).focus();await page.keyboard.press('Space');
    assert.equal(await page.locator('.sidebar').evaluate(d=>d.getBoundingClientRect().width),226);
    await page.reload();await page.waitForSelector('#app-content:not([hidden])');
    assert.equal(await page.locator('#sidebar-toggle').getAttribute('aria-expanded'),'true');
    assert.deepEqual(errors,[]);
    console.log('Sidebar checks passed: more essay space, accessible icon navigation, saved collapse/expand, keyboard toggle, mobile navigation, and every text size at four widths.');
  } finally {
    if(browser) await browser.close();server.kill('SIGTERM');
    await new Promise(resolve=>{if(server.exitCode!==null)resolve();else server.once('exit',resolve);});
    fs.rmSync(directory,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
