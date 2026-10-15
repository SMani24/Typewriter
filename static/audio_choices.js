/* Compare all offered recordings; only an explicit, previewed choice changes a word. */
window.TypewriterAudio = (() => {
  const providers=['cambridge','oxford','wiktionary','free_dictionary'];
  const labels=['Cambridge','Oxford','Wiktionary','Free Dictionary API'];
  const accents={uk:'British English',us:'American English',au:'Australian English',other:'Other accent',unknown:'Accent not labelled'};
  const $=id=>document.getElementById(id);
  let options,epoch=0,wordId,controller,records=[],heard=new Set(),selected=null,playing=null,mediaVersion=0,saving=false,loading=false;
  const dialog=()=>$('alternative-audio-dialog'),audio=()=>$('alternative-audio-preview');
  function message(text){$('alternative-audio-status').textContent=text;}
  function controls(){
    $('close-alternative-audio').disabled=saving;
    $('approve-alternative-audio').disabled=saving || !selected || !heard.has(selected) || !$('alternative-audio-checked').checked;
    $('retry-alternative-audio').disabled=loading || saving;
    dialog().querySelectorAll('[data-play-voice],input[name="alternative-voice"]').forEach(node=>node.disabled=saving);
  }
  function playLabel(id,text){const button=dialog().querySelector(`[data-play-voice="${id}"]`);if(button)button.querySelector('.voice-play-label').textContent=text;}
  function stop(){mediaVersion++;audio().pause();audio().removeAttribute('src');audio().load();if(playing)playLabel(playing,heard.has(playing)?'Replay':'Play');playing=null;}
  function select(id){
    if(selected!==id){selected=id;$('alternative-audio-checked').checked=false;}
    dialog().querySelectorAll('input[name="alternative-voice"]').forEach(input=>input.checked=input.value===selected);
    controls();
  }
  function card(record){
    const row=document.createElement('section');row.className='voice-option';row.dataset.voiceId=record.id;
    const heading=document.createElement('strong');heading.textContent=record.label;
    const accent=document.createElement('span');accent.className='voice-accent';accent.textContent=accents[record.accent];
    const title=document.createElement('div');title.className='voice-source';title.append(heading,accent);
    const credit=document.createElement('p');credit.className='field-note';credit.append(document.createTextNode((record.author || record.label)+' · '));
    for(const [text,url] of [[record.license_name,record.license_url || record.source_url],['Source page',record.source_url]]){
      const link=document.createElement('a');link.textContent=text;link.href=url;link.target='_blank';link.rel='noopener noreferrer';credit.append(link,document.createTextNode(' · '));
    }
    const play=document.createElement('button');play.type='button';play.className='voice-play';play.dataset.playVoice=record.id;
    play.setAttribute('aria-label',`Play ${record.label}, ${accents[record.accent]}, ${record.author || 'recording'}`);
    play.innerHTML='<span aria-hidden="true">▶</span><span class="voice-play-label">Play</span>';
    play.onclick=()=>preview(record);
    const choice=document.createElement('label');choice.className='checkbox-label';
    const radio=document.createElement('input');radio.type='radio';radio.name='alternative-voice';radio.value=record.id;radio.onchange=()=>select(record.id);
    choice.append(radio,document.createTextNode('Use this voice'));
    const actions=document.createElement('div');actions.className='voice-option-actions';actions.append(play,choice);
    row.append(title,credit,actions);$('alternative-audio-list').append(row);
  }
  async function discover(reset=false){
    const turn=epoch;loading=true;controls();let unavailable=0;
    try{
      for(let index=0;index<providers.length;index++){
        message(`${records.length} voices found · Checking ${labels[index]}… You can listen while the search continues.`);
        const result=await options.api(`/words/${wordId}/pronunciation/alternatives`,'POST',{provider:providers[index],reset:reset && index===0},controller.signal);
        if(turn!==epoch)return;
        if(result.unavailable)unavailable++;
        for(const record of result.candidates){if(records.some(r=>r.id===record.id))continue;records.push(record);card(record);}
        $('alternative-audio-candidate').hidden=!records.length;
      }
      if(turn===epoch)message(records.length?`${records.length} voices available. Listen to any recording, then choose the one you prefer.${unavailable?' Some sources are unavailable right now.':''}`:'No voices were found from the available sources. You can try again later or upload a recording in the word editor.');
    }catch(error){if(turn===epoch && error.name!=='AbortError')message(error.message);}
    finally{if(turn===epoch){loading=false;controls();}}
  }
  async function preview(record){
    if(saving)return;
    if(playing===record.id && !audio().paused){stop();return;}
    stop();select(record.id);playing=record.id;const turn=epoch,version=mediaVersion;
    audio().volume=options.volume()/100;
    audio().src=`/api/words/${wordId}/pronunciation/alternatives/${record.id}/audio`;
    audio().load();playLabel(record.id,'Loading…');$('alternative-audio-playback').textContent='Loading recording…';
    let timer;
    try{
      await Promise.race([audio().play(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('The recording timed out. Try another voice or check your proxy in Settings.')),20000);})]);
      if(turn!==epoch || version!==mediaVersion)return;
      heard.add(record.id);playLabel(record.id,'Playing…');$('alternative-audio-playback').textContent='Listening. Choose this voice if it says the exact word correctly.';controls();
    }catch(error){
      if(turn!==epoch || version!==mediaVersion || error.name==='AbortError')return;
      stop();$('alternative-audio-playback').textContent=error.name==='NotAllowedError'?'Your browser blocked sound. Press Play again to allow playback.':error.message.includes('timed out')?error.message:'This recording could not be played. Try another voice or check your proxy in Settings.';
    }finally{clearTimeout(timer);}
  }
  async function open(id){
    const word=options.word(id);if(!word)return;
    if(word.audio_file){options.notify('Remove your uploaded recording in the word editor before choosing another source.');return;}
    if(dialog().open)return;
    epoch++;controller=new AbortController();wordId=id;records=[];heard=new Set();selected=null;saving=false;
    $('alternative-audio-list').replaceChildren();$('alternative-audio-candidate').hidden=true;$('alternative-audio-checked').checked=false;$('alternative-audio-playback').textContent='';
    $('alternative-audio-word').textContent=word.word;dialog().showModal();await discover();
  }
  function configure(config){
    options=config;
    $('close-alternative-audio').onclick=()=>dialog().close();
    dialog().addEventListener('close',()=>{epoch++;controller?.abort();stop();selected=null;saving=false;});
    dialog().addEventListener('cancel',event=>{if(saving)event.preventDefault();});
    audio().addEventListener('ended',()=>{if(playing)playLabel(playing,'Replay');});
    dialog().addEventListener('keydown',event=>{if(event.altKey && event.code==='KeyP' && selected){event.preventDefault();if(!event.repeat)preview(records.find(r=>r.id===selected));}});
    $('alternative-audio-checked').onchange=controls;
    $('approve-alternative-audio').onclick=async()=>{
      if(saving || !selected || !heard.has(selected) || !$('alternative-audio-checked').checked)return;
      const turn=epoch;saving=true;stop();controls();message('Saving your choice…');
      try{
        const word=await options.api(`/words/${wordId}/pronunciation/alternatives/${selected}/accept`,'POST',{},controller.signal);
        if(turn!==epoch)return;dialog().close();await options.accepted(word);
      }catch(error){if(turn===epoch && error.name!=='AbortError')message(error.message);}
      finally{if(turn===epoch){saving=false;controls();}}
    };
    $('retry-alternative-audio').onclick=()=>{if(loading || saving)return;stop();records=[];selected=null;heard.clear();$('alternative-audio-list').replaceChildren();$('alternative-audio-candidate').hidden=true;$('alternative-audio-checked').checked=false;discover(true);};
  }
  return {configure,open};
})();
