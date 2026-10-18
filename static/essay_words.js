/* Advisory flags become a checked word list; essay text is never rewritten. */
(function () {
  'use strict';
  const q=selector=>document.querySelector(selector);
  let rows=[],busy=false,sourceHash='',storageKey=null,loaded=false,intakeItems=[],discarded=new Set();
  let reply=null,replyText='',replyVersion=0;
  const key=word=>word.toLowerCase().replaceAll('’',"'");
  const normalize=word=>{
    const value=word.normalize('NFKC').trim().toLowerCase().replace(/\s+/g,' ');
    return value.length<=80 && /^[a-z]+(?:[ '\-][a-z]+)*$/.test(value) ? value : null;
  };
  const existing=()=>new Set((state?.words || []).map(w=>w.word));
  const selected=()=>rows.filter(row=>!row.handled);
  const ready=()=>rows.filter(row=>!row.handled && normalize(row.corrected));
  function message(text,error=false) {q('#essay-words-status').textContent=text;q('#essay-words-status').classList.toggle('error',error);}
  function remember() {try {if(storageKey) localStorage.setItem(storageKey,JSON.stringify({rows,sourceHash,discarded:[...discarded].slice(-1000)}));}catch { /* The open list stays available. */ }}
  async function digest(text) {return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(v=>v.toString(16).padStart(2,'0')).join('');}
  async function restore() {
    if(loaded) return;
    const health=await api('/health');storageKey='typewriter-essay-words-'+health.instance;loaded=true;
    try {
      const saved=JSON.parse(localStorage.getItem(storageKey) || sessionStorage.getItem(storageKey));
      if(saved && Array.isArray(saved.rows) && saved.rows.length<=500 && saved.rows.every(r=>typeof r.original==='string' && typeof r.corrected==='string' && r.corrected.length<=80 && /^[a-f0-9]{32}$/.test(r.extraction_id) && Number.isInteger(r.id) && Number.isInteger(r.revision) && r.revision>=0)) {
        rows=saved.rows.map(row=>({...row,handled:!!(row.handled || row.added)}));discarded=new Set(Array.isArray(saved.discarded)?saved.discarded.filter(w=>typeof w==='string').slice(-1000):[]);sourceHash=typeof saved.sourceHash==='string'?saved.sourceHash:'';
      }
    }catch { /* A malformed browser recovery record is ignored. */ }
  }
  function rowStatus(row){
    if(row.handled)return row.actionStatus || 'Already queued.';
    if(row.corrected && !normalize(row.corrected))return 'Use an English word or short phrase, up to 80 characters.';
    if(!row.corrected)return row.note || 'Enter the intended spelling, or discard this flag.';
    if(existing().has(normalize(row.corrected)))return 'Already in your notebook · confirm to record this essay mistake.';
    return 'Ready to choose a preparation queue.';
  }
  function update(){
    const count=new Set(ready().map(r=>normalize(r.corrected))).size;
    q('#essay-words-count').textContent=`${rows.length} flags kept · ${count} checked ${count===1?'spelling':'spellings'} ready`;
    q('#essay-words-add').textContent=count?`Queue ${count} ready ${count===1?'word':'words'}`:'No spellings ready';q('#essay-words-add').disabled=busy || !count;
    q('#essay-words-export').disabled=busy || !selected().length;
    q('#essay-words-use').disabled=busy || !reply || replyText!==q('#essay-words-reply').value;
    q('#essay-words-preview').disabled=busy || !q('#essay-words-reply').value.trim();
    ['#essay-words-extract','#essay-words-size','#essay-words-context','#essay-words-file'].forEach(id=>q(id).disabled=busy);
    q('#essay-words-list').querySelectorAll('[data-row]').forEach(element=>{
      const row=rows[Number(element.dataset.row)];if(!row)return;element.querySelector('input').disabled=busy || row.handled;
      element.querySelector('.essay-word-status').textContent=rowStatus(row);
      element.querySelector('[data-add-row]').disabled=busy || row.handled || !normalize(row.corrected);
      element.querySelector('[data-add-row]').textContent=row.handled?'Saved':existing().has(normalize(row.corrected))?'Confirm mistake':'Queue word';
      element.querySelectorAll('[data-discard-row],[data-accept-row]').forEach(button=>button.disabled=busy);
    });
  }
  function render(){
    setMarkup(q('#essay-words-list'),rows.length?rows.map((row,i)=>`<div class="essay-word-row" data-row="${i}"><div class="essay-word-source"><strong>${escapeHtml(row.original)}</strong><span>${row.count} ${row.count===1?'occurrence':'occurrences'}${row.current?'':' · earlier draft'}</span></div><div class="essay-word-correction"><label class="sr-only" for="essay-correction-${i}">Correct spelling for ${escapeHtml(row.original)}</label><input id="essay-correction-${i}" data-correction="${i}" type="text" maxlength="80" autocomplete="off" spellcheck="false" placeholder="Intended spelling…" value="${escapeHtml(row.corrected)}"><span class="essay-word-status field-note"></span>${row.note?`<small class="essay-word-reason">${escapeHtml(row.note)}</small>`:''}</div><div class="essay-row-actions"><button class="text-button" data-add-row="${i}">${existing().has(normalize(row.corrected))?'Review again':'Queue word'}</button><button class="icon-button" data-accept-row="${i}" aria-label="Accept spelling ${escapeHtml(row.original)} in dictionary" title="Add spelling to your personal dictionary">${icon('book-add')}</button><button class="icon-button" data-discard-row="${i}" aria-label="Discard flag ${escapeHtml(row.original)}" title="Discard this flag">${icon('discard')}</button></div></div>`).join(''):'<p class="muted">No flags in this list. Your next new spelling flags will appear here.</p>');
    update();
  }
  async function run(action){if(busy)return;busy=true;update();try{await action();}catch(error){message(error.message || 'Please try again.',true);}finally{busy=false;render();}}
  async function extract(){
    const text=q('#essay-body').value,result=await api('/essay/words','POST',{text});
    const found=new Map(result.words.map(row=>[key(row.original),row]));const fresh=[];
    for(const row of rows){row.current=found.has(key(row.original));if(row.current)row.count=found.get(key(row.original)).count;}
    for(const item of result.words){if(discarded.has(key(item.original)) || rows.some(row=>key(row.original)===key(item.original)))continue;fresh.push({...item,corrected:'',revision:0,note:'',current:true,handled:false});}
    const admitted=fresh.slice(0,Math.max(0,500-rows.length));rows=[...admitted,...rows];sourceHash=await digest(text);remember();
    q('#essay-words-source-note').textContent='New flags appear first. Earlier flags and your corrections stay until you discard them. Your essay is unchanged.';
    message(admitted.length<fresh.length?'This list has reached 500 flags. Discard completed flags to make room; your earlier words have been kept.':result.limited?'Showing up to 500 unique flags.':admitted.length?`${admitted.length} new flags added above your earlier words.`:'No new flags. Your earlier review list is kept.');
  }
  let opening=false;
  async function open(){if(opening || q('#essay-words-dialog').open)return;opening=true;try{await restore();q('#essay-words-size').value=state.settings.offline_batch_size || 20;q('#essay-words-dialog').showModal();render();await run(extract);}finally{opening=false;}}
  function add(items){
    intakeItems=items.filter(row=>!row.handled && normalize(row.corrected));if(!intakeItems.length)throw new Error('Check at least one intended spelling first.');
    q('#essay-intake-count').textContent=`${new Set(intakeItems.map(row=>normalize(row.corrected))).size} words. New words will be saved outside practice until prepared. Existing practice words will be marked for review; unfinished words keep their preparation queue.`;
    q('#essay-intake-dialog').showModal();
  }
  async function confirmIntake(){
    const choice=q('input[name="essay-intake-mode"]:checked').value;
    const mode=choice==='llm' && q('#essay-intake-auto-voice').checked?'llm_auto':choice;
    const result=await api('/essay/words/intake','POST',{mode,words:intakeItems.map(row=>({extraction_id:row.extraction_id,id:row.id,word:normalize(row.corrected)}))});
    for(const row of intakeItems){
      const prior=state.words.find(word=>word.word===normalize(row.corrected));row.handled=true;row.revision++;
      row.actionStatus=prior?.preparation_queue ? `Already in the ${prior.preparation_queue==='manual'?'manual':'LLM'} preparation queue.` : prior ? result.marked.includes(prior.id)?'Essay mistake recorded · available for review.':'Already in your notebook.' : mode==='manual'?'In the manual preparation queue.':'In the LLM preparation queue.';
    }
    q('#essay-intake-dialog').close();intakeItems=[];remember();await refresh();message(`${result.added.length} words queued · ${result.marked.length} words marked for another review. Review scores were kept.`);render();
  }
  async function exportPrompts() {
    const size=Number(q('#essay-words-size').value);
    const data={words:selected().map(r=>({extraction_id:r.extraction_id,id:r.id,revision:r.revision})),size,include_context:q('#essay-words-context').checked};
    const response=await fetch('/api/essay/words/prompts',{method:'POST',headers:{'Content-Type':'application/json','X-Typewriter-Token':q('meta[name="typewriter-token"]').content},body:JSON.stringify(data)});
    if(!response.ok) throw new Error((await response.json()).error);
    const blob=await response.blob();
    const name=response.headers.get('Content-Disposition')?.match(/filename="?([^";]+)/)?.[1] || 'typewriter-essay-words.zip';
    download(blob,name);
    message(`Prompt files downloaded · up to ${size} flags per file. Give them to your chosen LLM, then preview its replies below. Nothing was sent to a provider.`);
  }
  function download(blob,name) {const url=URL.createObjectURL(blob);const anchor=document.createElement('a');anchor.href=url;anchor.download=name;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  function invalidateReply() {reply=null;replyText='';replyVersion++;q('#essay-words-reply-preview').textContent='';update();}
  async function previewReply() {
    const text=q('#essay-words-reply').value,version=replyVersion;
    const result=await api('/essay/words/preview','POST',{text});
    if(version!==replyVersion || text!==q('#essay-words-reply').value) return;
    reply=result;replyText=text;
    q('#essay-words-reply-preview').innerHTML=result.words.map(entry=>`<div class="essay-reply-row"><strong>${escapeHtml(entry.original)}</strong><span>${entry.action==='skip'?'Skip flag':`→ ${escapeHtml(entry.word)}${entry.already_exists?' · Already in notebook':''}`}</span><small>${escapeHtml(entry.reason)}</small></div>`).join('');
    message('Reply checked. Use suggestions to put them in the review list, then check spellings before adding words.');
  }
  function useSuggestions() {
    if(busy || !reply || replyText!==q('#essay-words-reply').value) return;
    let kept=0,used=0;
    for(const entry of reply.words) {
      let row=rows.find(r=>key(r.original)===key(entry.original));
      if(row?.handled){kept++;continue;}
      if(row && (row.extraction_id===entry.extraction_id ? row.revision!==entry.snapshot_revision : row.edited)) {kept++;continue;}
      if(discarded.has(key(entry.original))) {kept++;continue;}
      if(entry.action==='skip'){rows=rows.filter(r=>key(r.original)!==key(entry.original));discarded.add(key(entry.original));used++;continue;}
      if(!row) {
        if(rows.length>=500) {kept++;continue;}
        row={};rows.push(row);
      }
      Object.assign(row,{id:entry.id,extraction_id:entry.extraction_id,original:entry.original,count:entry.count,context:entry.context,corrected:entry.word,handled:false,current:false,note:entry.reason,revision:entry.snapshot_revision,edited:false});
      used++;
    }
    sourceHash='';q('#essay-words-source-note').textContent='This review list includes suggestions from saved prompts. Check them before adding words; your draft is unchanged.';
    remember();reply=null;replyText='';q('#essay-words-reply-preview').textContent='';
    message(`${used} suggestions loaded${kept?` · ${kept} newer edits or extra rows kept`:''}. Review the spellings; nothing has been added yet.`);render();
  }
  q('#essay-words-open').addEventListener('click',()=>{open().catch(error=>toast(error.message,true));});
  q('#essay-words-extract').addEventListener('click',()=>run(extract));
  q('#essay-words-add').addEventListener('click',()=>run(()=>add(ready())));
  q('#essay-words-export').addEventListener('click',()=>run(exportPrompts));
  q('#essay-words-preview').addEventListener('click',()=>run(previewReply));
  q('#essay-words-use').addEventListener('click',useSuggestions);
  q('#essay-words-reply').addEventListener('input',invalidateReply);
  q('#essay-intake-confirm').addEventListener('click',()=>guarded(confirmIntake,q('#essay-intake-confirm')));
  q('#essay-words-list').addEventListener('input',event=>{
    if(event.target.dataset.correction===undefined)return;
    const row=rows[Number(event.target.dataset.correction)];row.corrected=event.target.value;row.edited=true;row.revision++;remember();update();
  });
  q('#essay-words-list').addEventListener('keydown',event=>{
    if(event.key!=='Enter' || event.isComposing || event.target.dataset.correction===undefined || busy)return;
    event.preventDefault();const row=rows[Number(event.target.dataset.correction)];if(normalize(row.corrected) && !row.handled)add([row]);
  });
  q('#essay-words-list').addEventListener('click',event=>{
    if(busy)return;
    const addButton=event.target.closest('[data-add-row]');if(addButton){guarded(()=>add([rows[Number(addButton.dataset.addRow)]]));return;}
    const discard=event.target.closest('[data-discard-row]');if(discard){const index=Number(discard.dataset.discardRow);discarded.add(key(rows[index].original));rows.splice(index,1);remember();render();return;}
    const accept=event.target.closest('[data-accept-row]');if(accept)guarded(()=>TypewriterDictionary.open(rows[Number(accept.dataset.acceptRow)].original));
  });
  document.addEventListener('typewriter-dictionary-changed',()=>guarded(async()=>{const accepted=new Set((await api('/essay/dictionary')).words);rows=rows.filter(row=>!accepted.has(key(row.original)));remember();render();if(q('#essay-words-dialog').open)await run(extract);}));
  q('#essay-words-file').addEventListener('change',()=>run(async()=>{
    const file=q('#essay-words-file').files[0];if(!file) return;
    if(file.size>2*1024*1024) throw new Error('Choose a reply smaller than 2 MB.');
    q('#essay-words-reply').value=await file.text();invalidateReply();await previewReply();
  }));
  q('#essay-words-copy').addEventListener('click',()=>run(async()=>{
    const text=selected().map(r=>r.original).join('\n');if(!text) throw new Error('There are no remaining flags to download.');
    download(new Blob([text+'\n'],{type:'text/plain;charset=utf-8'}),'typewriter-essay-flags.txt');message('Remaining original flags downloaded. Check them before adding practice words.');
  }));
})();
