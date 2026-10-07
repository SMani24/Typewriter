/* Real browser checks against a temporary notebook, with networking disabled. */
const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'typewriter-browser-'));
  const port = await freePort();
  const localPython = path.join(__dirname, '..', '.venv', 'bin', 'python');
  const python = process.env.TYPEWRITER_PYTHON || (fs.existsSync(localPython) ? localPython : 'python3');
  const script = `import sys, wave, math, struct
from pathlib import Path
from flask import send_file
from typewriter.web import create_app
directory=Path(sys.argv[1])
(directory/"keys.txt").write_text("fake-browser-key-no-network-calls")
app=create_app(directory,directory/"keys.txt",background=False)
# An empty provider result checks that partial failures remain visible.
app.extensions["enrichment"].generate=lambda words: {}
# A synthetic tone checks actual browser decoding and playback under the app's CSP.
# It avoids network calls and committing dictionary recordings as test assets.
clip=directory/"test-audio.wav"
with wave.open(str(clip),"wb") as audio:
    audio.setparams((1,2,16000,0,"NONE","not compressed"))
    audio.writeframes(b"".join(struct.pack("<h",int(5000*math.sin(2*math.pi*440*i/16000))) for i in range(8000)))
app.view_functions["audio"]=lambda word_id: send_file(clip,mimetype="audio/wav")
app.run(host="127.0.0.1",port=int(sys.argv[2]),debug=False,threaded=True)`;
  const server = spawn(python, ['-u', '-c', script, directory, String(port)], {cwd:path.join(__dirname, '..'), stdio:'ignore'});
  let browser;
  try {
    let ready = false;
    for(let n=0;n<100;n++) {
      try { if((await fetch(`http://127.0.0.1:${port}/api/state`)).ok) {ready=true;break;} } catch {}
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert(ready, 'Python test server did not start. Install requirements first.');
    const installed = process.env.TYPEWRITER_BROWSER_PATH || (fs.existsSync('/opt/google/chrome/chrome') ? '/opt/google/chrome/chrome' : undefined);
    browser = await chromium.launch({headless:true, ...(installed ? {executablePath:installed} : {}), args:['--no-sandbox']});
    const page = await browser.newPage({viewport:{width:1360,height:1050}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {if(message.type()==='error') errors.push(message.text());});
    await page.goto(`http://127.0.0.1:${port}`);
    await page.waitForSelector('#app-content:not([hidden])');
    await page.getByRole('button',{name:'Add starter words',exact:true}).first().click();
    await page.waitForFunction(()=>document.querySelectorAll('.next-word').length===4);
    if(process.env.TYPEWRITER_SCREENSHOTS) {
      fs.mkdirSync(process.env.TYPEWRITER_SCREENSHOTS,{recursive:true});
      await page.waitForSelector('#toast',{state:'hidden'});
      await page.evaluate(()=>scrollTo(0,0));
      await page.screenshot({path:path.join(process.env.TYPEWRITER_SCREENSHOTS,'today.png'),fullPage:true,animations:'disabled'});
    }
    await page.getByRole('button',{name:'Start my review',exact:true}).click();
    await page.getByRole('button',{name:'Listen · Alt+P',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('#pronunciation').currentTime>0);
    assert((await page.locator('#pronunciation').getAttribute('src')).startsWith('/api/words/'));
    await page.waitForFunction(()=>document.querySelector('#pronunciation').ended);
    await page.getByRole('button',{name:'Listen · Alt+P',exact:true}).click();
    await page.waitForFunction(()=>!document.querySelector('#pronunciation').paused && document.querySelector('#pronunciation').currentTime>0);
    await page.locator('#answer').fill('neccessary');
    await page.locator('#answer').press('Enter');
    await page.waitForSelector('.letter-diff');
    await page.keyboard.press('Enter');
    assert(await page.locator('#pronunciation').evaluate(audio=>audio.paused && !audio.hasAttribute('src')));
    assert.equal(await page.locator('#practice-word').innerText(),'necessary');
    await page.locator('#answer').fill('necessary');
    await page.locator('#answer').press('Enter');
    await page.waitForFunction(()=>document.querySelector('#answer-submit').textContent.includes('Next word'));
    await page.keyboard.press('Enter');
    await page.getByRole('button',{name:'End session',exact:true}).click();
    await page.getByRole('button',{name:'Back to my notebook',exact:true}).click();

    await page.locator('.nav-item[data-page="words"]').click();
    await page.getByRole('button',{name:'Drill necessary',exact:true}).click();
    await page.locator('#drill-search').fill('NEC');
    assert.equal(await page.locator('#drill-options [role="option"]').count(),1);
    assert.equal((await page.locator('#drill-options [role="option"]').innerText()).split('\n')[0],'necessary');
    assert.equal(await page.locator('#drill-completion').innerText(),'essary');
    if(process.env.TYPEWRITER_SCREENSHOTS) await page.screenshot({path:path.join(process.env.TYPEWRITER_SCREENSHOTS,'picker.png'),animations:'disabled'});
    await page.locator('#drill-search').press('Tab');
    assert.equal(await page.locator('#drill-search').inputValue(),'necessary');
    assert.equal(await page.locator('#drill-search').getAttribute('aria-expanded'),'false');
    assert(await page.locator('#drill-search').evaluate(el=>el===document.activeElement));
    await page.locator('#drill-search').fill('ary');
    assert.equal((await page.locator('#drill-options [role="option"]').innerText()).split('\n')[0],'necessary');
    assert.equal(await page.locator('#drill-completion').innerText(),'');
    await page.locator('#drill-search').fill('zzz-no-match');
    assert(await page.getByRole('button',{name:'Begin drill',exact:true}).isDisabled());
    assert.equal(await page.locator('#drill-options').innerText(),'No matching words');
    await page.locator('#drill-search').fill('');
    assert.equal(await page.locator('#drill-options [role="option"]').count(),12);
    await page.locator('#drill-search').press('ArrowDown');
    assert.equal(await page.locator('#drill-search').getAttribute('aria-activedescendant'),await page.locator('#drill-options [role="option"]').nth(1).getAttribute('id'));
    await page.locator('#drill-search').press('Escape');
    assert(await page.locator('#drill-dialog').evaluate(el=>el.open));
    assert.equal(await page.locator('#drill-search').getAttribute('aria-expanded'),'false');
    await page.locator('#drill-search').fill('necessary');
    await page.locator('#drill-search').press('Enter');
    await page.locator('#drill-target').selectOption('10');
    await page.getByRole('button',{name:'Begin drill',exact:true}).click();
    for(let n=0;n<10;n++) {
      await page.waitForFunction(()=>!document.querySelector('#answer').disabled);
      await page.locator('#answer').fill('necessary');
      await page.locator('#answer').press('Enter');
      if(n<9) {await page.waitForFunction(()=>document.querySelector('#answer-submit').textContent.includes('Type it again'));await page.keyboard.press('Enter');}
    }
    await page.waitForSelector('#practice-summary:not([hidden])');
    await page.getByRole('button',{name:'Back to my notebook',exact:true}).click();
    const data = await page.evaluate(async()=> (await fetch('/api/state')).json());
    assert.equal(data.progress.drills,10);
    assert.equal(data.progress.reviews,1);
    assert.equal(data.progress.correct,0);
    assert.equal(data.words.find(w=>w.word==='necessary').stage,0);

    await page.getByRole('button',{name:'Add words',exact:true}).click();
    await page.getByRole('button',{name:'A list of words',exact:true}).click();
    await page.locator('textarea[name="bulk"]').fill('percentage\nsociety\nuntil\nwhich\nnowadays');
    await page.getByRole('button',{name:'Add to notebook',exact:true}).click();
    await page.waitForFunction(()=>document.querySelectorAll('.library-row').length===17);
    await page.locator('#word-search').fill('percentage');
    await page.getByRole('checkbox',{name:'Select percentage',exact:true}).check();
    assert.equal(await page.locator('#selection-count').innerText(),'1 word selected');
    await page.getByRole('button',{name:'Edit percentage',exact:true}).click();
    await page.locator('textarea[name="definition"]').fill('A proportion expressed out of one hundred.');
    await page.locator('textarea[name="sentence"]').fill('A higher percentage of people now work remotely.');
    await page.getByRole('button',{name:'Save changes',exact:true}).click();
    await page.waitForFunction(()=>!document.querySelector('#word-dialog').open);

    await page.getByRole('button',{name:'Prepare selected now',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('#queue-banner').textContent.includes('missing or unsuitable fields'));
    assert((await page.locator('#toast').innerText()).includes('still need material'));
    await page.reload();
    await page.waitForSelector('#app-content:not([hidden])');
    assert((await page.locator('#queue-banner').innerText()).includes('missing or unsuitable fields'));
    await page.locator('.nav-item[data-page="settings"]').click();
    await page.waitForFunction(()=>document.querySelector('#app-log').textContent.includes('Preparation partial'));
    await page.locator('label.switch').filter({has:page.locator('input[name="proxy_enabled"]')}).click();
    await page.locator('input[name="proxy_port"]').fill('10809');
    await page.locator('input[name="review_enabled"]').uncheck();
    await page.getByRole('button',{name:'Save settings',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('#toast').textContent==='Settings saved.');
    await page.reload();
    await page.waitForSelector('#app-content:not([hidden])');
    assert.equal(await page.locator('input[name="proxy_port"]').inputValue(),'10809');
    assert(await page.locator('input[name="proxy_enabled"]').isChecked());
    assert.equal(await page.locator('input[name="review_enabled"]').isChecked(),false);
    await page.locator('.nav-item[data-page="today"]').click();
    assert.equal(await page.getByRole('button',{name:'Start my review',exact:true}).count(),0);
    assert.equal(await page.getByRole('button',{name:'Start a word drill',exact:true}).count(),1);
    await page.locator('.nav-item[data-page="settings"]').click();
    await page.locator('input[name="review_enabled"]').check();
    await page.locator('input[name="drill_enabled"]').uncheck();
    await page.getByRole('button',{name:'Save settings',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.drill-card').hidden);
    await page.locator('.nav-item[data-page="words"]').click();
    assert.equal(await page.getByRole('button',{name:'Drill percentage',exact:true}).count(),0);
    await page.locator('.nav-item[data-page="settings"]').click();
    await page.locator('input[name="drill_enabled"]').check();
    await page.getByRole('button',{name:'Save settings',exact:true}).click();
    await page.waitForFunction(()=>!document.querySelector('.drill-card').hidden);

    await page.setViewportSize({width:390,height:844});
    await page.locator('.nav-item[data-page="today"]').click();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.getByRole('button',{name:'Start a word drill',exact:true}).click();
    await page.locator('#drill-search').fill('necessary');
    await page.locator('#drill-search').press('Enter');
    await page.getByRole('button',{name:'Begin drill',exact:true}).click();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.getByRole('button',{name:'End session',exact:true}).click();
    await page.getByRole('button',{name:'Back to my notebook',exact:true}).click();
    // Exercise selection, custom recordings, and API-free preparation.
    await page.setViewportSize({width:1360,height:1050});
    async function preferences(data) {
      await page.evaluate(async data=>{
        const response=await fetch('/api/settings',{method:'PUT',headers:{'Content-Type':'application/json','X-Typewriter-Token':document.querySelector('meta[name="typewriter-token"]').content},body:JSON.stringify(data)});
        if(!response.ok) throw new Error((await response.json()).error);
      },data);
      await page.reload();await page.waitForSelector('#app-content:not([hidden])');
    }
    async function selectReview(word) {
      await page.locator('.nav-item[data-page="words"]').click();
      await page.locator('#word-search').fill(word);
      await page.getByRole('checkbox',{name:`Select ${word}`,exact:true}).check();
      await page.getByRole('button',{name:'Review selected',exact:true}).click();
    }
    async function notebook() {return page.evaluate(async()=> (await fetch('/api/state')).json());}
    await preferences({preparation_method:'offline'});
    await page.locator('.nav-item[data-page="words"]').click();
    await page.locator('#word-search').fill('necessary');
    await page.getByRole('button',{name:'Edit necessary',exact:true}).click();
    await page.getByRole('button',{name:'Flag wrong pronunciation',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('#audio-status').textContent.includes('Flagged'));
    assert(await page.locator('#audio-verified').isDisabled());
    await page.locator('#audio-upload').setInputFiles({name:'my-pronunciation.wav',mimeType:'audio/wav',buffer:fs.readFileSync(path.join(directory,'test-audio.wav'))});
    await page.waitForFunction(()=>document.querySelector('#audio-status').textContent.includes('uploaded recording'));
    assert(await page.locator('#audio-verified').isChecked());
    await page.getByRole('button',{name:'Preview recording',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('#audio-preview').currentTime>0);
    await page.locator('[data-close="word-dialog"]').click();
    assert(await page.locator('#audio-preview').evaluate(a=>a.paused && !a.hasAttribute('src')));

    await preferences({sentence_enabled:false,definition_enabled:false,meaning_enabled:false,audio_enabled:true});
    await selectReview('necessary');
    await page.waitForFunction(()=>document.querySelector('#pronunciation').currentTime>0);
    assert.equal(await page.locator('#practice-mode').innerText(),'AUDIO-ONLY SPELLING');
    assert.equal(await page.locator('#practice-word').innerText(),'');
    assert.equal(await page.locator('#practice-meaning').innerText(),'');
    await page.waitForFunction(()=>document.querySelector('#pronunciation').ended);
    await page.keyboard.press('Alt+p');
    await page.waitForFunction(()=>!document.querySelector('#pronunciation').paused && document.querySelector('#pronunciation').currentTime>0);
    await page.getByRole('button',{name:'Wrong pronunciation?',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('#answer-submit').textContent==='Skip this word');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#practice-summary:not([hidden])');
    await page.keyboard.press('Enter');
    await page.waitForFunction(()=>!document.querySelector('#practice-dialog').open);
    let afterAudio=await notebook();
    assert.equal(afterAudio.words.find(w=>w.word==='necessary').audio_eligible,false);
    assert.equal(afterAudio.progress.reviews,1); // Flagging is not a scored mistake.
    await selectReview('necessary');
    assert.equal(await page.locator('#practice-dialog').evaluate(d=>d.open),false);

    await preferences({sentence_enabled:false,definition_enabled:true,meaning_enabled:false,audio_enabled:false});
    await selectReview('necessary');
    assert.equal(await page.locator('#practice-mode').innerText(),'SPELLING FROM A MEANING');
    assert((await page.locator('#practice-clue').innerText()).includes('Needed for a particular purpose'));
    assert(await page.locator('#pronunciation').evaluate(a=>!a.hasAttribute('src')));
    await page.keyboard.press('Escape');await page.waitForSelector('#practice-summary:not([hidden])');await page.keyboard.press('Enter');

    await preferences({sentence_enabled:false,definition_enabled:false,meaning_enabled:true,audio_enabled:false});
    const beforeMeaning=await notebook();
    await selectReview('necessary');
    assert.equal(await page.locator('#practice-mode').innerText(),'MEANING QUIZ');
    if(process.env.TYPEWRITER_SCREENSHOTS) await page.screenshot({path:path.join(process.env.TYPEWRITER_SCREENSHOTS,'meaning-quiz.png'),animations:'disabled'});
    assert.equal(await page.locator('.meaning-choice').count(),4);
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.setViewportSize({width:1360,height:1050});
    const correctIndex=await page.locator('.meaning-choice').evaluateAll(options=>options.findIndex(b=>b.textContent.includes('Needed for a particular purpose')));
    await page.keyboard.press(String(correctIndex+1));await page.keyboard.press('Enter');
    await page.waitForFunction(()=>document.querySelector('#practice-feedback').textContent.includes('That’s the meaning'));
    await page.keyboard.press('Enter');await page.waitForSelector('#practice-summary:not([hidden])');await page.keyboard.press('Enter');
    const afterMeaning=await notebook();
    assert.equal(afterMeaning.progress.meanings,1);
    assert.equal(afterMeaning.progress.meanings_correct,1);
    assert.equal(afterMeaning.progress.reviews,beforeMeaning.progress.reviews);
    assert.equal(afterMeaning.words.find(w=>w.word==='necessary').stage,beforeMeaning.words.find(w=>w.word==='necessary').stage);

    await preferences({sentence_enabled:true,definition_enabled:false,meaning_enabled:false,audio_enabled:false});
    await selectReview('environment');
    assert.equal(await page.locator('#practice-mode').innerText(),'SENTENCE SPELLING');
    assert((await page.locator('#practice-clue').innerText()).includes('________'));
    assert.equal(await page.locator('#practice-meaning').innerText(),'');
    await page.keyboard.press('Escape');await page.waitForSelector('#practice-summary:not([hidden])');await page.keyboard.press('Enter');

    await page.locator('.nav-item[data-page="words"]').click();await page.locator('#word-search').fill('');
    await page.getByRole('button',{name:'Prepare with another LLM',exact:true}).click();
    await page.locator('#prompt-scope').selectOption('queue');await page.locator('#prompt-size').fill('2');
    const downloadEvent=page.waitForEvent('download');
    await page.getByRole('button',{name:'Download prompt files',exact:true}).click();
    const download=await downloadEvent;
    assert(download.suggestedFilename().startsWith('typewriter-preparation-'));
    const zipPath=path.join(directory,'prompts.zip');await download.saveAs(zipPath);
    const {execFileSync}=require('node:child_process');
    const payload=JSON.parse(execFileSync(python,['-c',`import json,sys,zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    prompts=[z.read(n).decode() for n in z.namelist() if n!="README.md"]
    assert len(prompts)==3
    p=json.loads(prompts[0].split("\x60\x60\x60json\\n")[1].split("\\n\x60\x60\x60")[0])
    assert len(p["words"])==2
    for w in p["words"]: w.update(definition="Generated meaning",sentence="We practise "+w["word"]+" today.",tip="Look at each letter.")
    print(json.dumps(p))`,zipPath],{encoding:'utf8'}));
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.setViewportSize({width:1360,height:1050});
    const reply=JSON.stringify(payload);
    await page.locator('#prepared-response').fill(reply);
    await page.getByRole('button',{name:'Preview reply',exact:true}).click();
    await page.waitForFunction(()=>!document.querySelector('#apply-preparation').disabled);
    assert.equal(await page.locator('.prepared-entry').count(),2);
    if(process.env.TYPEWRITER_SCREENSHOTS) await page.screenshot({path:path.join(process.env.TYPEWRITER_SCREENSHOTS,'prompt-preview.png'),animations:'disabled'});
    await page.getByRole('button',{name:'Apply to notebook',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('#preparation-preview').textContent.includes('Reply imported'));
    assert(await page.locator('#apply-preparation').isDisabled());
    const afterImport=await notebook();
    for(const w of payload.words) assert.equal(afterImport.words.find(i=>i.word===w.word).status,'ready');
    await page.locator('[data-close="preparation-dialog"]').click();
    assert.equal(afterImport.enrichment.requests_today,0);
    await page.locator('.nav-item[data-page="settings"]').click();
    await page.locator('input[name="model"]').fill('gemini-flash-3.5');
    await page.locator('input[name="offline_batch_size"]').fill('7');
    await page.getByRole('button',{name:'Save settings',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('input[name="model"]').value==='gemini-3.5-flash');
    await page.reload();await page.waitForSelector('#app-content:not([hidden])');
    assert.equal(await page.locator('input[name="offline_batch_size"]').inputValue(),'7');
    assert.equal(await page.locator('select[name="preparation_method"]').inputValue(),'offline');

    assert.deepEqual(errors,[]);
    console.log('Browser checks passed: actual audio playback/replay, playback cleanup, combobox filtering and Tab completion, keyboard review corrections, ten repetitions, honest statistics, bulk entry, editing, persisted proxy settings, mobile layout, exercise filtering, automatic audio and keyboard replay, audio replacement and flagging, meaning scores, and offline prompt roundtrip.');
  } finally {
    if(browser) await browser.close();
    server.kill('SIGTERM');
    await new Promise(resolve=> {if(server.exitCode !== null) resolve();else server.once('exit',resolve);});
    fs.rmSync(directory,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
