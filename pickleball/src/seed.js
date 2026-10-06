import 'dotenv/config';
import mongoose from 'mongoose';
import { Court, State } from './models.js';
import { config } from './config.js';
await mongoose.connect(process.env.MONGODB_URI);
if(!Number.isInteger(config.courtCount) || config.courtCount<1 || config.courtCount>100) throw new Error('COURT_COUNT must be 1–100');
await Court.init();
// EDIT .env COURT_COUNT to set initial count. Seeding is idempotent and never deletes courts.
for(let n=1;n<=config.courtCount;n++) await Court.updateOne({name:`Court ${n}`},
  {$setOnInsert:{name:`Court ${n}`,type:'Beginner',status:'Active',averageMinutes:config.defaultMinutes}},{upsert:true});
await State.updateOne({_id:'facility'},{$setOnInsert:{revision:0,paused:false}},{upsert:true});
await mongoose.disconnect();
