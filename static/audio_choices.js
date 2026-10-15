/* Preview, reject, or approve a voice without changing the word on discovery. */
window.TypewriterAudio = (() => {
  let options, session = 0, wordId, providerIndex, queue, current, heard, busy, controller, committing=false;
  const providers = ['cambridge','oxford','wiktionary','free_dictionary'];
  const labels = ['Cambridge','Oxford','Wiktionary','Free Dictionary API'];
  const $ = id => document.getElementById(id);
  const dialog = () => $('alternative-audio-dialog');
  const audio = () => $('alternative-audio-preview');
  const status = text => {$('alternative-audio-status').textContent = text;};
  function stop() {audio().pause();audio().removeAttribute('src');audio().load();}
  function controls() {
    $('close-alternative-audio').disabled=committing;
    $('approve-alternative-audio').disabled = busy || !current || !heard || !$('alternative-audio-checked').checked;
    $('next-alternative-audio').disabled = busy || !current;
    $('preview-alternative-audio').disabled = busy || !current;
  }
  function show(record) {
    current=record;heard=false;stop();$('alternative-audio-checked').checked=false;
    $('alternative-audio-candidate').hidden=!record;
    if(record) {
      $('alternative-audio-source').textContent=record.label;
      $('alternative-audio-accent').textContent={uk:'British English',us:'American English',au:'Australian English',other:'Other accent',unknown:'Accent not labelled'}[record.accent];
      $('alternative-audio-author').textContent=record.author || record.label;
      $('alternative-audio-license').textContent=record.license_name;
      $('alternative-audio-license').href=record.license_url || record.source_url;
      $('alternative-audio-reference').href=record.source_url;
      audio().volume=options.volume()/100;
      audio().src=`/api/words/${wordId}/pronunciation/alternatives/${record.id}/audio`;
      status('Listen first, then choose whether this voice says the exact word correctly.');
    }
    controls();
  }
  async function next(reset=false) {
    const turn=session;busy=true;show(null);$('retry-alternative-audio').hidden=true;
    try {
      while(!queue.length && providerIndex<providers.length) {
        const index=providerIndex++;
        status(`Looking for a voice · ${labels[index]}…`);
        const result=await options.api(`/words/${wordId}/pronunciation/alternatives`,'POST',{provider:providers[index],reset:reset && index===0},controller.signal);
        if(turn!==session)return;
        queue=result.candidates;
      }
      if(turn!==session)return;
      if(queue.length)show(queue.shift());
      else {
        status('No more voices are available from these sources right now. Some sources may be unavailable. You can upload your own recording in the word editor, or try again later. Rejected voices stay hidden until you choose to include them again.');
        $('retry-alternative-audio').hidden=false;
      }
    } catch(error) {if(turn===session && error.name!=='AbortError') {status(error.message);$('retry-alternative-audio').hidden=false;}}
    finally {if(turn===session){busy=false;controls();}}
  }
  async function open(id) {
    const word=options.word(id);if(!word)return;
    if(word.audio_file){options.notify('Remove your uploaded recording in the word editor before choosing another source.');return;}
    if(dialog().open)dialog().close();
    session++;controller=new AbortController();wordId=id;queue=[];providerIndex=0;busy=false;committing=false;
    $('alternative-audio-word').textContent=word.word;
    dialog().showModal();await next();
  }
  async function action(task) {
    if(busy)return;const turn=session;busy=true;controls();
    try {await task(turn);}
    catch(error) {if(turn===session && error.name!=='AbortError')status(error.message);}
    finally {if(turn===session){busy=false;committing=false;controls();}}
  }
  function configure(config) {
    options=config;
    $('close-alternative-audio').onclick=()=>dialog().close();
    dialog().addEventListener('close',()=>{session++;controller?.abort();stop();current=null;committing=false;});
    dialog().addEventListener('cancel',event=>{if(committing)event.preventDefault();});
    audio().addEventListener('playing',()=>{if(current && dialog().open){heard=true;controls();}});
    audio().addEventListener('error',()=>{if(current && dialog().open)status('This recording could not be played. Try the next voice, or check your proxy in Settings.');});
    $('alternative-audio-checked').onchange=controls;
    $('preview-alternative-audio').onclick=()=>action(async()=>{
      audio().currentTime=0;
      try {await audio().play();}catch {status('This recording could not be played. Try the next voice, or check your proxy in Settings.');}
    });
    $('next-alternative-audio').onclick=()=>action(async turn=>{
      stop();await options.api(`/words/${wordId}/pronunciation/alternatives/${current.id}/reject`,'POST',{},controller.signal);
      if(turn===session){busy=false;await next();}
    });
    $('approve-alternative-audio').onclick=()=>{
      if(!current || !heard || !$('alternative-audio-checked').checked)return;
      action(async turn=>{
        committing=true;controls();status('Saving your choice…');
        const word=await options.api(`/words/${wordId}/pronunciation/alternatives/${current.id}/accept`,'POST',{},controller.signal);
        if(turn!==session)return;
        dialog().close();await options.accepted(word);
      });
    };
    $('retry-alternative-audio').onclick=()=>{providerIndex=0;queue=[];next(true);};
  }
  return {configure,open};
})();
