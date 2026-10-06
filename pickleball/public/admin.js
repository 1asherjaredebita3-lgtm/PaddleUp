let state,revision=-1;
const node=(tag,text)=>{const n=document.createElement(tag);n.textContent=text;return n;};
async function api(path,body,method='POST'){
 try{const response=await fetch('/api/admin/'+path,{method,headers:{'Content-Type':'application/json',Authorization:'Bearer '+document.querySelector('#token').value},body:JSON.stringify(body)});
 const data=await response.json();if(!response.ok)throw Error(data.error);document.querySelector('#message').textContent='Saved';await refresh();}
 catch(e){document.querySelector('#message').textContent=e.message;}
}
const action=(text,run)=>{const b=node('button',text);b.onclick=run;return b;};
function select(options,value){const s=document.createElement('select');options.forEach(v=>{const o=node('option',v);o.value=v;s.append(o);});s.value=value;return s;}
function render(next){if(next.revision<revision)return;state=next;revision=next.revision;
 const courts=document.querySelector('#courts');courts.replaceChildren();
 state.courts.forEach(c=>{
  const card=node('section','');card.className='card';card.append(node('h2',c.name));
  const type=select(['Beginner','Advanced','Challenge','King of the Court'],c.type),status=select(['Active','Maintenance','Tournament'],c.status);
  card.append(type,status,action('Save court',()=>api('courts/'+c.id,{type:type.value,status:status.value},'PATCH')),
   action(c.paused?'Resume court':'Pause court',()=>api('courts/'+c.id,{paused:!c.paused},'PATCH')));
  if(c.match){card.append(node('p',c.match.players.join(' · ')));
   if(c.match.status==='called')c.match.entries.forEach((entryId,i)=>card.append(action(`Bump called party ${i+1}`,()=>api('queue/'+entryId+'/no-show',{}))));
   if(c.match.status==='called')card.append(action('Start game',()=>api('matches/'+c.match.id+'/start',{})));
   else {card.append(action('Finish — all off',()=>api('matches/'+c.match.id+'/finish',{winnerTeam:null})));
    if(['Challenge','King of the Court'].includes(c.type))c.match.teams.forEach((team,i)=>card.append(action(`Team ${i+1} wins (${team.join(', ')})`,()=>api('matches/'+c.match.id+'/finish',{winnerTeam:i}))));
   }
  }else card.append(action('Assign selected parties',()=>api('matches/assign',{courtId:c.id,entryIds:[...document.querySelectorAll('.party:checked')].map(x=>x.value)})));
  courts.append(card);
 });
 const queue=document.querySelector('#queue');queue.replaceChildren();
 state.queue.forEach((entry,i)=>{
  const row=node('div','');row.className='queue-row';const check=document.createElement('input');check.type='checkbox';check.className='party';check.value=entry.id;
  row.append(check,node('span',entry.players.join(' + ')),action('No-show',()=>api('queue/'+entry.id+'/no-show',{})));
  if(i>0)row.append(action('Move up',()=>{const ids=state.queue.map(e=>e.id);[ids[i-1],ids[i]]=[ids[i],ids[i-1]];api('queue/reorder',{entryIds:ids});}));
  queue.append(row);
 });
 // Called parties do not appear in the waiting list; expose their party IDs via selection below.
}
async function refresh(){const r=await fetch('/api/state');if(r.ok)render(await r.json());}
document.querySelector('#pause').onclick=()=>api('settings',{paused:true},'PATCH');
document.querySelector('#resume').onclick=()=>api('settings',{paused:false},'PATCH');
const socket=io();socket.on('state:snapshot',render);socket.on('queue:updated',render);socket.on('connect',refresh);refresh();
