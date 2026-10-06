import test from 'node:test';
import assert from 'node:assert/strict';
import { selectGroups,teamsFor,eligible,deck } from '../src/queue.js';
const court={_id:'court',type:'Beginner',status:'Active',averageMinutes:15};
const group=(key,size,priority=0)=>({_id:key,priority,status:'waiting',createdAt:new Date(0),types:['Beginner'],players:Array.from({length:size},(_,i)=>({_id:`${key}${i}`,name:`${key}${i}`,skill:'Beginner'}))});
test('3 + 1 parties stay intact',()=>assert.deepEqual(selectGroups([group('a',3),group('b',1)],court).map(g=>g._id),['a','b']));
test('3 + 2 alone cannot fill four',()=>assert.equal(selectGroups([group('a',3),group('b',2)],court).length,0));
test('exact-fill bypasses an unfillable older trio for 2 + 2',()=>assert.deepEqual(selectGroups([group('a',3),group('b',2),group('c',2)],court).map(g=>g._id),['b','c']));
test('oldest fillable group wins over a later full party',()=>assert.deepEqual(selectGroups([group('a',3),group('b',4),group('c',1)],court).map(g=>g._id),['a','c']));
test('challenge two spots reject groups of three/four',()=>assert.deepEqual(selectGroups([group('a',3),group('b',4),group('c',2)],court,2).map(g=>g._id),['c']));
test('admin priority precedes creation order',()=>assert.deepEqual(selectGroups([group('a',4,3),group('b',4,1)],court).map(g=>g._id),['b']));
test('rating rules require every player, missing DUPR is incompatible',()=>assert.equal(eligible(group('a',4),{...court,minDupr:3}),false));
test('two person parties remain on same team',()=>assert.deepEqual(teamsFor([group('a',1),group('b',2),group('c',1)]),[['b0','b1'],['a0','c0']]));
test('deck never assigns same party to two courts',()=>{const d=deck([group('a',4)],[court,{...court,_id:'court2'}]);assert.equal(d[0].groups.length,1);assert.equal(d[1].groups.length,0);});
test('exhaustive small party sequences: exact fill and no duplicates',()=>{
 for(let code=0;code<4096;code++) {let n=code;const groups=[];for(let i=0;i<6;i++){groups.push(group(String(i),(n%4)+1,i));n=Math.floor(n/4);}
 const selected=selectGroups(groups,court);const possible=Array.from({length:64},(_,mask)=>groups.reduce((s,g,i)=>s+((mask&(1<<i))?g.players.length:0),0)).includes(4);
 assert.equal(selected.length>0,possible);if(possible)assert.equal(selected.reduce((s,g)=>s+g.players.length,0),4);
 assert.equal(new Set(selected.map(g=>g._id)).size,selected.length);
 }
});
