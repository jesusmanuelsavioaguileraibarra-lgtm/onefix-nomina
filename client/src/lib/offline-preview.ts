import type { QueuedPayment } from "./offline";
export type { QueuedPayment };
export type { QueuedAttendance } from "./offline";
import type { QueuedAttendance } from "./offline";
const settings=new Map<string,unknown>();
const payments=new Map<string,QueuedPayment>();
export async function saveLocal(key:string,value:unknown) {settings.set(key,value);}
export async function loadLocal<T>(key:string):Promise<T|undefined> {return settings.get(key) as T|undefined;}
export async function removeLocal(key:string) {settings.delete(key);}
export async function queuePayment(payment:QueuedPayment) {payments.set(payment.operationId,payment);}
export async function listPayments() {return Array.from(payments.values());}
export async function removePayment(operationId:string) {payments.delete(operationId);}
export function lockOffline() {}
export function offlineUnlocked(_userId:number) {return true;}
export async function unlockOffline(_userId:number,_pin:string,_create=false) {}
export async function saveEncrypted(_userId:number,key:string,value:unknown) {settings.set(key,value);}
export async function loadEncrypted<T>(_userId:number,key:string):Promise<T|undefined> {return settings.get(key) as T|undefined;}
const attendances=new Map<string,QueuedAttendance>();
export async function listAttendance(userId:number) {return Array.from(attendances.values()).filter(a=>a.userId===userId);}
export async function queueAttendance(item:QueuedAttendance) {attendances.set(item.operationId,item);}
export async function removeAttendance(_userId:number,operationId:string) {attendances.delete(operationId);}
