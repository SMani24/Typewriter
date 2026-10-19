/* Plain-text list continuation and indentation; no HTML is inserted into drafts. */
(function(root){
  'use strict';
  const prefixOf=line=>line.match(/^([ \t]*)(?:(\d+|[a-zA-Z])([.)])|([-+*]))(?:[ \t]+|$)/);
  const width=indent=>indent.replaceAll('\t','    ').length;
  function nextMarker(prefix){
    if(prefix[4])return prefix[4];
    const item=prefix[2];
    return (/^\d+$/.test(item)?String(Number(item)+1).padStart(item.length,'0'):String.fromCharCode(item.charCodeAt(0)+1).replace('{','a').replace('[','A'))+prefix[3];
  }
  function parentBefore(value,lineStart,indent){
    const lines=value.slice(0,Math.max(0,lineStart-1)).split('\n');
    for(let i=lines.length-1;i>=0;i--){
      if(!lines[i].trim())continue;
      const prefix=prefixOf(lines[i]);
      if(width(lines[i].match(/^[ \t]*/)[0])<=indent)return prefix;
    }
    return null;
  }
  function edit(value,start,end,key,shift=false){
    const lineStart=start===0?0:value.lastIndexOf('\n',start-1)+1;
    const lineEnd=value.indexOf('\n',start);const stop=lineEnd<0?value.length:lineEnd;
    const line=value.slice(lineStart,stop),prefix=prefixOf(line);
    const replaceLine=text=>({value:value.slice(0,lineStart)+text+value.slice(stop),start:lineStart+text.length,end:lineStart+text.length});
    if(key==='Enter'){
      if(!prefix || start<lineStart+prefix[0].length)return null;
      if(!shift && !line.slice(prefix[0].length).trim() && start===end)return replaceLine('');
      const text='\n'+prefix[1]+(shift?'':nextMarker(prefix)+' ');
      return {value:value.slice(0,start)+text+value.slice(end),start:start+text.length,end:start+text.length};
    }
    if(key!=='Tab')return null;
    if(start===end){
      const indent=width(line.match(/^[ \t]*/)[0]);
      if(!shift && (!line.trim() || prefix && !line.slice(prefix[0].length).trim())){
        const parent=prefix || parentBefore(value,lineStart,indent);
        if(parent){
          const marker=parent[4]?'1.':/^\d+$/.test(parent[2])?'a.':'-';
          return replaceLine(parent[1]+'    '+marker+' ');
        }
      }
      if(shift && prefix && indent){
        const parent=parentBefore(value,lineStart,Math.max(0,indent-4));
        if(parent)return replaceLine(parent[1]+nextMarker(parent)+' '+line.slice(prefix[0].length));
      }
      if(!shift && !prefix)return {value:value.slice(0,start)+'    '+value.slice(end),start:start+4,end:start+4};
    }
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
