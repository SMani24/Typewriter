/* Actual preview playback and deliberate consent, using synthetic local recordings. */
const {chromium}=require('playwright');
const {spawn}=require('node:child_process');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const net=require('node:net');
const assert=require('node:assert/strict');
(async()=>{
  const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
  const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'typewriter-audio-'));
  const script=`import sys,io,wave,math,struct
from pathlib import Path
from unittest.mock import Mock
from typewriter.web import create_app
p=Path(sys.argv[1]);app=create_app(p,p/'no-keys',background=False)
s=app.extensions['store'];d=app.extensions['dictionary'];sources=d.alternatives
s.save_settings({'preparation_method':'manual','sentence_enabled':False,'definition_enabled':False,'audio_enabled':True,'meaning_enabled':False,'autoplay_audio':False})
s.add_words([{'word':'highest','definition':'Above all others.','sentence':'This is the highest point.'}])
clip=io.BytesIO()
with wave.open(clip,'wb') as a:
    a.setparams((1,2,16000,0,'NONE','not compressed'))
    a.writeframes(b''.join(struct.pack('<h',int(5000*math.sin(2*math.pi*440*i/16000))) for i in range(24000)))
content=clip.getvalue()
def voices(word,provider):
    if provider=='cambridge':return []
    result=[]
    count=2 if provider=='oxford' else 1
    for i in range(count):
        wiki=provider!='oxford'
        url=('https://upload.wikimedia.org/wikipedia/commons/1/23/'+provider if wiki else 'https://www.oxfordlearnersdictionaries.com/media/english')+'/highest-'+str(i)+'.wav'
        source='https://commons.wikimedia.org/wiki/File:highest.wav' if wiki else 'https://www.oxfordlearnersdictionaries.com/definition/english/highest'
        result.append(sources.record(word['word'],provider,url,'uk' if i==0 else 'us',source,'Synthetic test speaker','CC BY 4.0' if wiki else 'Publisher recording','https://creativecommons.org/licenses/by/4.0/' if wiki else source))
    return result
sources.fetch=voices
def request(method,url,**kwargs):
    if '/highest-' not in url:raise AssertionError('No live provider requests in browser checks')
    return Mock(status_code=200,headers={},iter_content=lambda size:[b'<html>unavailable</html>' if '/english/highest-0.wav' in url else content],close=lambda:None)
app.extensions['network'].request=request
d.lookup=lambda word,**kwargs: {'audio':{},'senses':[]}
app.run(host='127.0.0.1',port=int(sys.argv[2]),debug=False,threaded=True)`;
  const server=spawn(path.join(__dirname,'..','.venv','bin','python'),['-u','-c',script,directory,String(port)],{cwd:path.join(__dirname,'..'),stdio:['ignore','ignore','pipe']});
  let logs='';server.stderr.on('data',chunk=>logs+=chunk);let browser;
  try{
    const base=`http://127.0.0.1:${port}`;let ready=false;
    for(let i=0;i<100;i++){try{if((await fetch(base+'/api/health')).ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
    assert(ready,logs);
    browser=await chromium.launch({headless:true,executablePath:process.env.TYPEWRITER_BROWSER_PATH || '/opt/google/chrome/chrome',args:['--no-sandbox']});
    const page=await browser.newPage({viewport:{width:1360,height:1050}});const errors=[],external=[];
    page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(!r.url().startsWith(base))external.push(r.url());});
    await page.goto(base);await page.waitForSelector('#app-content:not([hidden])');
    async function api(url,method='GET',data){return page.evaluate(async({url,method,data})=>{
      const response=await fetch('/api'+url,{method,headers:{'Content-Type':'application/json','X-Typewriter-Token':document.querySelector('meta[name="typewriter-token"]').content},...(data===undefined?{}:{body:JSON.stringify(data)})});
      const result=await response.json();if(!response.ok)throw new Error(result.error);return result;
    },{url,method,data});}
    const id=(await api('/state')).words[0].id;
    async function word(){return (await api('/state')).words.find(w=>w.id===id);}
    async function edit(){await page.locator('.nav-item[data-page="words"]').click();await page.locator(`[data-edit="${id}"]`).click();await page.waitForSelector('#word-dialog[open]');}
    async function open(){await page.locator('[data-action="find-edit-voice"]').click();await page.waitForFunction(()=>document.querySelector('#alternative-audio-status').textContent.startsWith('4 voices available'));}
    const cards=()=>page.locator('.voice-option');
    async function play(index){await cards().nth(index).locator('[data-play-voice]').click();await page.waitForFunction(()=>document.querySelector('#alternative-audio-preview').currentTime>0);}
    async function approve(index){await play(index);await page.locator('#alternative-audio-checked').check();await page.locator('#approve-alternative-audio').click();await page.waitForSelector('#alternative-audio-dialog',{state:'hidden'});}
    await edit();await open();
    assert.equal(await cards().count(),4);
    assert.equal(await page.locator('#alternative-audio-preview').evaluate(a=>a.paused && !a.controls && a.hidden),true);
    assert.equal(await page.locator('#preview-alternative-audio').count(),0);
    const before=await word();
    await cards().first().locator('[data-play-voice]').click();
    await page.waitForFunction(()=>document.querySelector('#alternative-audio-playback').textContent.includes('could not be played'));
    assert(await page.locator('#approve-alternative-audio').isDisabled());
    await play(1);await page.locator('#alternative-audio-checked').check();assert(await page.locator('#approve-alternative-audio').isEnabled());
    await play(2);assert(await page.locator('#approve-alternative-audio').isDisabled());
    // Compare freely: every voice remains in the list, and a previous preview can be chosen.
    assert.equal(await cards().count(),4);
    await cards().nth(1).locator('input[type="radio"]').check();await page.locator('#alternative-audio-checked').check();assert(await page.locator('#approve-alternative-audio').isEnabled());
    await page.keyboard.press('Escape');assert.deepEqual((await word()).audio_alternative,{});assert.equal((await word()).audio_verified,before.audio_verified);
    await page.waitForFunction(()=>!document.querySelector('#alternative-audio-preview').hasAttribute('src'));
    await open();assert.equal(await cards().count(),4);
    assert.match(await cards().nth(2).textContent(),/Wiktionary/);
    assert.equal(await cards().nth(2).locator('a').first().getAttribute('href'),'https://creativecommons.org/licenses/by/4.0/');
    await approve(2);assert.equal((await word()).audio_alternative.provider,'wiktionary');
    assert.equal((await word()).audio_eligible,true);await page.waitForSelector('#audio-source-credit:not([hidden])');
    await page.locator('[data-close="word-dialog"]').click();
    await page.getByRole('checkbox',{name:'Select highest',exact:true}).check();
    await page.locator('[data-action="review-selected"]').click();await page.waitForSelector('#practice-dialog[open]');
    assert.match(await page.locator('#practice-mode').textContent(),/AUDIO-ONLY/);
    await page.locator('[data-action="flag-practice-audio"]').click();await page.waitForFunction(()=>document.querySelector('#answer').disabled);
    await page.locator('[data-action="find-practice-voice"]').click();await page.waitForFunction(()=>document.querySelectorAll('.voice-option').length===4);
    // Real browser playback from inside practice, with one compact button per voice.
    await approve(3);await page.waitForFunction(()=>!document.querySelector('#answer').disabled);
    assert.equal((await api('/export')).attempts.length,0);
    await page.locator('#answer').fill('highest');await page.locator('#answer').press('Enter');await page.waitForSelector('#answer-form[data-result="correct"]');
    assert.equal((await api('/export')).attempts.length,1);
    await page.keyboard.press('Escape');await page.locator('[data-action="close-practice"]').click();
    await edit();
    let release;const pending=new Promise(resolve=>release=resolve);let reached=false;
    await page.route('**/pronunciation/alternatives',async route=>{reached=true;await pending;try{await route.fulfill({json:{candidates:[],unavailable:true}});}catch{}});
    await page.locator('[data-action="find-edit-voice"]').click({noWaitAfter:true});
    await page.waitForFunction(()=>document.querySelector('#alternative-audio-dialog').open);
    await page.locator('#close-alternative-audio').click();assert(reached);release();
    await page.waitForTimeout(100);assert.equal(await page.locator('#alternative-audio-dialog').evaluate(d=>d.open),false);
    await page.unroute('**/pronunciation/alternatives');
    await page.locator('[data-close="word-dialog"]').click();
    // New words with no Cambridge audio explicitly offer finding a voice or skipping.
    await page.locator('[data-action="add"]').first().click();await page.locator('#word-form input[name="word"]').fill('absence');await page.locator('#word-submit').click();
    await page.waitForSelector('#pronunciation-choice-dialog[open]');
    assert(await page.getByRole('button',{name:'Find & preview alternatives'}).isVisible());
    await page.getByRole('button',{name:'Skip for now',exact:true}).click();
    await api('/settings','PUT',{text_size:'extra-large'});
    await page.setViewportSize({width:390,height:844});await page.reload();await page.waitForSelector('#app-content:not([hidden])');
    await edit();await open();
    const bounds=await page.locator('#alternative-audio-dialog').boundingBox();assert(bounds.x>=0 && bounds.x+bounds.width<=390);
    assert.equal(await page.locator('#alternative-audio-dialog').evaluate(d=>d.scrollWidth<=d.clientWidth),true);
    if(process.env.TYPEWRITER_SCREENSHOTS){fs.mkdirSync(process.env.TYPEWRITER_SCREENSHOTS,{recursive:true});await page.screenshot({path:path.join(process.env.TYPEWRITER_SCREENSHOTS,'voice-list-mobile.png'),animations:'disabled'});}
    await page.keyboard.press('Escape');assert.equal((await word()).audio_alternative.provider,'free_dictionary');
    assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
    console.log('Audio choices passed: all voices listed, real playback from practice, free comparison without rejection, a single play button per voice, visible failed playback, preview before consent, missing-audio popup, safe cancellation, unchanged grades, and mobile layout.');
  }finally{if(browser)await browser.close();server.kill('SIGTERM');await new Promise(resolve=>server.once('exit',resolve));fs.rmSync(directory,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
