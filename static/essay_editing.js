/* Plain-text list continuation and indentation; no HTML is inserted into drafts. */
(function(root){
  'use strict';
  function edit(value,start,end,key,shift=false){
    const lineStart=start===0?0:value.lastIndexOf('\n',start-1)+1;
    const lineEnd=value.indexOf('\n',start);const stop=lineEnd<0?value.length:lineEnd;
    const line=value.slice(lineStart,stop),prefix=line.match(/^(\s*)(?:(\d+)([.)])|([-+*]))[ \t]+/);
    if(key==='Enter'){
      if(!prefix || start<lineStart+prefix[0].length)return null;
      if(!line.slice(prefix[0].length).trim() && start===end){
        return {value:value.slice(0,lineStart)+value.slice(stop),start:lineStart,end:lineStart};
      }
      const marker=prefix[2] ? String(Number(prefix[2])+1).padStart(prefix[2].length,'0')+prefix[3] : prefix[4];
      const text='\n'+prefix[1]+marker+' ';
      return {value:value.slice(0,start)+text+value.slice(end),start:start+text.length,end:start+text.length};
    }
    if(key!=='Tab')return null;
    if(!shift && start===end && !prefix){return {value:value.slice(0,start)+'    '+value.slice(end),start:start+4,end:start+4};}
    const last=value.lastIndexOf('\n',end-1)+1;
    const blockEnd=end>start && end===last ? end-1 : (value.indexOf('\n',end)<0?value.length:value.indexOf('\n',end));
    const block=value.slice(lineStart,blockEnd);let delta=0,firstDelta=0;
    const replacement=block.split('\n').map((text,index)=>{
      const removed=shift?(text.match(/^(?:\t| {1,4})/)?.[0].length || 0):0;
      const change=shift?-removed:4;delta+=change;if(index===0)firstDelta=change;
      return shift?text.slice(removed):'    '+text;
    }).join('\n');
    return {value:value.slice(0,lineStart)+replacement+value.slice(blockEnd),start:Math.max(lineStart,start+firstDelta),end:Math.max(lineStart,end+delta)};
  }
  if(typeof module!=='undefined' && module.exports)module.exports={edit};else root.TypewriterEssayEditing={edit};
})(globalThis);
