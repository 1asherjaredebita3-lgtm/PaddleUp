import mongoose from 'mongoose';
const { Schema, model } = mongoose;
const ref = name => ({ type: Schema.Types.ObjectId, ref: name });
// Private contact data never enters the public board projection.
export const User = model('User', new Schema({
  name: { type: String, required: true, maxlength: 60 },
  skill: { type: String, enum: ['Beginner','Intermediate','Advanced'], required: true },
  dupr: { type: Number, min: 2, max: 8 }, phone: String, smsConsent: { type: Boolean, default: false },
  // A player can be queued or playing only once; updated inside the same transaction.
  busy: { type: Boolean, default: false }, tokenHash: { type: String, required: true, select: false }
}, { timestamps: true }));
export const Court = model('Court', new Schema({
  name: { type: String, unique: true, required: true },
  type: { type: String, enum: ['Beginner','Advanced','Challenge','King of the Court'], default: 'Beginner' },
  status: { type: String, enum: ['Active','Maintenance','Tournament'], default: 'Active' },
  paused: { type: Boolean, default: false }, currentMatch: ref('Match'),
  minDupr: { type: Number, min: 2, max: 8 }, maxDupr: { type: Number, min: 2, max: 8 },
  averageMinutes: { type: Number, min: 1, max: 120, default: 15 }
}, { timestamps: true }));
export const QueueEntry = model('QueueEntry', new Schema({
  players: [{ ...ref('User'), required: true }],
  status: { type: String, enum: ['waiting','called','playing','done','no-show'], default: 'waiting' },
  // A party may choose several court types. Every player must meet rating/skill rules.
  types: [{ type: String, enum: ['Beginner','Advanced','Challenge','King of the Court'] }],
  priority: { type: Number, default: 0 }, match: ref('Match')
}, { timestamps: true }));
QueueEntry.schema.index({ status: 1, priority: 1, createdAt: 1 });
export const Match = model('Match', new Schema({
  court: ref('Court'), entries: [ref('QueueEntry')], players: [ref('User')],
  // Teams are explicit for challenge rotation; each team has exactly two players.
  teams: [[ref('User')]], retainedPlayers: [ref('User')],
  status: { type: String, enum: ['called','playing','finished','cancelled'], default: 'called' },
  calledAt: Date, startedAt: Date, endedAt: Date
}, { timestamps: true }));
// One facility-wide lock document serializes mutations, including across Node processes.
// MongoDB retries write-conflicting transactions; do not do SMS/socket side effects inside them.
export const State = model('State', new Schema({ _id: String, revision: { type: Number, default: 0 },
  paused: { type: Boolean, default: false } }));
export const Sms = model('Sms', new Schema({
  key: { type: String, unique: true }, match: ref('Match'), user: ref('User'), body: String,
  status: { type: String, enum: ['pending','sending','accepted','failed','uncertain'], default: 'pending' },
  providerSid: String, error: String, attemptedAt: Date
}, { timestamps: true }));
