let count=0, credentials=[];
function add(){ if(count>=4)return;count++;
 const box=document.createElement('section');box.className='card';
 box.innerHTML=`<h2>Player ${count}</h2><label>Name<input name="name" maxlength="60" required></label><label>Skill<select name="skill"><option>Beginner</option><option>Intermediate</option><option>Advanced</option></select></label><label>DUPR (optional)<input name="dupr" type="number" min="2" max="8" step="0.01"></label><label>Phone (optional)<input name="phone" type="tel" placeholder="+639171234567"></label><label><span><input name="consent" type="checkbox"> I agree to SMS court alerts</span></label>`;
 document.querySelector('#members').append(box);document.querySelector('#add').disabled=count===4;
}
['Beginner','Advanced','Challenge','King of the Court'].forEach(type=>{
 const label=document.createElement('label'),input=document.createElement('input');input.type='checkbox';input.value=type;input.name='type';
 label.append(input,document.createTextNode(type));document.querySelector('#types').append(label);
});
add();document.querySelector('#add').onclick=add;
async function post(url,body){const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const data=await r.json();if(!r.ok)throw Error(data.error);return data;}
document.querySelector('#checkin').onsubmit=async event=>{
 event.preventDefault();const button=document.querySelector('#join'),message=document.querySelector('#message');button.disabled=true;
 try{
  const types=[...document.querySelectorAll('[name="type"]:checked')].map(e=>e.value);if(!types.length)throw Error('Choose a court type');
  // Preserve successful member credentials when a later request fails, so retry does not create duplicates.
  const boxes=[...document.querySelectorAll('#members .card')];
  for(let i=credentials.length;i<boxes.length;i++){
   const box=boxes[i],value=n=>box.querySelector(`[name="${n}"]`).value;
   credentials.push(await post('/api/users/check-in',{name:value('name'),skill:value('skill'),dupr:value('dupr')?Number(value('dupr')):undefined,phone:value('phone'),smsConsent:box.querySelector('[name="consent"]').checked}));
   box.querySelectorAll('input,select').forEach(e=>e.disabled=true);
  }
  const result=await post('/api/queue',{members:credentials,types});
  message.textContent=`You're queued! Party ${result.entryId}. View the live board for your call.`;
  document.querySelectorAll('input,select,button').forEach(e=>e.disabled=true);
 }catch(error){message.textContent=error.message;button.disabled=false;}
};
