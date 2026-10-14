/* Advisory flags become a checked word list; essay text is never rewritten. */
(function () {
  'use strict';
  const q=selector=>document.querySelector(selector);
  let rows=[],busy=false,sourceHash='',storageKey=null,loaded=false;
  let reply=null,replyText='',replyVersion=0;
  const key=word=>word.toLowerCase().replaceAll('’',"'");
  const normalize=word=>{
    const value=word.normalize('NFKC').trim().toLowerCase().replace(/\s+/g,' ');
    return value.length<=80 && /^[a-z]+(?:[ '\-][a-z]+)*$/.test(value) ? value : null;
  };
  const existing=()=>new Set((state?.words || []).map(w=>w.word));
  const selected=()=>rows.filter(row=>row.selected);
  const ready=()=>rows.filter(row=>row.selected && normalize(row.corrected) && !existing().has(normalize(row.corrected)));
  function message(text,error=false) {q('#essay-words-status').textContent=text;q('#essay-words-status').classList.toggle('error',error);}
  function remember() {try {if(storageKey) sessionStorage.setItem(storageKey,JSON.stringify({rows,sourceHash}));}catch { /* The open list stays available. */ }}
  async function digest(text) {return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(v=>v.toString(16).padStart(2,'0')).join('');}
  async function restore() {
    if(loaded) return;
    const health=await api('/health');storageKey='typewriter-essay-words-'+health.instance;loaded=true;
    try {
      const saved=JSON.parse(sessionStorage.getItem(storageKey));
      if(saved && Array.isArray(saved.rows) && saved.rows.length<=500 && saved.rows.every(r=>typeof r.original==='string' && typeof r.corrected==='string' && r.corrected.length<=80 && /^[a-f0-9]{32}$/.test(r.extraction_id) && Number.isInteger(r.id) && Number.isInteger(r.revision) && r.revision>=0 && typeof r.selected==='boolean')) {
        rows=saved.rows;sourceHash=typeof saved.sourceHash==='string'?saved.sourceHash:'';
      }
    }catch { /* A malformed browser recovery record is ignored. */ }
  }
  function rowStatus(row) {
    if(row.corrected && !normalize(row.corrected)) return 'Use an English word or short phrase, up to 80 characters.';
    if(normalize(row.corrected) && existing().has(normalize(row.corrected))) return row.added ? 'Added to your notebook.' : 'Already in your notebook · kept once.';
    if(!row.corrected) return row.note || 'Enter the intended spelling, or uncheck a false flag.';
    const duplicate=rows.some(other=>other!==row && other.selected && normalize(other.corrected)===normalize(row.corrected));
    return duplicate ? 'Same spelling as another row · it will be added once.' : 'Ready for your check.';
  }
  function update() {
    const count=new Set(ready().map(r=>normalize(r.corrected))).size;
    q('#essay-words-count').textContent=`${rows.length} unique flags · ${selected().length} selected · ${count} new ${count===1?'word':'words'} ready`;
    q('#essay-words-add').textContent=`Add ${count} ready ${count===1?'word':'words'}`;
    q('#essay-words-add').disabled=busy || !count;
    q('#essay-words-export').disabled=busy || !selected().length;
    q('#essay-words-use').disabled=busy || !reply || replyText!==q('#essay-words-reply').value;
    q('#essay-words-preview').disabled=busy || !q('#essay-words-reply').value.trim();
    ['#essay-words-extract','#essay-words-all','#essay-words-none','#essay-words-size','#essay-words-context','#essay-words-file'].forEach(id=>q(id).disabled=busy);
    q('#essay-words-list').querySelectorAll('[data-row]').forEach(element=>{
      const row=rows[Number(element.dataset.row)];
      element.querySelector('input[type="checkbox"]').disabled=busy;
      element.querySelector('input[type="text"]').disabled=busy;
      element.querySelector('.essay-word-status').textContent=rowStatus(row);
      element.querySelector('button').disabled=busy || !normalize(row.corrected) || existing().has(normalize(row.corrected));
    });
  }
  function render() {
    q('#essay-words-list').innerHTML=rows.length ? rows.map((row,i)=>`<div class="essay-word-row" data-row="${i}"><input type="checkbox" data-choice="${i}" aria-label="Select flag ${escapeHtml(row.original)}" ${row.selected?'checked':''}><div class="essay-word-source"><strong>${escapeHtml(row.original)}</strong><span>${row.count} ${row.count===1?'occurrence':'occurrences'}</span></div><div class="essay-word-correction"><label class="sr-only" for="essay-correction-${i}">Correct spelling for ${escapeHtml(row.original)}</label><input id="essay-correction-${i}" data-correction="${i}" type="text" maxlength="80" autocomplete="off" spellcheck="false" autocorrect="off" placeholder="Intended spelling…" value="${escapeHtml(row.corrected)}"><span class="essay-word-status field-note"></span>${row.note?`<small class="essay-word-reason">${escapeHtml(row.note)}</small>`:''}</div><button class="text-button" data-add-row="${i}">Add word</button></div>`).join('') : '<p class="muted">No flags in this list. Extract the current draft, or import a reply from an earlier prompt.</p>';
    update();
  }
  async function run(action) {
    if(busy) return;
    busy=true;update();
    try {await action();}catch(error){message(error.message || 'Please try again.',true);}
    finally {busy=false;render();}
  }
  async function extract() {
    const text=q('#essay-body').value;
    const result=await api('/essay/words','POST',{text});
    rows=result.words.map(row=>({...row,corrected:'',selected:!row.already_exists,revision:0,note:''}));
    sourceHash=await digest(text);remember();
    q('#essay-words-source-note').textContent='List from your current draft. False flags can be unchecked. Your writing stays unchanged.';
    message(result.limited?'Showing the first 500 unique flags. Repeated occurrences are grouped.':rows.length?'Check the intended spellings one by one, or export the selected flags for LLM review.':'No spelling flags found. You can still import a reply from an earlier prompt.');
  }
  async function open() {
    await restore();
    q('#essay-words-size').value=state.settings.offline_batch_size || 20;
    q('#essay-words-dialog').showModal();render();
    if(!rows.length) await run(extract);
    else {
      const current=await digest(q('#essay-body').value);
      q('#essay-words-source-note').textContent=sourceHash===current?'Your saved review list. Your writing stays unchanged.':'This list is from an earlier draft or prompt. Finish reviewing it, or replace it with flags from the current draft.';
    }
  }
  async function add(items) {
    const words=[...new Set(items.map(row=>normalize(row.corrected)).filter(Boolean))];
    if(!words.length) throw new Error('Enter at least one intended spelling first.');
    const result=await api('/words','POST',{words:words.map(word=>({word,tag:'Essay spelling'}))});
    // Only the deliberate Add action writes notebook words; no LLM result can do so.
    for(const row of rows) if(words.includes(normalize(row.corrected))) {row.selected=false;row.added=true;row.revision++;}
    remember();await refresh();
    message(`${result.added.length} new ${result.added.length===1?'word':'words'} added${result.duplicates.length?` · ${result.duplicates.length} already in the notebook`:''}. Missing meanings and examples use your usual preparation settings.`);
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
    if(!reply || replyText!==q('#essay-words-reply').value) return;
    let kept=0,used=0;
    for(const entry of reply.words) {
      let row=rows.find(r=>key(r.original)===key(entry.original));
      if(row && (row.extraction_id===entry.extraction_id ? row.revision!==entry.snapshot_revision : row.edited)) {kept++;continue;}
      if(!row) {
        if(rows.length>=500) {kept++;continue;}
        row={};rows.push(row);
      }
      Object.assign(row,{id:entry.id,extraction_id:entry.extraction_id,original:entry.original,count:entry.count,context:entry.context,corrected:entry.word,selected:entry.action==='add' && !entry.already_exists,note:entry.reason,revision:entry.snapshot_revision,edited:false});
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
  for(const [id,value] of [['#essay-words-all',true],['#essay-words-none',false]]) q(id).addEventListener('click',()=>{rows.forEach(r=>{r.selected=value;r.revision++;});remember();render();});
  q('#essay-words-list').addEventListener('input',event=>{
    if(event.target.dataset.correction===undefined) return;
    const row=rows[Number(event.target.dataset.correction)];row.corrected=event.target.value;row.selected=true;row.edited=true;row.added=false;row.revision++;
    event.target.closest('[data-row]').querySelector('input[type="checkbox"]').checked=true;remember();update();
  });
  q('#essay-words-list').addEventListener('change',event=>{
    if(event.target.dataset.choice===undefined) return;
    const row=rows[Number(event.target.dataset.choice)];row.selected=event.target.checked;row.revision++;remember();update();
  });
  q('#essay-words-list').addEventListener('keydown',async event=>{
    if(event.key!=='Enter' || event.isComposing || event.target.dataset.correction===undefined || busy) return;
    event.preventDefault();
    const index=Number(event.target.dataset.correction),row=rows[index];
    if(!normalize(row.corrected) || existing().has(normalize(row.corrected))) return;
    await run(()=>add([row]));
    if(existing().has(normalize(row.corrected))) q(`#essay-correction-${index+1}`)?.focus();
  });
  q('#essay-words-list').addEventListener('click',event=>{
    const button=event.target.closest('[data-add-row]');if(button) run(()=>add([rows[Number(button.dataset.addRow)]]));
  });
  q('#essay-words-file').addEventListener('change',()=>run(async()=>{
    const file=q('#essay-words-file').files[0];if(!file) return;
    if(file.size>2*1024*1024) throw new Error('Choose a reply smaller than 2 MB.');
    q('#essay-words-reply').value=await file.text();invalidateReply();await previewReply();
  }));
  q('#essay-words-copy').addEventListener('click',()=>run(async()=>{
    const text=selected().map(r=>r.original).join('\n');if(!text) throw new Error('Select flags to download first.');
    download(new Blob([text+'\n'],{type:'text/plain;charset=utf-8'}),'typewriter-essay-flags.txt');message('Selected original flags downloaded. Check them before adding practice words.');
  }));
})();
