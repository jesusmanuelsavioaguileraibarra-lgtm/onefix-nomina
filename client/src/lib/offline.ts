export type QueuedPayment = {
  operationId:string; lineId:number; method:string; reference:string;
  recordedAt:string; userId:number; status:"pending"|"conflict"; message?:string;
};
export type QueuedAttendance = {
  operationId:string; userId:number; expectedRevision:number;
  proposed:Record<string,unknown>; savedAt:string; status:"pending"|"review"; message?:string;
};
let unlockedKey:CryptoKey|null=null, unlockedUser:number|null=null;
function openDb():Promise<IDBDatabase> {
  return new Promise((resolve,reject)=>{
    if(!("indexedDB" in window)) return reject(new Error("Almacenamiento local no disponible"));
    // Never reuse the beta's storage for real employees or attendance.
    const request=indexedDB.open("onefix-real-attendance-v1",1);
    request.onupgradeneeded=()=>{
      const db=request.result;
      if(!db.objectStoreNames.contains("settings")) db.createObjectStore("settings");
      if(!db.objectStoreNames.contains("payments")) db.createObjectStore("payments",{keyPath:"operationId"});
    };
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error);
  });
}
async function transact<T>(store:"settings"|"payments",mode:IDBTransactionMode,action:(s:IDBObjectStore)=>IDBRequest<T>):Promise<T> {
  const db=await openDb();
  try {
    return await new Promise<T>((resolve,reject)=>{
      const tx=db.transaction(store,mode);
      const request=action(tx.objectStore(store));
      request.onsuccess=()=>resolve(request.result);
      request.onerror=()=>reject(request.error);
      tx.onerror=()=>reject(tx.error);
    });
  } finally {db.close();}
}
export const saveLocal=(key:string,value:unknown)=>transact("settings","readwrite",s=>s.put(value,key));
export const loadLocal=<T>(key:string)=>transact<T|undefined>("settings","readonly",s=>s.get(key));
export const removeLocal=(key:string)=>transact("settings","readwrite",s=>s.delete(key));
export const queuePayment=(payment:QueuedPayment)=>transact("payments","readwrite",s=>s.put(payment));
export const listPayments=()=>transact<QueuedPayment[]>("payments","readonly",s=>s.getAll());
export const removePayment=(operationId:string)=>transact("payments","readwrite",s=>s.delete(operationId));
const markerKey=(userId:number)=>`secure-check-v1-${userId}`;
const pepperKey=(userId:number)=>`secure-device-v1-${userId}`;
type Encrypted={iv:number[];data:number[]};
async function seal(key:CryptoKey,value:unknown):Promise<Encrypted> {
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const data=await crypto.subtle.encrypt({name:"AES-GCM",iv},key,new TextEncoder().encode(JSON.stringify(value)));
  return {iv:Array.from(iv),data:Array.from(new Uint8Array(data))};
}
async function unseal<T>(key:CryptoKey,value:Encrypted):Promise<T> {
  const bytes=await crypto.subtle.decrypt({name:"AES-GCM",iv:new Uint8Array(value.iv)},key,new Uint8Array(value.data));
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}
export function lockOffline() {unlockedKey=null;unlockedUser=null;}
export function offlineUnlocked(userId:number) {return unlockedUser===userId&&unlockedKey!==null;}
export async function unlockOffline(userId:number,pin:string,create=false) {
  if(!/^\d{4}$/.test(pin) && pin.length<12)throw new Error("Ingresa tu contraseña de al menos 12 caracteres.");
  let device=await loadLocal<CryptoKey>(pepperKey(userId));
  let marker=await loadLocal<Encrypted>(markerKey(userId));
  if(!device || !marker) {
    if(!create)throw new Error("Este dispositivo no tiene una copia local cifrada. Conéctate para activarla.");
    device=await crypto.subtle.generateKey({name:"HMAC",hash:"SHA-256"},false,["sign"]);
    await saveLocal(pepperKey(userId),device);
    marker=undefined;
  }
  const derived=await crypto.subtle.sign("HMAC",device,new TextEncoder().encode(`onefix-offline-v1:${userId}:${pin}`));
  const key=await crypto.subtle.importKey("raw",derived,{name:"AES-GCM"},false,["encrypt","decrypt"]);
  if(marker) {
    try {
      if((await unseal<string>(key,marker))!=="ONEFIX")throw new Error("PIN incorrecto");
    } catch {throw new Error("PIN incorrecto o copia local dañada.");}
  } else await saveLocal(markerKey(userId),await seal(key,"ONEFIX"));
  unlockedKey=key;unlockedUser=userId;
}
export async function saveEncrypted(userId:number,key:string,value:unknown) {
  if(!offlineUnlocked(userId))throw new Error("Desbloquea la copia local.");
  return saveLocal(`enc-v1-${userId}-${key}`,await seal(unlockedKey!,value));
}
export async function loadEncrypted<T>(userId:number,key:string):Promise<T|undefined> {
  if(!offlineUnlocked(userId))throw new Error("Desbloquea la copia local.");
  const value=await loadLocal<Encrypted>(`enc-v1-${userId}-${key}`);
  return value?unseal<T>(unlockedKey!,value):undefined;
}
const attendanceKey="attendance-pending";
export const listAttendance=async(userId:number)=>await loadEncrypted<QueuedAttendance[]>(userId,attendanceKey) || [];
export async function queueAttendance(item:QueuedAttendance) {
  const items=await listAttendance(item.userId);
  await saveEncrypted(item.userId,attendanceKey,[...items.filter(x=>x.operationId!==item.operationId),item]);
}
export async function removeAttendance(userId:number,operationId:string) {
  const items=await listAttendance(userId);
  await saveEncrypted(userId,attendanceKey,items.filter(x=>x.operationId!==operationId));
}
