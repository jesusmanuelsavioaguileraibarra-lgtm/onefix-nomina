import type { QueuedPayment } from "./offline";
export type { QueuedPayment };
const settings=new Map<string,unknown>();
const payments=new Map<string,QueuedPayment>();
export async function saveLocal(key:string,value:unknown) {settings.set(key,value);}
export async function loadLocal<T>(key:string):Promise<T|undefined> {return settings.get(key) as T|undefined;}
export async function removeLocal(key:string) {settings.delete(key);}
export async function queuePayment(payment:QueuedPayment) {payments.set(payment.operationId,payment);}
export async function listPayments() {return Array.from(payments.values());}
export async function removePayment(operationId:string) {payments.delete(operationId);}
