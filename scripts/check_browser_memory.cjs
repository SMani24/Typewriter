/* Isolated, synthetic memory audit. No notebook data, keys, or provider calls. */
const {chromium}=require('playwright');
const {spawn}=require('node:child_process');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const net=require('node:net');
const assert=require('node:assert/strict');
(async()=>{
  const cycles=process.argv[2]===undefined?80:Number(process.argv[2]);assert(Number.isInteger(cycles) && cycles>=10 && cycles<=1000,'Choose 10–1000 measured cycles');
  const essay='A neccessary change has downsides. My CV describes the enviroment. '.repeat(400);
  const editMode=process.argv[3] || 'replace';assert(['replace','typing'].includes(editMode),'Choose replace or typing mode');
  const root=path.resolve(__dirname,'..'),directory=fs.mkdtempSync(path.join(os.tmpdir(),'typewriter-heap-'));
  const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const script=`import sys
from pathlib import Path
from typewriter.web import create_app
p=Path(sys.argv[1]);app=create_app(p,p/'no-keys',background=False);s=app.extensions['store']
s.save_settings({'preparation_method':'manual','auto_ai':False})
s.add_words([{'word':'sample'+chr(97+i//26)+chr(97+i%26),'definition':'A deliberately synthetic example.','sentence':'The sample'+chr(97+i//26)+chr(97+i%26)+' provides a useful example.','tip':'Notice the letters.'} for i in range(200)])
def offline(*args,**kwargs):raise AssertionError('No external requests during memory audit')
app.extensions['network'].request=offline
app.run(host='127.0.0.1',port=int(sys.argv[2]),threaded=True)`;
  const server=spawn(path.join(root,'.venv/bin/python'),['-u','-c',script,directory,String(port)],{cwd:root,env:{...process.env,GEMINI_API_KEY:'',GEMINI_API_KEYS:''},stdio:['ignore','ignore','ignore']});
  let browser;
  try{
    let ready=false;for(let i=0;i<100;i++){try{if((await fetch(`http://127.0.0.1:${port}/api/health`)).ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,100));}assert(ready,'Temporary app did not start');
    browser=await chromium.launch({headless:true,executablePath:process.env.TYPEWRITER_BROWSER_PATH || '/opt/google/chrome/chrome',args:['--no-sandbox']});
    const page=await browser.newPage({viewport:{width:1360,height:1000}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(`http://127.0.0.1:${port}`);await page.waitForSelector('#app-content:not([hidden])');
    const cdp=await page.context().newCDPSession(page),browserCdp=await browser.newBrowserCDPSession(),samples=[],started=Date.now();
    async function sample(cycle){
      await cdp.send('HeapProfiler.collectGarbage');const heap=await cdp.send('Runtime.getHeapUsage'),dom=await cdp.send('Memory.getDOMCounters');
      const processes=(await browserCdp.send('SystemInfo.getProcessInfo')).processInfo;let pss=0;const breakdown=[];
      for(const process of processes){try{const value=Number(fs.readFileSync(`/proc/${process.id}/smaps_rollup`,'utf8').match(/^Pss:\s+(\d+)/m)[1]);pss+=value;breakdown.push({type:process.type,pss_mib:Math.round(value/1024*100)/100});}catch{}}
      const result={cycle,js_heap_mib:Math.round(heap.usedSize/1024**2*100)/100,dom_nodes:dom.nodes,live_elements:await page.locator('*').count(),documents:dom.documents,event_listeners:dom.jsEventListeners,browser_pss_mib:breakdown.length?Math.round(pss/1024*100)/100:null,processes_measured:breakdown.length,processes:breakdown};
      if(process.env.TYPEWRITER_MEMORY_PROGRESS)console.error(JSON.stringify(result));return result;
    }
    const sampleCycles=new Set([0,Math.floor(cycles/2),cycles,...[80,160].filter(n=>n<cycles)]);
    for(let i=0;i<cycles+10;i++){
      await page.locator('.nav-item[data-page="words"]').click();await page.evaluate(()=>refresh());
      await page.locator('.nav-item[data-page="essay"]').click();await page.waitForFunction(()=>!document.querySelector('#essay-body').disabled);
      if(editMode==='replace' || i===0)await page.locator('#essay-body').fill(essay);
      else{await page.locator('#essay-body').press('Control+End');await page.keyboard.insertText(' ');}
      await page.locator('#essay-words-open').click();await page.locator('.essay-word-row').first().waitFor();await page.locator('[data-close="essay-words-dialog"]').first().click();
      if(sampleCycles.has(i-9)){
        await page.locator('#essay-save').click();await page.waitForFunction(()=>document.querySelector('#essay-save-status').textContent==='Saved on this computer.');
        samples.push(await sample(i-9));
      }
    }
    // An audit-only diagnostic: clear native textarea undo, then restore the exact text.
    // The application never clears the user's undo history to hide memory growth.
    await page.evaluate(async()=>{const area=document.querySelector('#essay-body'),text=area.value;area.value='';area.value=text;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});
    const afterUndoReset=await sample('after-undo-reset');
    assert.deepEqual(errors,[]);console.log(JSON.stringify({words:200,essay_characters:essay.length,edit_mode:editMode,measured_cycles:cycles,warmup_cycles:10,browser:await browser.version(),samples,after_undo_reset:afterUndoReset,heap_growth_mib:Math.round((samples.at(-1).js_heap_mib-samples[0].js_heap_mib)*100)/100,elapsed_seconds:Math.round((Date.now()-started)/100)/10},null,2));
  }finally{
    if(browser)await browser.close();server.kill('SIGTERM');await new Promise(resolve=>{if(server.exitCode!==null)resolve();else server.once('exit',resolve);});fs.rmSync(directory,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
