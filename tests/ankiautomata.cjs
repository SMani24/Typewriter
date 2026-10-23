/* Real browser + ephemeral local peer, with synthetic words and no Anki writes. */
const {chromium}=require('playwright');
const {spawn}=require('node:child_process');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const assert=require('node:assert/strict');
(async()=>{
  const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'typewriter-ankiautomata-'));
  const script=`import sys,json,time,threading
from pathlib import Path
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from flask import request,jsonify
from typewriter.web import create_app
p=Path(sys.argv[1]);app=create_app(p,p/'no-keys',background=False);store=app.extensions['store']
store.save_settings(dict(preparation_method='manual',proxy_enabled=True,proxy_host='invalid.example',proxy_port=1))
store.add_words([dict(word='necessary',definition='Required.',sentence='It is necessary.',tip='One c, two s.'),dict(word='example',definition='An illustration.')])
config={'status':200,'delay':0,'app':'ankiautomata'};payloads=[];visits=[]
class Peer(BaseHTTPRequestHandler):
 def reply(self,status,body):
  self.send_response(status);self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
 def do_GET(self):
  visits.append(self.path);self.reply(200,json.dumps(dict(app=config['app'],api_version=1,capabilities=['lookup','sentence','activate'])).encode())
 def do_POST(self):
  visits.append(self.path);payloads.append(json.loads(self.rfile.read(int(self.headers['Content-Length']))));time.sleep(config['delay']);self.reply(config['status'],b'Lookup queued')
 def log_message(self,*args):pass
peer=ThreadingHTTPServer(('127.0.0.1',0),Peer);threading.Thread(target=peer.serve_forever,daemon=True).start()
app.extensions['ankiautomata'].address=f'http://127.0.0.1:{peer.server_port}'
@app.route('/api/test/peer',methods=['GET','POST'])
def peer_control():
 if request.method=='POST':config.update(request.get_json())
 return jsonify(payloads=payloads,visits=visits)
def no_network(*args,**kwargs):raise AssertionError('No dictionary or LLM calls allowed')
app.extensions['network'].request=no_network
app.run(host='127.0.0.1',port=int(sys.argv[2]),debug=False,threaded=True)`;
  const server=spawn(path.join(__dirname,'..','.venv','bin','python'),['-u','-c',script,directory,String(port)],{cwd:path.join(__dirname,'..'),stdio:['ignore','ignore','pipe']});let output='';server.stderr.on('data',chunk=>output+=chunk);let browser;
  try {
    const base=`http://127.0.0.1:${port}`;let ready=false;
    for(let i=0;i<100;i++){try{if((await fetch(base+'/api/health')).ok){ready=true;break;}}catch{}if(server.exitCode!==null)break;await new Promise(resolve=>setTimeout(resolve,100));}assert(ready,output);
    browser=await chromium.launch({headless:true,executablePath:process.env.TYPEWRITER_BROWSER_PATH || '/opt/google/chrome/chrome',args:['--no-sandbox']});
    const page=await browser.newPage({viewport:{width:1360,height:1050}}),errors=[],external=[];
    page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(!request.url().startsWith(base+'/'))external.push(request.url());});
    await page.goto(base);await page.waitForSelector('#app-content:not([hidden])');
    const api=(p,m='GET',d)=>page.evaluate(({p,m,d})=>api(p,m,d),{p,m,d});
    async function snapshot(){const data=await api('/export');delete data.exported;return data;}
    const before=await snapshot();
    await page.locator('.nav-item[data-page="words"]').click();
    const summary=page.locator('summary[aria-label="More actions for necessary"]');await summary.focus();await summary.press('Enter');
    const popup=summary.locator('..').locator('.word-actions-popup');await popup.waitFor({state:'visible'});
    function contained(inner,outer){assert(inner.x>=outer.x-1 && inner.x+inner.width<=outer.x+outer.width+1 && inner.y>=outer.y-1 && inner.y+inner.height<=outer.y+outer.height+1,'Word action must be fully visible inside the notebook panel');}
    contained(await popup.boundingBox(),await page.locator('.library-panel').boundingBox());
    await api('/test/peer','POST',{delay:.5});
    await popup.locator('[data-ankiautomata]').evaluate(button=>{button.click();button.click();});
    await page.waitForFunction(()=>ankiAutomataBusy);
    await page.evaluate(()=>refresh());
    assert(await page.locator('[data-ankiautomata]').evaluateAll(buttons=>buttons.every(button=>button.disabled)));
    await page.waitForFunction(()=>!ankiAutomataBusy);
    assert.equal((await api('/test/peer')).payloads.length,1);
    assert.equal(await page.locator('#toast').innerText(),'Opened in AnkiAutomata. Review the card there.');
    await api('/test/peer','POST',{delay:0});
    const necessary=before.words.find(word=>word.word==='necessary');
    assert.deepEqual((await api('/test/peer')).payloads[0],{text:'necessary',sentence:necessary.sentence});
    await page.getByRole('button',{name:'Edit necessary',exact:true}).click();
    const word=page.locator('#word-form [name="word"]'),sentence=page.locator('#word-form [name="sentence"]');
    await word.fill('essential');const draft='It is essential: café, “quotes”, apostrophe\'s, $(touch /tmp/never); `echo nope` & <tag>.';await sentence.fill(draft);
    await page.locator('#word-form [name="definition"]').fill('An unsaved personal meaning.');
    const editorButton=page.locator('[data-action="open-ankiautomata"]');
    assert((await page.locator('#single-fields').innerText()).includes('including unsaved edits'));
    await editorButton.click();await page.waitForFunction(()=>!ankiAutomataBusy && document.querySelector('#ankiautomata-status').textContent.startsWith('Opened'));
    assert(await page.locator('#word-dialog').isVisible());assert.equal(await word.inputValue(),'essential');assert.equal(await sentence.inputValue(),draft);
    assert.deepEqual((await api('/test/peer')).payloads.at(-1),{text:'essential',sentence:draft});
    assert.deepEqual(await snapshot(),before);
    for(const [status,message] of [[429,'queue is full'],[413,'Shorten'],[500,'Check its window']]){
      await api('/test/peer','POST',{status});await editorButton.click();await page.waitForFunction(()=>!ankiAutomataBusy);
      assert((await page.locator('#ankiautomata-status').innerText()).includes(message));
      assert(await page.locator('#word-dialog').isVisible());assert.equal(await sentence.inputValue(),draft);assert.equal(await word.inputValue(),'essential');assert(!(await editorButton.isDisabled()));
    }
    await api('/test/peer','POST',{status:200,app:'wrong-app'});const count=(await api('/test/peer')).payloads.length;
    await editorButton.click();await page.waitForFunction(()=>!ankiAutomataBusy);
    assert((await page.locator('#ankiautomata-status').innerText()).includes('compatible AnkiAutomata'));
    assert.equal((await api('/test/peer')).payloads.length,count);
    await api('/test/peer','POST',{app:'ankiautomata'});await editorButton.click();await page.waitForFunction(()=>!ankiAutomataBusy && document.querySelector('#ankiautomata-status').textContent.startsWith('Opened'));
    assert.equal(await page.locator('#word-form [name="definition"]').inputValue(),'An unsaved personal meaning.');
    await page.locator('[data-close="word-dialog"]').click();
    await page.getByRole('button',{name:'Add words',exact:true}).click();await word.fill('serendipity');await sentence.fill('');
    await editorButton.click();await page.waitForFunction(()=>!ankiAutomataBusy && document.querySelector('#ankiautomata-status').textContent.startsWith('Opened'));
    assert.deepEqual((await api('/test/peer')).payloads.at(-1),{text:'serendipity',sentence:''});assert.deepEqual(await snapshot(),before);
    await page.locator('[data-close="word-dialog"]').click();
    await page.setViewportSize({width:390,height:844});
    const lastMenu=page.locator('summary[aria-label="More actions for example"]');await lastMenu.click();
    const mobilePopup=lastMenu.locator('..').locator('.word-actions-popup');await mobilePopup.waitFor({state:'visible'});
    contained(await mobilePopup.boundingBox(),await page.locator('.library-panel').boundingBox());
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'No horizontal overflow on a phone');
    await mobilePopup.getByRole('button',{name:'Open in AnkiAutomata'}).click();await page.waitForFunction(()=>!ankiAutomataBusy);
    assert.deepEqual((await api('/test/peer')).payloads.at(-1),{text:'example',sentence:''});
    assert.deepEqual(await snapshot(),before);assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
    if(process.env.TYPEWRITER_SCREENSHOTS){fs.mkdirSync(process.env.TYPEWRITER_SCREENSHOTS,{recursive:true});await lastMenu.click();await page.screenshot({path:path.join(process.env.TYPEWRITER_SCREENSHOTS,'ankiautomata-mobile.png')});}
    console.log('AnkiAutomata browser checks passed: saved/draft handoffs, no notebook changes, duplicate-click guard, retries, preserved edits, keyboard menu, mobile layout, and server-only peer requests.');
  } finally {if(browser)await browser.close();if(server.exitCode===null){server.kill('SIGTERM');await new Promise(resolve=>server.once('exit',resolve));}fs.rmSync(directory,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
