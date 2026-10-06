import { config } from './config.js';
export const id = x => String(x?._id ?? x);
export const ordered = entries => [...entries].sort((a,b) => a.priority-b.priority ||
  new Date(a.createdAt)-new Date(b.createdAt) || id(a).localeCompare(id(b)));
export function eligible(entry, court) {
  return entry.types.includes(court.type) && entry.players.every(p =>
    (court.type !== 'Beginner' || p.skill === 'Beginner') &&
    (court.type !== 'Advanced' || p.skill === 'Advanced') &&
    (court.minDupr == null || (p.dupr != null && p.dupr >= court.minDupr)) &&
    (court.maxDupr == null || (p.dupr != null && p.dupr <= court.maxDupr)));
}
// Exact-fill dynamic programming: keeps whole groups, avoids a greedy 3+2 dead end.
// Fairness: choose the earliest eligible entry that can participate in a full match,
// then the lexicographically earliest possible completion. Unfillable parties wait.
// Challenge slots=2 means groups of 3/4 remain intact and wait for a full reset.
export function selectGroups(entries, court, slots = config.capacity) {
  const list = ordered(entries.filter(e => e.status === 'waiting' && eligible(e,court)));
  const best = new Map([[0, []]]);
  const earlier = (a,b) => { for(let i=0;i<Math.min(a.length,b.length);i++) {
    if(a[i] !== b[i]) return a[i] < b[i]; } return a.length < b.length; };
  list.forEach((e,i) => {
    for(const [size, indexes] of [...best.entries()].sort((a,b)=>b[0]-a[0])) {
      const next = size + e.players.length;
      if(next > slots) continue;
      const candidate = [...indexes,i];
      if(!best.has(next) || earlier(candidate,best.get(next))) best.set(next,candidate);
    }
  });
  return (best.get(slots) || []).map(i=>list[i]);
}
// Keep two-person parties on the same team when a 2+2 partition exists.
// A party of 3/4 can share a MATCH but cannot be wholly retained as a winning pair.
export function teamsFor(groups, retained = []) {
  const players = groups.flatMap(e=>e.players.map(id));
  if(retained.length) return [retained.map(id), players];
  for(let mask=1; mask < 2**groups.length; mask++) {
    const team = groups.filter((_,i)=>mask & (1<<i)).flatMap(e=>e.players.map(id));
    if(team.length===2) return [team,players.filter(x=>!team.includes(x))];
  }
  return [players.slice(0,2),players.slice(2)];
}
// Deck preview uses the same allocator, reserving groups once across available courts.
export function deck(entries, courts) {
  let remaining = [...entries];
  return courts.filter(c=>c.status==='Active' && !c.paused).map(c=> {
    const slots = c.currentMatch && ['Challenge','King of the Court'].includes(c.type) ? 2 : 4;
    const groups = selectGroups(remaining,c,slots);
    remaining = remaining.filter(e=>!groups.some(g=>id(g)===id(e)));
    return { courtId: id(c), groups: groups.map(id), players: groups.flatMap(g=>g.players.map(p=>p.name)),
      // One-turn estimate only. Challenge retention has no bounded wait.
      estimatedMinutes: ['Challenge','King of the Court'].includes(c.type) ? null :
        c.currentMatch ? Math.max(0,Math.ceil((new Date(c.currentMatch.startedAt || c.currentMatch.calledAt).getTime()+c.averageMinutes*60000-Date.now())/60000)) : 0 };
  });
}
