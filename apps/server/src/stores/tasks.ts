import type { Database } from "bun:sqlite";
import { newID, nowISO } from "../util/ids";

export type TaskStatus = "open" | "done" | "snoozed";
export type TaskPriority = "low" | "normal" | "high";
export interface TaskRow {
  id: string; title: string; due_at: string|null; priority: TaskPriority; status: TaskStatus;
  created_at: string; updated_at: string; snoozed_until: string|null; owner_device_id: string|null;
}

export function createTask(db: Database, input: { title: string; dueAt?: string|null; priority?: TaskPriority; ownerDeviceID?: string }): TaskRow {
  const title=input.title.trim();
  if (!title || title.length>500) throw new Error("task title must be 1–500 characters");
  const priority=input.priority??"normal"; validatePriority(priority);
  const dueAt=validateDate(input.dueAt);
  const row: TaskRow={id:newID("tsk"),title,due_at:dueAt,priority,status:"open",created_at:nowISO(),updated_at:nowISO(),snoozed_until:null,owner_device_id:input.ownerDeviceID??null};
  db.run("INSERT INTO tasks(id,title,due_at,priority,status,created_at,updated_at,snoozed_until,owner_device_id) VALUES(?,?,?,?,?,?,?,?,?)",[row.id,row.title,row.due_at,row.priority,row.status,row.created_at,row.updated_at,row.snoozed_until,row.owner_device_id]);
  return row;
}

export function listTasks(db: Database, options: {status?: TaskStatus|"all"; limit?: number; includeSnoozed?: boolean}={}): TaskRow[] {
  const status=options.status??"open", limit=Math.min(200,Math.max(1,Math.floor(options.limit??50)));
  if(status!=="all") validateStatus(status);
  return status==="all"
    ? db.query<TaskRow,[number]>("SELECT * FROM tasks ORDER BY CASE WHEN due_at IS NULL THEN 1 ELSE 0 END,due_at,created_at LIMIT ?").all(limit)
    : options.includeSnoozed && status==="open"
      ? db.query<TaskRow,[number]>("SELECT * FROM tasks WHERE status IN ('open','snoozed') ORDER BY CASE WHEN due_at IS NULL THEN 1 ELSE 0 END,due_at,created_at LIMIT ?").all(limit)
      : db.query<TaskRow,[TaskStatus,number]>("SELECT * FROM tasks WHERE status=? ORDER BY CASE WHEN due_at IS NULL THEN 1 ELSE 0 END,due_at,created_at LIMIT ?").all(status,limit);
}

export function setTaskStatus(db: Database,id:string,status:TaskStatus):TaskRow|null {
  validateStatus(status);
  const old=getTask(db,id); if(!old)return null;
  db.run("UPDATE tasks SET status=?,snoozed_until=NULL,updated_at=? WHERE id=?",[status,nowISO(),id]);
  return getTask(db,id);
}

export function snoozeTask(db: Database,id:string,until:string):TaskRow|null {
  const date=validateDate(until); if(!date || Date.parse(date)<=Date.now()) throw new Error("snooze time must be in the future");
  const old=getTask(db,id); if(!old)return null;
  db.run("UPDATE tasks SET status='snoozed',snoozed_until=?,updated_at=? WHERE id=?",[date,nowISO(),id]);
  return getTask(db,id);
}

export function getTask(db:Database,id:string):TaskRow|null { return db.query<TaskRow,[string]>("SELECT * FROM tasks WHERE id=?").get(id)??null; }

export function validateDate(value:string|null|undefined):string|null {
  if(value==null||value==="")return null;
  const ms=Date.parse(value); if(!Number.isFinite(ms))throw new Error("date must be a valid ISO timestamp");
  return new Date(ms).toISOString();
}
export function validateStatus(value:string):asserts value is TaskStatus { if(!["open","done","snoozed"].includes(value))throw new Error("invalid task status"); }
export function validatePriority(value:string):asserts value is TaskPriority { if(!["low","normal","high"].includes(value))throw new Error("invalid task priority"); }
