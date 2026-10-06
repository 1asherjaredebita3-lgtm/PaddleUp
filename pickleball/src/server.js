import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import mongoose from 'mongoose';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { Server } from 'socket.io';
import twilio from 'twilio';
import { config, courtTypes, courtStatuses } from './config.js';
import { User, Court, QueueEntry, Match, State, Sms } from './models.js';
import { mutate, dispatch, finish, snapshot, fail, callMatch } from './service.js';
import { eligible, id } from './queue.js';
if(!process.env.ADMIN_TOKEN || process.env.ADMIN_TOKEN.startsWith('replace-')) throw new Error('Set a strong ADMIN_TOKEN');
await mongoose.connect(process.env.MONGODB_URI);
for(const model of [User,Court,QueueEntry,Match,State,Sms]) await model.init();
await State.updateOne({_id:'facility'},{$setOnInsert:{revision:0,paused:false}},{upsert:true});
const app = express(), server = http.createServer(app);
const io = new Server(server); // Same origin; no wildcard CORS, no socket mutation commands.
app.use(helmet({contentSecurityPolicy:{directives:{'script-src':["'self'"],'connect-src':["'self'"], 'upgrade-insecure-requests':null}}}));
app.use(express.json({limit:'32kb'}));
app.use('/api',rateLimit({windowMs:60000,limit:120}));
app.use(express.static('public'));
const hash = value => createHash('sha256').update(String(value)).digest('hex');
const admin = (req,res,next) => {
  const a=Buffer.from(hash(req.headers.authorization || ''));
  const b=Buffer.from(hash(`Bearer ${process.env.ADMIN_TOKEN}`));
  if(!timingSafeEqual(a,b)) return res.status(401).json({error:'Admin token required'});
  next();
};
const validId = value => { if(!mongoose.isValidObjectId(value)) fail('Invalid id',400); return value; };
// Full snapshots are cheap for one facility. Revision guards handle events arriving out of order.
// Post-commit publication failure must NOT turn a committed write into an HTTP error.
const announced = new Set();
async function publish(event='queue:updated', extra={}) {
  try { const state=await snapshot();
    for(const court of state.courts) if(court.match?.status==='called' && !announced.has(court.match.id)) {
      announced.add(court.match.id); io.emit('match:called',{revision:state.revision,courtId:court.id,matchId:court.match.id,players:court.match.players});
    }
    if(event!=='queue:updated' && event!=='match:called')io.emit(event,{...extra,revision:state.revision});
    io.emit('queue:updated',state); }
  catch { console.error('Snapshot publication failed; periodic resync will recover'); }
}
async function change(req,res,work,event,extra) {
  const result=await mutate(async session=>{const r=await work(session); await dispatch(session); return r;});
  res.json(result ?? {ok:true}); await publish(event,extra);
}
app.get('/api/state',async(req,res)=>res.json(await snapshot()));
app.post('/api/users/check-in',rateLimit({windowMs:60000,limit:20}),async(req,res)=>{
  const {name,skill,dupr,phone,smsConsent}=req.body;
  if(typeof name!=='string' || !name.trim() || name.length>60 || !['Beginner','Intermediate','Advanced'].includes(skill)) fail('Invalid name or skill',400);
  if(dupr!=null && (typeof dupr!=='number' || dupr<2 || dupr>8)) fail('DUPR must be 2–8',400);
  if(phone && (typeof phone!=='string' || !/^\+[1-9]\d{7,14}$/.test(phone))) fail('Use E.164 phone format, e.g. +639171234567',400);
  const token=randomBytes(32).toString('hex');
  const user=await User.create({name:name.trim(),skill,dupr,phone,smsConsent:smsConsent===true,tokenHash:hash(token)});
  res.status(201).json({userId:id(user),token});
});
app.post('/api/queue',async(req,res)=>{
  const {members,types}=req.body;
  if(!Array.isArray(members) || members.length<config.minGroup || members.length>config.maxGroup || new Set(members.map(m=>m?.userId)).size!==members.length) fail('Invalid or duplicate party members',400);
  if(!Array.isArray(types) || !types.length || types.some(t=>!courtTypes.includes(t))) fail('Choose valid court types',400);
  await change(req,res,async session=>{
    const players=[];
    // Each member supplies their check-in credential. A QR check-in URL points to index.html,
    // never to an admin token. Kiosk can check in all party members in one sitting.
    for(const m of members) {
      const user=await User.findById(validId(m.userId)).select('+tokenHash').session(session);
      if(!user || typeof m.token!=='string' || user.tokenHash!==hash(m.token)) fail('Member credential invalid',401);
      if(user.busy) fail('Player already queued or playing');
      user.busy=true; await user.save({session}); players.push(user._id);
    }
    const last=await QueueEntry.findOne({status:'waiting'}).sort({priority:-1}).session(session);
    const [entry]=await QueueEntry.create([{players,types,priority:last ? last.priority+1 : 0}],{session}); return {entryId:id(entry)};
  });
});
app.use('/api/admin',admin);
app.patch('/api/admin/settings',async(req,res)=>{
  if(typeof req.body.paused!=='boolean') fail('paused must be boolean',400);
  await change(req,res,session=>State.updateOne({_id:'facility'},{$set:{paused:req.body.paused}},{session}).then(()=>({ok:true})));
});
app.patch('/api/admin/courts/:id',async(req,res)=>{
  await change(req,res,async session=>{
    const court=await Court.findById(validId(req.params.id)).session(session); if(!court) fail('Court not found',404);
    const allowed=['name','type','status','paused','minDupr','maxDupr','averageMinutes'];
    for(const key of Object.keys(req.body)) if(!allowed.includes(key)) fail('Unknown court setting',400);
    if(req.body.type!=null && !courtTypes.includes(req.body.type)) fail('Invalid court type',400);
    if(req.body.status!=null && !courtStatuses.includes(req.body.status)) fail('Invalid court status',400);
    if(req.body.paused!=null && typeof req.body.paused!=='boolean') fail('paused must be boolean',400);
    if(court.currentMatch && req.body.type && req.body.type!==court.type) fail('Finish current match before changing type');
    Object.assign(court,req.body);
    if(court.minDupr!=null && court.maxDupr!=null && court.minDupr>court.maxDupr) fail('Invalid rating range',400);
    await court.save({session}); return {ok:true};
  });
});
app.post('/api/admin/queue/reorder',async(req,res)=>{
  await change(req,res,async session=>{
    const ids=req.body.entryIds; if(!Array.isArray(ids) || new Set(ids).size!==ids.length) fail('entryIds must be a unique list',400);
    ids.forEach(validId);
    const waiting=await QueueEntry.find({status:'waiting'}).session(session);
    if(ids.length!==waiting.length || waiting.some(e=>!ids.includes(id(e)))) fail('Supply every current waiting entry once; refresh stale state');
    for(let i=0;i<ids.length;i++) await QueueEntry.updateOne({_id:ids[i]},{$set:{priority:i}},{session});
    return {ok:true};
  });
});
app.post('/api/admin/queue/:id/no-show',async(req,res)=>{
  await change(req,res,async session=>{
    const entry=await QueueEntry.findById(validId(req.params.id)).session(session);
    if(!entry || !['waiting','called'].includes(entry.status)) fail('Only waiting/called parties can be bumped');
    if(entry.status==='called') {
      const match=await Match.findById(entry.match).session(session);
      // Cancel the whole called match; return all other whole parties to their old positions.
      match.status='cancelled'; await match.save({session});
      await Court.updateOne({_id:match.court},{$set:{currentMatch:null}},{session});
      await QueueEntry.updateMany({_id:{$in:match.entries},status:'called'},{$set:{status:'waiting'},$unset:{match:1}},{session});
      await Sms.updateMany({match:match._id,status:'pending'},{$set:{status:'failed',error:'Match cancelled'}},{session});
    }
    entry.status='no-show'; await entry.save({session});
    await User.updateMany({_id:{$in:entry.players}},{$set:{busy:false}},{session}); return {ok:true};
  });
});
app.post('/api/admin/matches/assign',async(req,res)=>{
  await change(req,res,async session=>{
    // A global pause stops automatic allocation; staff may still explicitly assign.
    const court=await Court.findById(validId(req.body.courtId)).session(session);
    if(!court || court.currentMatch || court.paused || court.status!=='Active') fail('Court must be active, empty and unpaused');
    const ids=req.body.entryIds; if(!Array.isArray(ids) || !ids.length || new Set(ids).size!==ids.length) fail('Invalid entryIds',400); ids.forEach(validId);
    const groups=await QueueEntry.find({_id:{$in:ids},status:'waiting'}).populate('players').session(session);
    if(groups.length!==ids.length || groups.some(e=>!eligible(e,court))) fail('Entries missing or incompatible');
    return {matchId:id(await callMatch(court,groups,[],session))};
  },'match:called');
});
app.post('/api/admin/matches/:id/start',async(req,res)=>{
  await change(req,res,async session=>{
    const match=await Match.findById(validId(req.params.id)).session(session);
    if(!match || match.status!=='called') fail('Match must be called');
    match.status='playing'; match.startedAt=new Date(); await match.save({session});
    await QueueEntry.updateMany({_id:{$in:match.entries}},{$set:{status:'playing'}},{session}); return {ok:true};
  });
});
app.post('/api/admin/matches/:id/finish',async(req,res)=>{
  const result=await mutate(session=>finish(validId(req.params.id),req.body.winnerTeam ?? null,session));
  res.json(result); await publish('court:vacated',result);
});
app.use((err,req,res,next)=>{
  const status=err.status || (err.name==='ValidationError' || err.name==='CastError' ? 400 : err.code===11000 ? 409 : 500);
  if(status===500) console.error(err.name); // Avoid logging phones/tokens or request bodies.
  res.status(status).json({error:status===500?'Internal server error':err.message});
});
// Socket events are authoritative notifications only. REST is the validated command path.
io.on('connection',socket=>{ snapshot().then(s=>socket.emit('state:snapshot',s)).catch(()=>socket.disconnect()); });
// Reconciliation repairs a crash after DB commit but before broadcast, and refreshes ETA.
let reconciling=false;
setInterval(async()=>{if(reconciling)return; reconciling=true; try {await publish();} finally {reconciling=false;}},10000).unref();
// SMS is opt-in and remains disabled without credentials. A claimed message is never
// automatically resent after an ambiguous timeout/crash: operator reconciles it with Twilio.
const smsClient=process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM ? twilio(process.env.TWILIO_ACCOUNT_SID,process.env.TWILIO_AUTH_TOKEN) : null;
let sending=false;
setInterval(async()=>{
  if(!smsClient || sending)return; sending=true;
  let job;
  try {
    job=await Sms.findOneAndUpdate({status:'pending'},{$set:{status:'sending',attemptedAt:new Date()}},{sort:{createdAt:1},new:true});
    if(!job)return;
    const match=await Match.findById(job.match), user=await User.findById(job.user);
    if(!match || match.status!=='called' || !user?.smsConsent || !user.phone) {
      job.status='failed'; job.error='No longer eligible';
    } else {
      const message=await smsClient.messages.create({to:user.phone,from:process.env.TWILIO_FROM,body:job.body});
      job.status='accepted'; job.providerSid=message.sid; // Accepted is NOT delivered.
    }
    await job.save();
  } catch { if(job) await Sms.updateOne({_id:job._id},{$set:{status:'uncertain',error:'Provider outcome requires reconciliation'}}).catch(()=>{}); }
  finally {sending=false;}
},2000).unref();
server.listen(Number(process.env.PORT || 3000),()=>console.log('Queue server ready'));
