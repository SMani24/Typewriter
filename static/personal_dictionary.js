/* A local spelling allowlist, deliberately separate from practice vocabulary. */
(function(){
  const q=s=>document.querySelector(s);let words=[];
  function render(){
    const filter=q('#personal-word-filter').value.trim().toLocaleLowerCase();
    const matches=words.filter(w=>w.includes(filter));
    q('#personal-word-count').textContent=`${words.length} saved words${matches.length>200?' · showing the first 200 matches':''}`;
    q('#personal-word-list').replaceChildren();
    for(const word of matches.slice(0,200)){
      const item=document.createElement('div');item.className='personal-word';
      const label=document.createElement('span');label.textContent=word;
      const remove=document.createElement('button');remove.type='button';remove.className='icon-button';remove.textContent='×';remove.setAttribute('aria-label',`Remove ${word} from personal dictionary`);
      remove.onclick=()=>guarded(async()=>{const result=await api('/essay/dictionary','DELETE',{word});words=result.words;render();changed(word);},remove);
      item.append(label,remove);q('#personal-word-list').append(item);
    }
  }
  function changed(word){window.TypewriterEssay?.recheck();document.dispatchEvent(new CustomEvent('typewriter-dictionary-changed',{detail:word}));}
  async function open(word=''){
    q('#personal-word').value=word;q('#personal-word-filter').value='';
    words=(await api('/essay/dictionary')).words;render();q('#personal-dictionary-dialog').showModal();q('#personal-word').focus();
  }
  function cursorWord(){
    const area=q('#essay-body'),start=area.selectionStart,end=area.selectionEnd;
    if(start!==end)return area.value.slice(start,end).trim();
    return [...area.value.matchAll(/\p{L}+(?:['’]\p{L}+)*/gu)].find(m=>m.index<=start && m.index+m[0].length>=start)?.[0] || '';
  }
  q('#essay-body').addEventListener('keydown',event=>{
    if((event.ctrlKey || event.metaKey) && event.code==='Period' && !event.isComposing){event.preventDefault();guarded(()=>open(cursorWord()));}
  });
  q('#essay-personal-word').onclick=()=>guarded(()=>open(cursorWord()));
  q('#manage-personal-dictionary').onclick=()=>guarded(()=>open());
  q('#personal-word-filter').oninput=render;
  q('#personal-word-form').onsubmit=event=>{event.preventDefault();guarded(async()=>{
    const result=await api('/essay/dictionary','POST',{word:q('#personal-word').value});words=result.words;render();q('#personal-word').value='';changed(result.word);toast('Spelling accepted locally. Your essay and practice words are unchanged.');
  },q('#save-personal-word'));};
  window.TypewriterDictionary={open};
})();
