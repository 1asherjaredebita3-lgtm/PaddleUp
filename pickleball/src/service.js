import mongoose from 'mongoose';
import { User, Court, QueueEntry, Match, State, Sms } from './models.js';
import { selectGroups, teamsFor, id, eligible, ordered, deck } from './queue.js';
import { config } from './config.js';
export const fail = (message, status=409) => { throw Object.assign(new Error(message),{status}); };
// ALL state mutations go through this function. Updating the shared lock first makes
// read/plan/write atomic. At larger scale use one lock per facility, not one per court.
export async function mutate(work) {
  let result;
  await mongoose.connection.transaction(async session => {
    await State.findOneAndUpdate({_id:'facility'},{$inc:{revision:1}},{session});
    result = await work(session);
  });
  return result;
}
export async function callMatch(court, groups, retained, session) {
  const players = [...retained,...groups.flatMap(e=>e.players.map(id))];
  if(players.length !== config.capacity || new Set(players.map(id)).size!==4) fail('Exactly four distinct players required');
  const [match] = await Match.create([{ court: court._id, entries: groups.map(e=>e._id),
    players, teams: teamsFor(groups,retained), retainedPlayers: retained, calledAt:new Date() }],{session});
  await QueueEntry.updateMany({_id:{$in:groups.map(e=>e._id)},status:'waiting'},
    {$set:{status:'called',match:match._id}},{session});
  court.currentMatch = match._id; await court.save({session});
  // Durable notification intent commits with the match. Never expose contacts in events.
  for(const player of await User.find({_id:{$in:players},smsConsent:true}).session(session)) {
    if(player.phone) await Sms.create([{key:`${match._id}:${player._id}`,match:match._id,user:player._id,
      body:`You're up! Please report to ${court.name}.`}],{session});
  }
  return match;
}
export async function dispatch(session) {
  if((await State.findById('facility').session(session)).paused) return;
  const courts = await Court.find({status:'Active',paused:false,currentMatch:null}).sort({name:1}).session(session);
  let waiting = await QueueEntry.find({status:'waiting'}).populate('players').session(session);
  for(const court of courts) {
    const groups = selectGroups(waiting,court);
    if(groups.length) {
      await callMatch(court,groups,[],session);
      waiting = waiting.filter(e=>!groups.some(g=>id(g)===id(e)));
    }
  }
}
export async function finish(matchId, winnerTeam, session) {
  const match = await Match.findById(matchId).session(session);
  if(!match || match.status !== 'playing') fail('Match must be playing');
  const court = await Court.findById(match.court).session(session);
  const entries = await QueueEntry.find({_id:{$in:match.entries}}).populate('players').session(session);
  const state = await State.findById('facility').session(session);
  const challenge = ['Challenge','King of the Court'].includes(court.type);
  let retained = [];
  if(challenge && winnerTeam != null) {
    if(![0,1].includes(winnerTeam)) fail('winnerTeam must be 0 or 1; null resets all four');
    retained = match.teams[winnerTeam].map(id);
    // A party cannot be partially retained while its other players leave the court.
    if(entries.some(e=>e.players.some(p=>retained.includes(id(p))) && !e.players.every(p=>retained.includes(id(p)))))
      fail('Winning pair would split a party; use all-off reset (winnerTeam:null)');
    if(state.paused || court.paused || court.status!=='Active') fail('Resume court/queue or use all-off reset');
    const waiting = await QueueEntry.find({status:'waiting'}).populate('players').session(session);
    const groups = selectGroups(waiting,court,2);
    // Keep the current match playing until challengers exist; do not orphan winners.
    if(!groups.length) fail('No compatible challenger pair yet; keep current match or reset all-off');
    const winningEntries = entries.filter(e=>e.players.every(p=>retained.includes(id(p))));
    const next = await callMatch(court,groups,retained,session);
    // Carry winning party records into the next match to preserve group identity.
    next.entries.push(...winningEntries.map(e=>e._id)); await next.save({session});
    await QueueEntry.updateMany({_id:{$in:winningEntries.map(e=>e._id)}},{$set:{status:'called',match:next._id}},{session});
  } else { court.currentMatch=null; await court.save({session}); }
  match.status='finished'; match.endedAt=new Date(); await match.save({session});
  const released = match.players.map(id).filter(p=>!retained.includes(p));
  await User.updateMany({_id:{$in:released}},{$set:{busy:false}},{session});
  await QueueEntry.updateMany({_id:{$in:entries.filter(e=>!e.players.every(p=>retained.includes(id(p)))).map(e=>e._id)}},{$set:{status:'done'}},{session});
  await dispatch(session);
  return {courtId:id(court),matchId:id(match)};
}
export async function snapshot() {
  // Read a consistent revision + projection in a read-only snapshot transaction.
  let output;
  await mongoose.connection.transaction(async session => {
    const state = await State.findById('facility').session(session).lean();
    const courts = await Court.find().sort({name:1}).populate({path:'currentMatch',populate:{path:'players',select:'name'}}).session(session).lean();
    const entries = ordered(await QueueEntry.find({status:'waiting'}).populate('players').session(session).lean());
    output = { revision:state.revision,paused:state.paused,serverTime:new Date().toISOString(),
      courts:courts.map(c=>({id:id(c),name:c.name,type:c.type,status:c.status,paused:c.paused,
        match:c.currentMatch ? {id:id(c.currentMatch),status:c.currentMatch.status,
          players:c.currentMatch.players.map(p=>p.name),
          teams:c.currentMatch.teams.map(team=>team.map(pid=>c.currentMatch.players.find(p=>id(p)===id(pid))?.name || 'Player')),
          entries:c.currentMatch.entries.map(id),
          calledAt:c.currentMatch.calledAt,startedAt:c.currentMatch.startedAt}:null})),
      queue:entries.map(e=>({id:id(e),players:e.players.map(p=>p.name),types:e.types,priority:e.priority})),
      deck:state.paused ? [] : deck(entries,courts) };
  });
  return output;
}
