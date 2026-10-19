/* Optional, bounded edit summaries. No keys, draft strings, or event timelines retained. */
(function(root){
  'use strict';
  const IDLE=2000,MAX_EVENTS=10000,DAY=86400000;
  const ms=value=>Math.min(DAY,Math.max(0,Math.round(value)));
  class Measurement{
    constructor({now=()=>performance.now(),audio=false,deferPresentation=false}={}){
      this.now=now;this.audio=audio;this.started=now();this.ready=audio || deferPresentation?null:this.started;this.presented=!deferPresentation;
      this.first=null;this.last=null;this.lastComparable=null;this.closed=false;
      this.blocks=new Set();this.blockedSince=null;this.excluded=0;this.flags=new Set(audio?[]:['reading_prompt']);
      this.events=0;this.revisions=0;this.deleted=0;this.inserted=0;this.active=0;this.idle=0;
      this.bins=[0,0,0,0,0];this.maxPause=null;this.focusLosses=0;this.hiddenCount=0;this.audioPlays=0;this.audioDuration=null;
    }
    present(){if(this.closed)return;this.presented=true;if(!this.audio && !this.audioPlays)this.ready=this.now();}
    flag(name){if(!this.closed)this.flags.add(name);}
    block(reason,on){
      if(this.closed)return;const at=this.now();
      if(on && !this.blocks.has(reason)){
        if(!this.blocks.size)this.blockedSince=at;
        this.blocks.add(reason);this.lastComparable=null;
        if(reason==='focus' || reason==='window'){this.focusLosses++;this.flag('focus_loss');}
        if(reason==='hidden'){this.hiddenCount++;this.flag('hidden');}
        if(this.first===null && reason!=='audio')this.initialInterrupted=true;
      }else if(!on && this.blocks.delete(reason) && !this.blocks.size){this.excluded+=at-this.blockedSince;this.blockedSince=null;}
    }
    audioStart(){
      if(this.closed)return;if(this.audioPlays++)this.flag('audio_replayed');
      this.block('audio',true);
      if(this.first!==null)this.flag('audio_overlap');
      this.ready=null;
    }
    audioEnd(duration=null){
      if(this.closed)return;this.block('audio',false);this.ready=this.now();
      if(Number.isFinite(duration) && duration>=0)this.audioDuration=ms(duration);
    }
    audioCancel(){if(this.blocks.has('audio')){this.flag('audio_incomplete');this.block('audio',false);}}
    edit({type='',before=0,after=0,selected=0,meaningful=false,trusted=true}={}){
      if(this.closed)return;
      if(!trusted)this.flag('untrusted_input');
      if(type==='insertFromPaste')this.flag('paste');
      if(type==='insertFromDrop')this.flag('drop');
      if(type.includes('Composition'))this.flag('composition');
      if(type==='insertReplacementText')this.flag('replacement');
      if(type.startsWith('history'))this.flag('history_edit');
      if(!type)this.flag('unclassified_input');
      if(this.first===null && !meaningful)return;
      const at=this.now();
      if(this.first===null){
        this.first=at;
        if(!this.presented)this.flag('presentation_pending');
        this.latency=this.ready===null || this.initialInterrupted || this.blocks.size?null:ms(at-this.ready);
        this.basis=this.latency===null?'unavailable':this.audioPlays?'audio-ended':'prompt-visible';
        if(this.audio && this.ready===null)this.flag('audio_incomplete');
      }
      if(this.blocks.has('audio'))this.flag('audio_overlap');
      if(this.lastComparable!==null && !this.blocks.size){
        const gap=Math.max(0,at-this.lastComparable);this.maxPause=Math.max(this.maxPause??0,gap);
        this.bins[gap<250?0:gap<500?1:gap<1000?2:gap<IDLE?3:4]++;
        if(gap>=IDLE){this.idle+=gap;this.flag('long_idle');}else this.active+=gap;
      }
      this.last=at;this.lastComparable=this.blocks.size?null:at;this.events++;
      // Selection and length are transient; neither the before nor after text is kept.
      const removed=type.startsWith('delete') || type.startsWith('history')?Math.max(0,before-after):Math.min(before,selected);
      const added=type.startsWith('delete')?0:Math.max(0,after-before+removed);
      if(removed || type.startsWith('delete') || type.startsWith('history') || type==='insertReplacementText')this.revisions++;
      this.deleted+=removed;this.inserted+=added;
      if(added>1 && type==='insertText')this.flag('bulk_input');
      if(this.events>MAX_EVENTS || this.deleted>20000 || this.inserted>20000)this.discard();
    }
    discard(){this.closed=true;this.result=null;}
    finish(){
      if(this.closed)return this.result??null;
      const at=this.now();this.closed=true;
      if(this.first===null || at-this.started>DAY)return this.result=null;
      this.result={version:1,initial_latency_ms:this.latency,latency_basis:this.basis,
        typing_span_ms:ms(this.last-this.first),active_typing_ms:ms(this.active),idle_gap_ms:ms(this.idle),
        excluded_ms:ms(this.excluded+(this.blocks.size?at-this.blockedSince:0)),input_events:this.events,
        revision_events:this.revisions,deleted_units:this.deleted,inserted_units:this.inserted,
        pause_bins:this.bins,max_pause_ms:this.maxPause===null?null:ms(this.maxPause),focus_loss_count:this.focusLosses,hidden_count:this.hiddenCount,
        audio_plays:this.audioPlays,audio_duration_ms:this.audioDuration,flags:[...this.flags].sort()};
      return this.result;
    }
  }
  if(typeof module!=='undefined' && module.exports){module.exports={Measurement};return;}
  let measurement=null,remove=()=>{},before=null;
  function discard(){measurement?.discard();measurement=null;before=null;remove();remove=()=>{};}
  function begin(options){
    discard();const field=document.querySelector('#answer');if(field.value)return;
    measurement=new Measurement({...options,deferPresentation:true});const current=measurement;requestAnimationFrame(()=>{if(measurement===current)current.present();});let focused=document.activeElement===field;
    const subscriptions=[];
    const on=(target,type,handler)=>{target.addEventListener(type,handler);subscriptions.push(()=>target.removeEventListener(type,handler));};
    on(field,'beforeinput',event=>{before={before:field.value.length,selected:field.selectionEnd-field.selectionStart,type:event.inputType || ''};});
    on(field,'input',event=>{if(!measurement)return;if(!before)measurement.flag('unclassified_input');measurement.edit({...before,after:field.value.length,meaningful:!!field.value.trim(),type:event.inputType || before?.type || '',trusted:event.isTrusted});before=null;});
    on(field,'paste',()=>measurement?.flag('paste'));on(field,'drop',()=>measurement?.flag('drop'));
    on(field,'compositionstart',()=>measurement?.flag('composition'));
    on(field,'compositionend',()=>measurement?.flag('composition'));
    on(field,'focus',()=>{focused=true;measurement?.block('focus',false);});
    on(field,'blur',()=>{if(focused)measurement?.block('focus',true);});
    on(document,'visibilitychange',()=>measurement?.block('hidden',document.hidden));
    on(window,'blur',()=>measurement?.block('window',true));on(window,'focus',()=>measurement?.block('window',false));
    if(document.hidden)measurement.block('hidden',true);
    if(!document.hasFocus()){measurement.flag('focus_loss');measurement.block('window',true);}
    remove=()=>subscriptions.forEach(unsubscribe=>unsubscribe());
  }
  root.TypewriterTyping={begin,discard,
    finish(){const result=measurement?.finish()??null;discard();return result;},
    audioStart:()=>measurement?.audioStart(),audioEnd:duration=>measurement?.audioEnd(duration),audioCancel:()=>measurement?.audioCancel()};
})(globalThis);
