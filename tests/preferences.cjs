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
    await page.addInitScript(()=>{
      window.audioCalls=0;
      const original=HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play=function(...args) {
        if(this.id==='pronunciation') window.audioCalls++;
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
    const tasks=['sentence','definition','audio','meaning','drill','correction'];
    async function configure(task,autoplay) {
      const settings=Object.fromEntries(tasks.map(t=>['autoplay_'+t,false]));
      settings['autoplay_'+task]=autoplay;
      Object.assign(settings,{sentence_enabled:false,definition_enabled:false,audio_enabled:false,meaning_enabled:false});
      settings[(task==='drill'||task==='correction'?'sentence':task)+'_enabled']=true;
      await api('/settings','PUT',settings);
      await page.reload();await page.waitForSelector('#app-content:not([hidden])');
    }
    async function calls() {await page.waitForTimeout(150);return page.evaluate(()=>window.audioCalls);}
    async function drill() {
      await page.locator('.nav-item[data-page="today"]').click();
      await page.locator('[data-action="choose-drill"]').click();
      await page.locator('#drill-search').fill('necessary');
      await page.locator('#drill-form button[type="submit"]').click();
    }
    for(const task of tasks) {
      for(const autoplay of [false,true]) {
        await configure(task,autoplay);
        if(task==='drill') await drill();else await review('necessary');
        if(task==='correction') {
          assert.equal(await calls(),0);
          await page.locator('#answer').fill('wrong');await page.keyboard.press('Enter');
          await page.waitForSelector('#answer-form[data-result="incorrect"]');
          await page.keyboard.press('Enter');
          await page.waitForFunction(()=>document.getElementById('practice-label').textContent.includes('CORRECTION'));
        }
        assert.equal(await calls(),autoplay?1:0,task+' autoplay '+autoplay);
        if(!autoplay) {
          await page.keyboard.press('Alt+p');
          await page.waitForFunction(()=>window.audioCalls===1);
          await page.waitForFunction(()=>!document.getElementById('pronunciation').paused);
        }
        if(task==='drill'&&autoplay) {
          await page.locator('#answer').fill('necessary');await page.keyboard.press('Enter');
          await page.waitForSelector('#answer-form[data-result="correct"]');
          await page.keyboard.press('Enter');
          await page.waitForFunction(()=>window.audioCalls===2);
        }
        await end();
      }
    }
    // Flags exclude even previously verified recordings from automatic playback.
    const id=(await api('/state')).words.find(w=>w.word==='necessary').id;
    await api('/words/'+id+'/audio','PATCH',{flagged:true});
    await configure('sentence',true);await review('necessary');
    assert.equal(await calls(),0);await end();
    await api('/words/'+id+'/audio','PATCH',{flagged:false,verified:false});
    await configure('sentence',true);await review('necessary');
    assert.equal(await calls(),0);await end();
    await api('/words/'+id+'/audio','PATCH',{verified:true});
    // The Settings controls take part in save/discard, and survive a reload.
    await configure('sentence',false);
    await page.locator('.nav-item[data-page="settings"]').click();
    await page.locator('#autoplay-settings summary').click();
    await page.locator('input[name="autoplay_sentence"]').check();
    await page.locator('.nav-item[data-page="today"]').click();
    await page.locator('[data-action="settings-discard-leave"]').click();
    assert.equal((await api('/state')).settings.autoplay_sentence,false);
    await page.locator('.nav-item[data-page="settings"]').click();
    await page.locator('input[name="autoplay_sentence"]').check();
    await page.locator('#settings-form button[type="submit"]').click();
    await page.reload();await page.waitForSelector('#app-content:not([hidden])');
    assert(await page.locator('input[name="autoplay_sentence"]').isChecked());
    await page.setViewportSize({width:390,height:844});
    await page.locator('#autoplay-settings summary').click();
    assert(await page.locator('#autoplay-settings').evaluate(d=>d.scrollWidth<=d.clientWidth));
    await screenshot('autoplay-settings-mobile');
    assert.deepEqual(errors,[]);
    console.log('Preference checks passed: per-task autoplay on/off, replay, repeated drills, correction playback, trusted recordings, saved settings, and mobile layout.');
  } finally {
    if(browser) await browser.close();
    server.kill('SIGTERM');
    await new Promise(resolve=>{if(server.exitCode!==null)resolve();else server.once('exit',resolve);});
    fs.rmSync(directory,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
