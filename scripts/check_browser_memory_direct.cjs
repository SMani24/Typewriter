/* Isolated, synthetic memory audit. No notebook data, keys, or provider calls. */
const {spawn}=require('node:child_process');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const net=require('node:net');
const assert=require('node:assert/strict');
(async()=>{
  const cycles=process.argv[2]===undefined?80:Number(process.argv[2]);assert(Number.isInteger(cycles) && cycles>=10 && cycles<=1000,'Choose 10–1000 measured cycles');
  const editMode=process.argv[3] || 'replace';assert(['replace','typing'].includes(editMode),'Choose replace or typing mode');
  const root=path.resolve(__dirname,'..'),directory=fs.mkdtempSync(path.join(os.tmpdir(),'typewriter-direct-'));
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
  let chrome,ws;
  const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  try{
    let ready=false;for(let i=0;i<100;i++){try{if((await fetch(`http://127.0.0.1:${port}/api/health`)).ok){ready=true;break;}}catch{}await pause(100);}assert(ready);
    const profile=path.join(directory,'chrome');
    chrome=spawn(process.env.TYPEWRITER_BROWSER_PATH || '/opt/google/chrome/chrome',['--headless=new','--no-sandbox','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-extensions','--window-size=1360,1000','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{stdio:['ignore','ignore','ignore']});
    let endpoint;for(let i=0;i<100;i++){try{const [p,url]=fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').trim().split('\n');endpoint=`ws://127.0.0.1:${p}${url}`;break;}catch{}await pause(100);}assert(endpoint);
    ws=new WebSocket(endpoint);await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});
    let serial=0;const pending=new Map();
    ws.onmessage=event=>{const data=JSON.parse(event.data),task=pending.get(data.id);if(task){pending.delete(data.id);data.error?task.reject(new Error(data.error.message)):task.resolve(data.result);}};
    function send(method,params={},sessionId){return new Promise((resolve,reject)=>{const id=++serial;const timer=setTimeout(()=>{pending.delete(id);reject(new Error(method+' timed out'));},30000);pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});ws.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));});}
    const {targetId}=await send('Target.createTarget',{url:`http://127.0.0.1:${port}`});const {sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});
    async function evaluate(expression){const result=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},sessionId);if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);return result.result.value;}
    for(let i=0;i<100;i++){if(await evaluate("!!document.querySelector('#app-content') && !document.querySelector('#app-content').hidden"))break;await pause(100);}
    const samples=[],started=Date.now(),essay='A neccessary change has downsides. My CV describes the enviroment. '.repeat(400);
    for(let i=0;i<cycles+10;i++){
      await evaluate(`(async()=>{navigate('words');await refresh();navigate('essay');while(document.querySelector('#essay-body').disabled)await new Promise(r=>setTimeout(r,5));const area=document.querySelector('#essay-body');area.focus();${editMode==='replace' || i===0?'area.select();':'area.setSelectionRange(area.value.length,area.value.length);'}})()`);
      await send('Input.insertText',{text:editMode==='replace' || i===0?essay:' '},sessionId);
      await evaluate("(async()=>{document.querySelector('#essay-words-open').click();while(!document.querySelector('#essay-words-dialog').open || document.querySelector('#essay-words-extract').disabled || !document.querySelector('.essay-word-row'))await new Promise(r=>setTimeout(r,5));document.querySelector('[data-close=essay-words-dialog]').click();})()");
      if([9,cycles/2+9,cycles+9].includes(i)){
        await evaluate("(async()=>{document.querySelector('#essay-save').click();while(document.querySelector('#essay-save-status').textContent!=='Saved on this computer.')await new Promise(r=>setTimeout(r,5));})()");
        await send('HeapProfiler.collectGarbage',{},sessionId);const heap=await send('Runtime.getHeapUsage',{},sessionId),dom=await send('Memory.getDOMCounters',{},sessionId);
        const processes=(await send('SystemInfo.getProcessInfo')).processInfo;let pss=0,measured=0;
        for(const process of processes){try{pss+=Number(fs.readFileSync(`/proc/${process.id}/smaps_rollup`,'utf8').match(/^Pss:\s+(\d+)/m)[1]);measured++;}catch{}}
        samples.push({cycle:i-9,js_heap_mib:Math.round(heap.usedSize/1024**2*100)/100,dom_nodes:dom.nodes,live_elements:await evaluate('document.querySelectorAll("*").length'),documents:dom.documents,event_listeners:dom.jsEventListeners,browser_pss_mib:Math.round(pss/1024*100)/100,processes_measured:measured});
      }
    }
    console.log(JSON.stringify({instrumentation:'Direct CDP without Network.enable or Playwright',words:200,essay_characters:essay.length,edit_mode:editMode,measured_cycles:cycles,warmup_cycles:10,samples,elapsed_seconds:Math.round((Date.now()-started)/100)/10},null,2));
  }finally{
    if(ws)ws.close();if(chrome){chrome.kill('SIGTERM');await new Promise(resolve=>{if(chrome.exitCode!==null)resolve();else chrome.once('exit',resolve);});}
    server.kill('SIGTERM');await new Promise(resolve=>{if(server.exitCode!==null)resolve();else server.once('exit',resolve);});fs.rmSync(directory,{recursive:true,force:true,maxRetries:3,retryDelay:100});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
