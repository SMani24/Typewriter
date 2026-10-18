/* Report only script locations. Never send error messages, stacks, or typed text. */
(function(){
  let sent=0;
  function report(kind,event={}){
    if(sent++>=10)return;
    let source='';try{const url=new URL(event.filename || '',location.href);if(url.origin===location.origin)source=url.pathname.match(/\/static\/([a-z_]+\.js)$/)?.[1] || '';}catch{}
    const token=document.querySelector('meta[name="typewriter-token"]')?.content;if(!token)return;
    fetch('/api/diagnostics',{method:'POST',headers:{'Content-Type':'application/json','X-Typewriter-Token':token},body:JSON.stringify({kind,source,line:event.lineno || 0,column:event.colno || 0})}).catch(()=>{});
  }
  window.addEventListener('error',event=>{if(event instanceof ErrorEvent)report('error',event);});
  window.addEventListener('unhandledrejection',()=>report('unhandledrejection'));
  window.TypewriterDiagnostics={report};
})();
