const socket=io(); let revision=-1, lastUpdate=0;
const el=(tag,text,cls)=>{const node=document.createElement(tag);node.textContent=text; if(cls)node.className=cls;return node;};
// textContent prevents user names from being treated as HTML.
function render(state) {
  if(state.revision<revision)return; revision=state.revision; lastUpdate=Date.now();
  document.querySelector('#connection').textContent='Live';
  document.querySelector('#pause').textContent=state.paused?'Queue paused — current games may continue.':'';
  const courts=document.querySelector('#courts');courts.replaceChildren();
  for(const court of state.courts) {
    const card=el('article','', 'card');card.append(el('h2',court.name),el('div',`${court.type} · ${court.status}${court.paused?' · Paused':''}`,'muted'));
    card.append(el('p',court.match?.status==='called'?'Called — report to court':'Currently on court','label'));
    card.append(el('div',court.match?.players.join(' · ') || 'Court available','players'));
    const next=state.deck.find(d=>d.courtId===court.id);
    card.append(el('p','On the deck','label'),el('div',next?.players.length?next.players.join(' · '):'Waiting for a compatible group','players'));
    if(next?.players.length)card.append(el('div',next.estimatedMinutes==null?'Wait varies':`About ${next.estimatedMinutes} min`,'muted'));
    courts.append(card);
  }
  const queue=document.querySelector('#queue');queue.replaceChildren();
  state.queue.forEach((entry,i)=>queue.append(el('div',`${i+1}. ${entry.players.join(' + ')} · ${entry.types.join(', ')}`,'queue-row')));
  if(!state.queue.length)queue.append(el('p','No parties waiting.'));
}
socket.on('state:snapshot',render);socket.on('queue:updated',render);
socket.on('disconnect',()=>document.querySelector('#connection').textContent='Offline — showing last known state');
// Always fetch a complete snapshot after reconnect; Socket.IO events are not a database.
socket.on('connect',()=>fetch('/api/state').then(r=>r.json()).then(render).catch(()=>{}));
setInterval(()=>{ document.querySelector('#clock').textContent=new Date().toLocaleTimeString();
 if(Date.now()-lastUpdate>25000)document.querySelector('#connection').textContent='Stale — awaiting sync'; },1000);
