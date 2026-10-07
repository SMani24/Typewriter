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
    assert.equal(await page.locator('#answer').getAttribute('aria-invalid'),'true');
    if(process.env.TYPEWRITER_SCREENSHOTS) await page.screenshot({path:path.join(process.env.TYPEWRITER_SCREENSHOTS,'spelling-feedback-incorrect.png'),animations:'disabled'});
    await page.keyboard.press('Enter');
    assert(await page.locator('#pronunciation').evaluate(audio=>audio.paused && !audio.hasAttribute('src')));
    assert.equal(await page.locator('#practice-word').innerText(),'necessary');
    assert.equal(await page.locator('#answer').getAttribute('aria-invalid'),null);
    await page.locator('#answer').fill('necessary');
    await page.locator('#answer').press('Enter');
    await page.waitForFunction(()=>document.querySelector('#answer-submit').textContent.includes('Next word'));
    assert((await page.locator('#practice-feedback').innerText()).includes('Spelling corrected!'));
    if(process.env.TYPEWRITER_SCREENSHOTS) {
      await page.screenshot({path:path.join(process.env.TYPEWRITER_SCREENSHOTS,'spelling-feedback-correct.png'),animations:'disabled'});
      await page.setViewportSize({width:390,height:844});
      await page.locator('#answer-submit').scrollIntoViewIfNeeded();
      await page.screenshot({path:path.join(process.env.TYPEWRITER_SCREENSHOTS,'spelling-feedback-mobile.png'),animations:'disabled'});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      await page.setViewportSize({width:1360,height:1050});
    }
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
      if(n<9) {
        await page.waitForFunction(()=>document.querySelector('#answer-submit').textContent.includes('Type it again'));
        if(n===0) {
          await page.waitForTimeout(1000);
          assert(await page.locator('#answer').isDisabled());
          assert((await page.locator('#practice-feedback').innerText()).includes('Correct spelling!'));
        }
        await page.keyboard.press('Enter');
      }
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
    await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('still need material'));
    await page.waitForSelector('#failure-dialog[open]');
    assert((await page.locator('#failure-message').innerText()).includes('missing or unsuitable'));
    await page.getByRole('button',{name:'Not now',exact:true}).click();
    await page.reload();
    await page.waitForSelector('#app-content:not([hidden])');
    assert.equal(await page.locator('#failure-dialog').evaluate(d=>d.open),false);
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
    // A second failed batch offers a scoped offline fallback and keeps the proxy.
    await page.locator('.nav-item[data-page="words"]').click();
    await page.locator('#word-search').fill('percentage');
    await page.getByRole('checkbox',{name:'Select percentage',exact:true}).check();
    await page.getByRole('button',{name:'Prepare selected now',exact:true}).click();
    await page.waitForSelector('#failure-dialog[open]');
    await page.getByRole('button',{name:'Use another LLM',exact:true}).click();
    await page.waitForSelector('#preparation-dialog[open]');
    assert.equal(await page.locator('#prompt-scope').inputValue(),'selected');
    assert((await page.locator('#prompt-count').innerText()).startsWith('1 word'));
    const fallbackState=await page.evaluate(async()=> (await fetch('/api/state')).json());
    assert.equal(fallbackState.settings.preparation_method,'offline');
    assert.equal(fallbackState.settings.proxy_port,10809);
    assert.equal(fallbackState.settings.proxy_enabled,true);
    await page.locator('[data-close="preparation-dialog"]').click();

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
    await page.keyboard.press(String(correctIndex+1));
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

    // Flag a wrong meaning before answering: skip without recording an attempt.
    await preferences({meaning_enabled:true,sentence_enabled:false,definition_enabled:false,audio_enabled:false});
    const beforeFlag=await notebook();
    await selectReview('necessary');
    await page.getByRole('button',{name:'Wrong meaning?',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('#practice-feedback').textContent.includes('flagged'));
    assert.equal((await notebook()).progress.meanings,beforeFlag.progress.meanings);
    await page.keyboard.press('Enter');
    await page.waitForSelector('#practice-summary:not([hidden])');
    await page.getByRole('button',{name:'Back to my notebook',exact:true}).click();
    assert.equal((await notebook()).words.find(w=>w.word==='necessary').meaning_flagged,1);
    await page.locator('.nav-item[data-page="words"]').click();
    await page.locator('#word-search').fill('necessary');
    await page.getByRole('checkbox',{name:'Select necessary',exact:true}).check();
    // Ready words can be explicitly re-evaluated; the export includes quiz options.
    await page.getByRole('button',{name:'Prepare again',exact:true}).click();
    await page.waitForSelector('#preparation-dialog[open]');
    assert(await page.locator('#prompt-reevaluate').isChecked());
    await page.locator('#prompt-reevaluate').uncheck(); // Correct just the disputed meaning.
    const correctionDownloadEvent=page.waitForEvent('download');
    await page.getByRole('button',{name:'Download prompt files',exact:true}).click();
    const correctionDownload=await correctionDownloadEvent;
    const correctionZip=path.join(directory,'correction.zip');await correctionDownload.saveAs(correctionZip);
    const correctionPayload=JSON.parse(execFileSync(python,['-c',`import json,sys,zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    prompts=[z.read(n).decode() for n in z.namelist() if n!="README.md"]
    assert len(prompts)==1
    assert 'definition is WRONG' in prompts[0]
    p=json.loads(prompts[0].split("\x60\x60\x60json\\n")[1].split("\\n\x60\x60\x60")[0])
    assert p["words"][0]["word"]=="necessary"
    p["words"][0].update(definition="Required for a particular purpose.",sentence="This change is necessary.",tip="One c, two s.",distractors=["Optional for a particular purpose.","Suitable for a particular purpose.","Available for a particular purpose."])
    print(json.dumps(p))`,correctionZip],{encoding:'utf8'}));
    await page.locator('#prepared-response').fill(JSON.stringify(correctionPayload));
    await page.getByRole('button',{name:'Preview reply',exact:true}).click();
    await page.waitForFunction(()=>!document.querySelector('#apply-preparation').disabled);
    assert((await page.locator('#preparation-preview').innerText()).includes('Will replace: definition, distractors'));
    await page.getByRole('button',{name:'Apply to notebook',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('#preparation-preview').textContent.includes('Reply imported'));
    const correctedWord=(await notebook()).words.find(w=>w.word==='necessary');
    assert.equal(correctedWord.meaning_flagged,0);
    assert.equal(correctedWord.distractors.length,3);
    assert.equal(correctedWord.sentence,beforeFlag.words.find(w=>w.word==='necessary').sentence);
    await page.locator('[data-close="preparation-dialog"]').click();
    await selectReview('necessary');
    const optionTexts=await page.locator('.meaning-choice').allTextContents();
    for(const text of [correctedWord.definition,...correctedWord.distractors]) assert(optionTexts.some(option=>option.includes(text)));
    const generatedWrongIndex=optionTexts.findIndex(text=>text.includes(correctedWord.distractors[0]));
    await page.keyboard.press(String(generatedWrongIndex+1));
    await page.waitForFunction(()=>document.querySelector('#practice-feedback').textContent.includes('Keep this meaning'));
    assert.equal((await notebook()).progress.meanings,beforeFlag.progress.meanings+1);
    await page.keyboard.press('Enter');
    await page.waitForSelector('#practice-summary:not([hidden])');
    await page.getByRole('button',{name:'Back to my notebook',exact:true}).click();

    // A ten-word mixed review adds a quiz after each five scored spelling words.
    await preferences({sentence_enabled:true,definition_enabled:false,audio_enabled:false,meaning_enabled:true,quiz_interval_mode:'fixed',quiz_interval_min:5,quiz_interval_max:5});
    const beforeMixed=await notebook();
    await page.locator('.nav-item[data-page="today"]').click();
    await page.getByRole('button',{name:'Start my review',exact:true}).click();
    for(let group=0;group<2;group++) {
      for(let i=0;i<5;i++) {
        assert.equal(await page.locator('#practice-mode').innerText(),'SENTENCE SPELLING');
        const clue=await page.locator('#practice-clue').innerText();
        const word=beforeMixed.words.find(w=>w.clue===clue);
        assert(word,'The displayed sentence belongs to a saved word');
        await page.locator('#answer').fill(word.word);await page.locator('#answer').press('Enter');
        await page.waitForFunction(()=>document.querySelector('#practice-feedback').textContent.includes('Correct spelling!'));
        await page.keyboard.press('Enter');
      }
      await page.waitForFunction(()=>document.querySelector('#practice-mode').textContent==='MEANING QUIZ');
      assert(await page.locator('#answer-submit').isHidden());
      const target=await page.locator('#practice-word').innerText();
      const definition=(await notebook()).words.find(w=>w.word===target).definition;
      if(group===0) await page.locator('.meaning-choice').filter({hasText:definition}).click();
      else {
        const index=await page.locator('.meaning-choice').evaluateAll((options,meaning)=>options.findIndex(b=>b.textContent.includes(meaning)),definition);
        await page.keyboard.press(String(index+1));
      }
      await page.waitForFunction(()=>document.querySelector('#practice-feedback').textContent.includes('That’s the meaning'));
      assert.equal((await notebook()).progress.meanings,beforeMixed.progress.meanings+group+1);
      await page.keyboard.press('Enter');
    }
    await page.waitForSelector('#practice-summary:not([hidden])');
    const afterMixed=await notebook();
    assert.equal(afterMixed.progress.reviews,beforeMixed.progress.reviews+10);
    await page.getByRole('button',{name:'Back to my notebook',exact:true}).click();

    // Real keyboard-operated sliders persist a random [2, 7] rhythm.
    await page.locator('.nav-item[data-page="settings"]').click();
    await page.locator('select[name="quiz_interval_mode"]').selectOption('range');
    await page.locator('#quiz-min').focus();await page.keyboard.press('Home');await page.keyboard.press('ArrowRight');
    await page.locator('#quiz-max').focus();await page.keyboard.press('End');
    for(let i=0;i<3;i++) await page.keyboard.press('ArrowLeft');
    assert((await page.locator('#quiz-rhythm-label').innerText()).includes('2–7'));
    if(process.env.TYPEWRITER_SCREENSHOTS) {
      await page.locator('#quiz-rhythm').scrollIntoViewIfNeeded();
      await page.screenshot({path:path.join(process.env.TYPEWRITER_SCREENSHOTS,'quiz-rhythm.png'),animations:'disabled'});
      await page.setViewportSize({width:390,height:844});
      await page.locator('#quiz-rhythm').scrollIntoViewIfNeeded();
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      await page.screenshot({path:path.join(process.env.TYPEWRITER_SCREENSHOTS,'quiz-rhythm-mobile.png'),animations:'disabled'});
      await page.setViewportSize({width:1360,height:1050});
    }
    await page.getByRole('button',{name:'Save settings',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('#toast').textContent==='Settings saved.');
    await page.reload();await page.waitForSelector('#app-content:not([hidden])');
    assert.equal(await page.locator('select[name="quiz_interval_mode"]').inputValue(),'range');
    assert.equal(await page.locator('#quiz-min').inputValue(),'2');
    assert.equal(await page.locator('#quiz-max').inputValue(),'7');

    // Short session size is saved independently of quiz spacing.
    await page.locator('input[name="review_session_size"]').fill('2');
    await page.getByRole('button',{name:'Save settings',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('#toast').textContent==='Settings saved.');
    await preferences({meaning_enabled:false});
    assert.equal(await page.locator('input[name="review_session_size"]').inputValue(),'2');
    await page.locator('.nav-item[data-page="today"]').click();
    await page.getByRole('button',{name:'Start my review',exact:true}).click();
    assert((await page.locator('#practice-count').innerText()).endsWith('OF 2'));
    await page.keyboard.press('Escape');
    await page.getByRole('button',{name:'Back to my notebook',exact:true}).click();

    // An endless mixed session crosses the old limit and carries a seven-word gap.
    await preferences({meaning_enabled:true,quiz_interval_mode:'fixed',quiz_interval_min:7,quiz_interval_max:7});
    const beforeEndless=await notebook();
    await page.locator('.nav-item[data-page="today"]').click();
    await page.getByRole('button',{name:'Practise endlessly',exact:false}).click();
    assert(await page.locator('.practice-meter').isHidden());
    let endlessSpellings=0, endlessQuizzes=[];
    while(endlessSpellings<16) {
      assert(await page.locator('#practice-summary').isHidden());
      if((await page.locator('#practice-mode').innerText())==='MEANING QUIZ') {
        endlessQuizzes.push(endlessSpellings);
        const target=await page.locator('#practice-word').innerText();
        const definition=beforeEndless.words.find(w=>w.word===target).definition;
        const index=await page.locator('.meaning-choice').evaluateAll((options,meaning)=>options.findIndex(b=>b.textContent.includes(meaning)),definition);
        await page.keyboard.press(String(index+1));
        await page.waitForFunction(()=>document.querySelector('#practice-feedback').textContent.includes('That’s the meaning'));
      } else {
        const clue=await page.locator('#practice-clue').innerText();
        // Several generated fixtures share the same sentence after blanking the word.
        const id=await page.evaluate(()=>currentWord().id);
        const word=beforeEndless.words.find(w=>w.id===id);
        assert(word);assert.equal(clue,word.clue);
        await page.locator('#answer').fill(word.word);await page.locator('#answer').press('Enter');
        await page.waitForFunction(()=>document.querySelector('#practice-feedback').textContent.includes('Correct spelling!'));
        endlessSpellings++;
      }
      await page.keyboard.press('Enter');
      await page.waitForFunction(()=>document.querySelector('#practice-feedback').textContent==='');
    }
    assert.deepEqual(endlessQuizzes,[7,14]);
    assert((await page.locator('#practice-count').innerText()).includes('17 · ENDLESS'));
    const afterEndless=await notebook();
    assert.equal(afterEndless.progress.reviews,beforeEndless.progress.reviews+16);
    assert.equal(afterEndless.progress.meanings,beforeEndless.progress.meanings+2);
    await page.keyboard.press('Escape');
    await page.waitForSelector('#practice-summary:not([hidden])');
    assert((await page.locator('#practice-summary').innerText()).includes('18'));
    await page.getByRole('button',{name:'Back to my notebook',exact:true}).click();

    // A selected, already-reviewed word repeats; a failed refill never regrades it.
    await preferences({meaning_enabled:false});
    await page.locator('.nav-item[data-page="words"]').click();
    await page.locator('#word-search').fill('necessary');
    await page.getByRole('checkbox',{name:'Select necessary',exact:true}).check();
    await page.getByRole('button',{name:'Endless review',exact:false}).click();
    const beforeSingle=await notebook();
    for(let i=0;i<3;i++) {
      assert.equal(await page.locator('#practice-clue').innerText(),correctedWord.clue);
      await page.locator('#answer').fill('necessary');await page.locator('#answer').press('Enter');
      await page.waitForFunction(()=>document.querySelector('#practice-feedback').textContent.includes('Correct spelling!'));
      if(i===0) {
        await page.evaluate(()=> {
          const original=window.fetch;
          window.fetch=(...args)=> {
            if(args[0]==='/api/state') {window.fetch=original;return Promise.reject(new Error('Temporary test connection failure'));}
            return original(...args);
          };
        });
        await page.keyboard.press('Enter');
        await page.waitForFunction(()=>document.querySelector('#practice-feedback').textContent.includes('Couldn’t load the next words'));
        assert((await page.locator('#practice-feedback').innerText()).includes('answers are saved'));
      }
      await page.keyboard.press('Enter');
      await page.waitForFunction(()=>document.querySelector('#practice-feedback').textContent==='');
      assert((await page.locator('#practice-count').innerText()).includes(`${i+2} · ENDLESS`));
    }
    assert.equal((await notebook()).progress.reviews,beforeSingle.progress.reviews+3);
    await page.keyboard.press('Escape');await page.getByRole('button',{name:'Back to my notebook',exact:true}).click();

    // Meaning-only endless reviews continue even with a single selected word.
    await preferences({sentence_enabled:false,meaning_enabled:true});
    await page.locator('.nav-item[data-page="words"]').click();
    await page.locator('#word-search').fill('necessary');
    await page.getByRole('checkbox',{name:'Select necessary',exact:true}).check();
    await page.getByRole('button',{name:'Endless review',exact:false}).click();
    for(let i=0;i<3;i++) {
      const index=await page.locator('.meaning-choice').evaluateAll((options,meaning)=>options.findIndex(b=>b.textContent.includes(meaning)),correctedWord.definition);
      await page.keyboard.press(String(index+1));
      await page.waitForFunction(()=>document.querySelector('#practice-feedback').textContent.includes('That’s the meaning'));
      await page.keyboard.press('Enter');
      await page.waitForFunction(()=>document.querySelector('#practice-feedback').textContent==='');
      assert.equal(await page.locator('#practice-count').innerText(),`QUIZ ${i+2} · ENDLESS`);
    }
    await page.keyboard.press('Escape');await page.getByRole('button',{name:'Back to my notebook',exact:true}).click();

    assert.deepEqual(errors,[]);
    console.log('Browser checks passed: actual audio playback/replay, playback cleanup, combobox filtering and Tab completion, keyboard review corrections, ten repetitions, honest statistics, bulk entry, editing, persisted proxy settings, mobile layout, exercise filtering, automatic audio and keyboard replay, audio replacement and flagging, meaning scores, offline prompt roundtrip, failure popup and scoped fallback, meaning flags, re-evaluation controls, generated quiz options, protected meaning correction, immediate keyboard/click quiz answers, two quizzes alongside ten spelling words, saved range sliders, adjustable short sessions, endless spelling and quiz cadence across refills, saved totals on Escape, selected one-word repetition, safe refill retry, and endless meaning-only reviews.');
  } finally {
    if(browser) await browser.close();
    server.kill('SIGTERM');
    await new Promise(resolve=> {if(server.exitCode !== null) resolve();else server.once('exit',resolve);});
    fs.rmSync(directory,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
