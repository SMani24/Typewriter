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
  const script = 'import sys; from pathlib import Path; from typewriter.web import create_app; create_app(sys.argv[1], Path(sys.argv[1])/"keys.txt", background=False).run(host="127.0.0.1",port=int(sys.argv[2]),debug=False,threaded=True)';
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
    await page.locator('#answer').fill('neccessary');
    await page.locator('#answer').press('Enter');
    await page.waitForSelector('.letter-diff');
    await page.locator('#answer-submit').click();
    assert.equal(await page.locator('#practice-word').innerText(),'necessary');
    await page.locator('#answer').fill('necessary');
    await page.locator('#answer').press('Enter');
    await page.waitForFunction(()=>document.querySelector('#answer-submit').textContent.includes('Next word'));
    await page.locator('#answer-submit').click();
    await page.getByRole('button',{name:'End session',exact:true}).click();
    await page.getByRole('button',{name:'Back to my notebook',exact:true}).click();

    await page.locator('.nav-item[data-page="words"]').click();
    await page.getByRole('button',{name:'Drill necessary',exact:true}).click();
    await page.locator('#drill-target').selectOption('10');
    await page.getByRole('button',{name:'Begin drill',exact:true}).click();
    for(let n=0;n<10;n++) {
      await page.waitForFunction(()=>!document.querySelector('#answer').disabled);
      await page.locator('#answer').fill('necessary');
      await page.locator('#answer').press('Enter');
      if(n<9) await page.waitForFunction(count=>document.querySelector('#practice-count').textContent.startsWith(String(count)),n+1);
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

    await page.locator('.nav-item[data-page="settings"]').click();
    await page.locator('label.switch').filter({has:page.locator('input[name="proxy_enabled"]')}).click();
    await page.locator('input[name="proxy_port"]').fill('10809');
    await page.getByRole('button',{name:'Save settings',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('#toast').textContent==='Settings saved.');
    await page.reload();
    await page.waitForSelector('#app-content:not([hidden])');
    assert.equal(await page.locator('input[name="proxy_port"]').inputValue(),'10809');
    assert(await page.locator('input[name="proxy_enabled"]').isChecked());

    await page.setViewportSize({width:390,height:844});
    await page.locator('.nav-item[data-page="today"]').click();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.getByRole('button',{name:'Start a word drill',exact:true}).click();
    await page.getByRole('button',{name:'Begin drill',exact:true}).click();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.getByRole('button',{name:'End session',exact:true}).click();
    await page.getByRole('button',{name:'Back to my notebook',exact:true}).click();
    assert.deepEqual(errors,[]);
    console.log('Browser checks passed: review corrections, ten repetitions, honest statistics, bulk entry, editing, persisted proxy settings, and mobile layout.');
  } finally {
    if(browser) await browser.close();
    server.kill('SIGTERM');
    await new Promise(resolve=> {if(server.exitCode !== null) resolve();else server.once('exit',resolve);});
    fs.rmSync(directory,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
