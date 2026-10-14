/* A local draft with advisory spelling hints; typing is never corrected. */
(function () {
  'use strict';
  const q = selector => document.querySelector(selector);
  const key = 'typewriter-essay-recovery';
  let record = null, saved = '', loading = false, saving = false, blocked = false;
  let saveTimer, checkTimer, controller, checkVersion = 0, recovery = null, ranges = [];
  const fields = () => ({title:q('#essay-title').value,prompt:q('#essay-prompt').value,body:q('#essay-body').value,highlight:q('#essay-highlight').checked});
  const signature = value => JSON.stringify({title:value.title,prompt:value.prompt,body:value.body,highlight:value.highlight});
  const dirty = () => !!record && signature(fields()) !== saved;
  function status(message, error = false) {q('#essay-save-status').textContent=message;q('#essay-save-status').classList.toggle('error',error);}
  function remember() {
    try {
      if (dirty()) sessionStorage.setItem(key,JSON.stringify({...fields(),version:record.version}));
      else sessionStorage.removeItem(key);
    } catch { /* The unload guard and local database save still protect the draft. */ }
  }
  function fill(value) {
    q('#essay-title').value=value.title;q('#essay-prompt').value=value.prompt;
    q('#essay-body').value=value.body;q('#essay-highlight').checked=value.highlight;
    updateCount();scheduleCheck();
  }
  async function open() {
    if (loading || saving || dirty()) {sync();return;}
    loading=true;
    ['#essay-body','#essay-title','#essay-prompt','#essay-highlight'].forEach(id=>q(id).disabled=true);
    try {
      record=await api('/essay');saved=signature(record);blocked=false;
      fill(record);status(record.updated?'Saved on this computer.':'A fresh page, ready for you.');
      try {recovery=JSON.parse(sessionStorage.getItem(key));}catch {recovery=null;}
      if (recovery && typeof recovery.body==='string' && typeof recovery.title==='string' && typeof recovery.prompt==='string' && typeof recovery.highlight==='boolean' && signature(recovery)!==saved) {
        if (recovery.version===record.version) {fill(recovery);status('Recovered your unsaved writing.');saveTimer=setTimeout(save,600);}
        else q('#essay-recovery').hidden=false;
      } else {recovery=null;remember();q('#essay-recovery').hidden=true;}
    } catch(error) {status('Could not open the saved draft. '+error.message,true);throw error;}
    finally {loading=false;if(record) ['#essay-body','#essay-title','#essay-prompt','#essay-highlight'].forEach(id=>q(id).disabled=false);sync();}
  }
  async function save() {
    clearTimeout(saveTimer);
    if (!record || saving || !dirty() || blocked) return;
    saving=true;const snapshot=fields();status('Saving your draft…');q('#essay-save').disabled=true;
    try {
      const result=await api('/essay','PUT',{...snapshot,version:record.version});
      record=result;saved=signature(snapshot);remember();
      status(dirty()?'Unsaved changes · saving shortly…':'Saved on this computer.');q('#essay-save').textContent='Save now';
      if(dirty()) saveTimer=setTimeout(save,600);
    } catch(error) {
      blocked=error.message.includes('changed in another tab');
      status('Your writing is kept in this tab. '+error.message,true);
      q('#essay-save').textContent=blocked?'Download before reloading':'Retry save';
    } finally {saving=false;q('#essay-save').disabled=false;}
  }
  function updateCount() {
    const count=q('#essay-body').value.trim().match(/\S+/gu)?.length || 0;
    q('#essay-word-count').textContent=count+' '+(count===1?'word':'words');
  }
  function sync() {
    const area=q('#essay-body');if(!area) return;
    q('#essay-highlights').style.width=area.clientWidth+'px';
    q('#essay-highlight-content').style.transform=`translate(${-area.scrollLeft}px,${-area.scrollTop}px)`;
  }
  function paint(text) {
    let at=0, html='';
    for(const range of ranges) {
      html+=escapeHtml(text.slice(at,range.start))+'<mark>'+escapeHtml(text.slice(range.start,range.end))+'</mark>';at=range.end;
    }
    q('#essay-highlight-content').innerHTML=html+escapeHtml(text.slice(at))+'\n';sync();
  }
  function scheduleCheck() {
    clearTimeout(checkTimer);controller?.abort();const version=++checkVersion;
    ranges=[];q('#essay-highlight-content').textContent='';
    q('#essay-spelling-status').classList.remove('error');
    const text=q('#essay-body').value;
    if (!q('#essay-highlight').checked || !text.trim()) {q('#essay-spelling-status').textContent=q('#essay-highlight').checked?'Ready when you start writing.':'Spelling hints are off.';return;}
    q('#essay-spelling-status').textContent='Checking spelling…';
    checkTimer=setTimeout(async()=>{
      controller=new AbortController();
      try {
        const result=await api('/essay/spelling','POST',{text},controller.signal);
        if(version!==checkVersion || text!==q('#essay-body').value || !q('#essay-highlight').checked) return;
        ranges=result.errors;paint(text);
        q('#essay-spelling-status').textContent=result.limited?'Showing the first 500 possible errors.':ranges.length?`${ranges.length} possible spelling ${ranges.length===1?'error':'errors'}`:'No spelling flags found.';
      }catch(error) {
        if(version!==checkVersion || error.name==='AbortError') return;
        q('#essay-spelling-status').textContent='Spelling hints unavailable. Your writing is unchanged.';q('#essay-spelling-status').classList.add('error');
      }
    },400);
  }
  function edited(check=false) {
    if(!record) return;
    remember();clearTimeout(saveTimer);status(blocked?'Another tab has a newer saved essay. Download your draft before reloading.':'Unsaved changes · saving shortly…',blocked);
    if(!blocked) saveTimer=setTimeout(save,600);
    updateCount();if(check) scheduleCheck();
  }
  q('#essay-body').addEventListener('input',()=>edited(true));
  ['#essay-title','#essay-prompt'].forEach(id=>q(id).addEventListener('input',()=>edited()));
  q('#essay-highlight').addEventListener('change',()=>edited(true));
  q('#essay-body').addEventListener('scroll',sync);
  new ResizeObserver(sync).observe(q('#essay-body'));
  q('#essay-save').addEventListener('click',()=>{if(blocked) download();else save();});
  q('#essay-restore').addEventListener('click',()=>{if(recovery){fill(recovery);recovery=null;q('#essay-recovery').hidden=true;edited(true);}});
  q('#essay-keep').addEventListener('click',()=>{recovery=null;remember();q('#essay-recovery').hidden=true;});
  function download() {
    const value=fields();
    const text=[value.title,value.prompt,value.body].filter(Boolean).join('\n\n');
    const url=URL.createObjectURL(new Blob([text],{type:'text/plain;charset=utf-8'}));
    const anchor=document.createElement('a');anchor.href=url;anchor.download='typewriter-essay.txt';anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  q('#essay-download').addEventListener('click',download);
  window.addEventListener('beforeunload',event=>{if(dirty()){remember();event.preventDefault();event.returnValue='';}});
  document.addEventListener('visibilitychange',()=>{if(document.hidden && dirty() && !blocked) save();});
  window.TypewriterEssay={open,sync};
})();
