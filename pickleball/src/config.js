// EDIT HERE: court capacity is doubles (4); group limits may be reduced, never exceed capacity.
export const config = Object.freeze({ capacity: 4, minGroup: 1, maxGroup: 4,
  defaultMinutes: 15, callGraceMinutes: 3, courtCount: Number(process.env.COURT_COUNT || 4) });
export const courtTypes = ['Beginner','Advanced','Challenge','King of the Court'];
export const courtStatuses = ['Active','Maintenance','Tournament'];
