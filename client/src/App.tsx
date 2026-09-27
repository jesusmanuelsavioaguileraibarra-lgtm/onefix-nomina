import { useEffect, useRef, useState } from "react";
import { useQuery, QueryClientProvider } from "@tanstack/react-query";
import { apiRequest, queryClient, setAuthToken } from "./lib/queryClient";
import { loadLocal, saveLocal, removeLocal, saveEncrypted, loadEncrypted, unlockOffline, offlineUnlocked, lockOffline, listPayments, removePayment, listAttendance, queueAttendance, removeAttendance, type QueuedPayment, type QueuedAttendance } from "@offline";
import { Activity, ArrowDownToLine, ArrowRight, BriefcaseBusiness, CalendarDays, Check, ChevronDown, ClipboardCheck, CreditCard, FileText, HardHat, LayoutDashboard, Menu, Moon, Plus, Sun, Users, X } from "lucide-react";
import type { Payroll } from "@shared/schema";
import { latestReadySaturday, payrollPeriod } from "@shared/payrollPeriod";
import { calculateAttendanceHours } from "@shared/attendanceHours";
import { weeklyEffectiveHours } from "@shared/weeklyHours";
import { initialLoadOnly } from "@shared/activation";
import { contractLedger } from "./lib/contract-ledger";
import ContractTracking from "./ContractTracking";
import Receivables from "./Receivables";

type State = { people:any[]; projects:any[]; contracts:any[]; tasks:any[]; attendance:any[]; attendanceConflicts:any[]; dailyPays:any[]; deductions:any[]; payrolls:Payroll[]; amendments:any[]; absenceAdjustments:{personId:number;weekStart:string;amount:number}[] };
type User = {id:number;email:string;role:"produccion"|"administracion"|"gerencia"};
const previewOnly=import.meta.env.VITE_PREVIEW_MODE==="1";
const usd = (n:number) => new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"}).format(n || 0);
const day = () => new Date().toLocaleDateString("en-CA",{timeZone:"America/New_York"});
const legacyPeriod = (p:Payroll) => { try { return payrollPeriod(p.weekStart).weekEnd !== p.weekEnd; } catch { return true; } };
function projectReport(p:Payroll) {
  const groups = new Map<string,{name:string;items:{personName:string;kind:string;hours:number;amount:number}[]}>();
  for (const line of p.lines) for (const a of line.projectAllocations || []) {
    const key = a.projectId === null ? `name:${a.projectName.toLocaleLowerCase()}` : `id:${a.projectId}`;
    const group = groups.get(key) || {name:a.projectName,items:[]};
    group.items.push({personName:line.personName,kind:line.kind,hours:a.hours,amount:a.amount});
    groups.set(key,group);
  }
  return {groups:Array.from(groups.values()).sort((a,b)=>a.name.localeCompare(b.name,"es")),
    historical:p.lines.filter(l=>l.projectAllocations===null)};
}
const number = (v: FormDataEntryValue | null) => Number(v || 0);
const id = (v: FormDataEntryValue | null) => Number(v || 0);
const nav = [
  {key:"inicio",label:"Vista general",icon:LayoutDashboard},
  {key:"personas",label:"Personas",icon:Users},
  {key:"obras",label:"Obras y contratos",icon:HardHat},
  {key:"seguimiento",label:"Seguimiento contratos",icon:BriefcaseBusiness},
  {key:"cobros",label:"Cuentas por cobrar",icon:FileText},
  {key:"produccion",label:"Producción",icon:ClipboardCheck},
  {key:"descuentos",label:"Descuentos",icon:CreditCard},
  {key:"nomina",label:"Nómina semanal",icon:CalendarDays},
] as const;
type Tab = typeof nav[number]["key"] | "accesos";
type Modal = "persona"|"editarPersona"|"obra"|"contrato"|"tarea"|"asistencia"|"jornal"|"descuento"|"ampliacion"|"pago"|null;
function Field({label,name,type="text",required=false,disabled=false,placeholder="",min,minLength,maxLength,step,list,children,defaultValue,className="",value,onChange,onInvalid,onInput,readOnly=false}:any) {
  return <label className={`field ${className}`}><span>{label}</span>{children ? <select name={name} required={required} disabled={disabled} defaultValue={value === undefined ? defaultValue ?? "" : undefined} value={value} onChange={onChange} data-testid={`input-${name}`}><option value="" disabled>Seleccionar</option>{children}</select> :
    <input name={name} type={type} required={required} disabled={disabled} placeholder={placeholder} min={min} minLength={minLength} maxLength={maxLength} step={step} list={list} defaultValue={value === undefined ? defaultValue : undefined} value={value} onChange={onChange} onInvalid={onInvalid} onInput={onInput} readOnly={readOnly} data-testid={`input-${name}`} />}</label>;
}
function AttendanceFields({a,people,projects,onValidationError,onValidationInput}:{a:any;people:any[];projects:any[];onValidationError:(message:string)=>void;onValidationInput:()=>void}) {
  const previousSplits=Array.isArray(a?.allocations)?a.allocations:[];
  const [project,setProject]=useState(a?.projectName || "");
  const [splits,setSplits]=useState<{projectName:string;regularHours:string;overtimeHours:string}[]>(previousSplits.slice(1).map((p:any)=>({projectName:p.projectName,regularHours:String(p.regularHours),overtimeHours:String(p.overtimeHours)})));
  const [timeIn,setTimeIn]=useState(a?.timeIn || "");
  const [timeOut,setTimeOut]=useState(a?.timeOut || "");
  const [breakMinutes,setBreakMinutes]=useState(String(a?.breakMinutes ?? 0));
  const [overtime,setOvertime]=useState(String(a?.overtime ?? 0));
  const [bonus,setBonus]=useState(String(a?.bonus ?? 0));
  const [absent,setAbsent]=useState(!!a?.absent);
  const hasSchedule=!!timeIn && !!timeOut;
  let regular:number|null=null, worked:number|null=null, calculationError="";
  if (hasSchedule) {
    try {
      const result=calculateAttendanceHours(timeIn,timeOut,Number(breakMinutes),Number(overtime));
      regular=result.regular;worked=result.worked;
    } catch(e) { calculationError=(e as Error).message; }
  }
  const primaryRegular=(regular ?? 0)-splits.reduce((sum,p)=>sum+(Number(p.regularHours)||0),0);
  const primaryOvertime=Number(overtime)-splits.reduce((sum,p)=>sum+(Number(p.overtimeHours)||0),0);
  const showRequired=(e:React.InvalidEvent<HTMLInputElement>,message:string) => {
    if (e.currentTarget.form?.querySelector(":invalid")===e.currentTarget) onValidationError(message);
  };
  return <><div className="form-grid">
    <Field label="Empleado" name="personId" required defaultValue={a?.personId}>{people.filter(p=>p.kind==="empleado").map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</Field>
    <Field label="Fecha" name="date" type="date" required defaultValue={a?.date || day()}/>
    <Field label="Proyecto o ubicación principal" name="projectName" required maxLength={160} className="attendance-project" list="attendance-projects" placeholder="Escribe o elige una obra" value={project} onChange={(e:React.ChangeEvent<HTMLInputElement>)=>setProject(e.target.value)} onInvalid={(e:React.InvalidEvent<HTMLInputElement>)=>showRequired(e,"Indica el proyecto o ubicación")} onInput={(e:React.FormEvent<HTMLInputElement>)=>{e.currentTarget.setCustomValidity(e.currentTarget.value.trim()?"":"Indica el proyecto o ubicación");onValidationInput();}}/>
    <datalist id="attendance-projects">{projects.map(p=><option key={p.id} value={p.name}/>)}</datalist>
    <Field label="Responsable" name="responsible" required maxLength={160} placeholder="Nombre del responsable" defaultValue={a?.responsible} onInvalid={(e:React.InvalidEvent<HTMLInputElement>)=>showRequired(e,"Indica el responsable de la asistencia")} onInput={(e:React.FormEvent<HTMLInputElement>)=>{e.currentTarget.setCustomValidity(e.currentTarget.value.trim()?"":"Indica el responsable de la asistencia");onValidationInput();}}/>
    <div className="form-grid attendance-times">
      <Field label="Hora de entrada" name="timeIn" type="time" required={!absent} disabled={absent} value={timeIn} onChange={(e:React.ChangeEvent<HTMLInputElement>)=>{setTimeIn(e.target.value);onValidationInput();}} onInvalid={(e:React.InvalidEvent<HTMLInputElement>)=>showRequired(e,"Indica la hora de entrada")}/>
      <Field label="Hora de salida" name="timeOut" type="time" required={!absent} disabled={absent} value={timeOut} onChange={(e:React.ChangeEvent<HTMLInputElement>)=>{setTimeOut(e.target.value);onValidationInput();}} onInvalid={(e:React.InvalidEvent<HTMLInputElement>)=>showRequired(e,"Indica la hora de salida")}/>
    </div>
    <Field label="Descanso no trabajado (minutos)" name="breakMinutes" type="number" min="0" step="1" required disabled={absent} value={breakMinutes} onChange={(e:React.ChangeEvent<HTMLInputElement>)=>setBreakMinutes(e.target.value)}/>
    <Field label="Horas extra" name="overtime" type="number" min="0" step=".25" required disabled={absent} value={overtime} onChange={(e:React.ChangeEvent<HTMLInputElement>)=>setOvertime(e.target.value)}/>
    <Field label="Horas efectivas (sin descanso)" name="effectiveHours" type="number" min="0" step="any" readOnly disabled={absent} value={worked === null || absent ? "" : String(Number(worked.toFixed(2)))}/>
    <Field label="Horas regulares (sin extras)" name="hours" type="number" min="0" step="any" required readOnly={hasSchedule || absent} value={absent ? "0" : regular === null ? "" : String(Number(regular.toFixed(2)))}/>
    {worked !== null && !absent && <p className="form-hint attendance-calculation" data-testid="text-attendance-calculation">Turno: {Number((worked + Number(breakMinutes)/60).toFixed(2))} h − descanso: {Number((Number(breakMinutes)/60).toFixed(2))} h = {Number(worked.toFixed(2))} h efectivas. De ellas, {Number(regular!.toFixed(2))} h regulares y {Number(Number(overtime).toFixed(2))} h extra. El descanso se descuenta una sola vez.</p>}
    <Field label="Bono USD" name="bonus" type="number" min="0" step=".01" required value={bonus} onChange={(e:React.ChangeEvent<HTMLInputElement>)=>setBonus(e.target.value)} readOnly={absent}/>
  </div>
  {!absent && <section className="attendance-allocation" aria-label="Distribución por proyectos">
    <div className="allocation-head"><div><strong>Distribuir jornada entre proyectos</strong><small>El proyecto principal recibe el remanente: {Math.max(0,primaryRegular).toFixed(2)} h regulares y {Math.max(0,primaryOvertime).toFixed(2)} h extra.</small></div><button type="button" className="btn outline" onClick={()=>setSplits(v=>[...v,{projectName:"",regularHours:"",overtimeHours:""}])} disabled={splits.length>=11} data-testid="button-add-project-split"><Plus size={15}/> Otro proyecto</button></div>
    {splits.map((split,i)=><div className="allocation-row" key={i}><label className="field"><span>Otro proyecto {i+1}</span><input required list="attendance-projects" maxLength={160} value={split.projectName} onChange={e=>setSplits(v=>v.map((x,j)=>j===i?{...x,projectName:e.target.value}:x))} data-testid={`input-split-project-${i}`}/></label><label className="field"><span>Horas regulares</span><input required type="number" min="0" max="24" step="any" value={split.regularHours} onChange={e=>setSplits(v=>v.map((x,j)=>j===i?{...x,regularHours:e.target.value}:x))} data-testid={`input-split-regular-${i}`}/></label><label className="field"><span>Horas extra</span><input required type="number" min="0" max="24" step="any" value={split.overtimeHours} onChange={e=>setSplits(v=>v.map((x,j)=>j===i?{...x,overtimeHours:e.target.value}:x))} data-testid={`input-split-extra-${i}`}/></label><button type="button" className="table-action" onClick={()=>setSplits(v=>v.filter((_,j)=>j!==i))} data-testid={`button-remove-split-${i}`}>Quitar</button></div>)}
    {(primaryRegular<-.0001||primaryOvertime<-.0001)&&<p className="feedback error" role="alert">Las horas repartidas exceden las horas efectivas de la jornada.</p>}
    <input type="hidden" name="allocations" value={JSON.stringify([{projectName:project,regularHours:Math.max(0,primaryRegular),overtimeHours:Math.max(0,primaryOvertime)},...splits.map(p=>({projectName:p.projectName,regularHours:Number(p.regularHours),overtimeHours:Number(p.overtimeHours)}))])}/>
    <small>Si no agregas otra obra, toda la jornada queda en la principal. El bono se atribuye al proyecto principal.</small>
  </section>}
  {calculationError && !absent && <p className="feedback error" role="alert">{calculationError}</p>}
  <label className="check-field"><input name="absent" type="checkbox" checked={absent} onChange={e=>{const marked=e.target.checked;setAbsent(marked);if(marked){setTimeIn("");setTimeOut("");setBreakMinutes("0");setOvertime("0");setBonus("0");}onValidationInput();}}/> Marcar ausencia (sin horas ni bono)</label>
  <Field label="Observación" name="note" defaultValue={a?.note}/>
  <p className="form-hint">Proyecto o ubicación y responsable son obligatorios. Si hubo jornada, indica entrada y salida; las horas efectivas descuentan el descanso y se dividen entre regulares y extras. En una ausencia, las horas quedan vacías y el bono en cero. Un registro de esa persona y fecha se actualizará.</p></>;
}
function FixedOvertimeControl({person,busy,onSave}:{person:any;busy:boolean;onSave:(personId:number,enabled:boolean,rate:number|null)=>void}) {
  const [enabled,setEnabled]=useState(!!person.overtimeEnabled);
  const [rate,setRate]=useState(person.overtimeRate == null ? "" : String(person.overtimeRate));
  return <form className="payroll-rule-row" onSubmit={e=>{e.preventDefault();onSave(person.id,enabled,enabled ? Number(rate) : null);}}>
    <div><b>{person.name}</b><small>Horas extra con sueldo fijo</small></div>
    <label className="field"><span>Decisión de Gerencia</span><select value={enabled?"pay":"record"} onChange={e=>setEnabled(e.target.value==="pay")} data-testid={`select-fixed-overtime-${person.id}`}><option value="record">Solo registrar, sin pago</option><option value="pay">Pagar adicional</option></select></label>
    <Field label="Tarifa extra USD/h" name="rate" type="number" min=".01" step=".01" required={enabled} disabled={!enabled} value={rate} onChange={(e:React.ChangeEvent<HTMLInputElement>)=>setRate(e.target.value)}/>
    <button type="submit" className="btn outline" disabled={busy} data-testid={`button-save-fixed-overtime-${person.id}`}>Autorizar regla</button>
  </form>;
}
function Empty({title,description,action,onClick}:any) {
  return <div className="empty"><FileText size={31} strokeWidth={1.4}/><h3>{title}</h3><p>{description}</p>{action && <button className="btn primary" onClick={onClick}>{action}<ArrowRight size={15}/></button>}</div>;
}
function Badge({value}: {value:string}) { return <span className={`badge ${value === "aprobado" || value === "Pagado" ? "good":value === "revisado" || value === "Pendiente" ? "warm":""}`}>{value}</span>; }
function AuthGate() {
  const {data:session,isLoading,isError:sessionError,refetch}=useQuery<{user:User;offline?:boolean}|null>({queryKey:["/api/auth/me"],queryFn:async()=>{
    try{return await (await apiRequest("GET","/api/auth/me")).json();}
    catch(e){
      if(String(e).startsWith("Error: 401:"))return null;
      if(!navigator.onLine){const saved=await loadLocal<{user:User}>("session").catch(()=>undefined);if(saved?.user?.role==="produccion")return {...saved,offline:true};}
      throw e;
    }
  }});
  const {data:status,isError:statusError,refetch:retryStatus}=useQuery<{hasUsers:boolean;setupAvailable:boolean;demoAccess:boolean;demoRoles:User["role"][];personnelIntake?:boolean}>({queryKey:["/api/auth/status"],queryFn:async()=>{
    try{return await (await apiRequest("GET","/api/auth/status")).json();}
    catch(e){
      if(!navigator.onLine && (await loadLocal<{user:User}>("session").catch(()=>undefined))?.user?.role==="produccion")
        return {hasUsers:true,setupAvailable:false,demoAccess:false,demoRoles:[],personnelIntake:true};
      throw e;
    }
  }});
  const [error,setError]=useState("");
  const [busy,setBusy]=useState(false);
  const [unlocked,setUnlocked]=useState(false);
  const invite=new URLSearchParams(location.search).get("invite");
  async function submit(e:React.FormEvent<HTMLFormElement>) {
    e.preventDefault();setError("");setBusy(true);
    const f=new FormData(e.currentTarget);
    const url=invite?"/api/auth/accept":status?.hasUsers?"/api/auth/login":"/api/auth/setup";
    try {
      const response=await apiRequest("POST",url,invite
        ? {inviteToken:invite,password:f.get("password")}
        : {username:f.get("username"),password:f.get("password"),...(url.endsWith("setup")?{setupToken:f.get("setupToken")}:{})});
      const result=await response.json();
      setAuthToken(result.token);
      if(result.user.role==="produccion") {
        await unlockOffline(result.user.id,String(f.get("password")),true);
        await saveLocal("session",{user:result.user});
        setUnlocked(true);
      } else await removeLocal("session").catch(()=>{});
      queryClient.removeQueries({queryKey:["/api/state"]});await refetch();
      if(invite)history.replaceState(null,"",location.pathname+location.hash);
    } catch(e:any) {setError(e.message || "No se pudo iniciar sesión");} finally {setBusy(false);}
  }
  async function unlockSession(e:React.FormEvent<HTMLFormElement>) {
    e.preventDefault();setError("");setBusy(true);
    const pin=String(new FormData(e.currentTarget).get("pin")||"");
    try {
      if(!session?.offline) {
        const check=await (await apiRequest("POST","/api/auth/login",{username:session?.user.email,password:pin})).json();
        setAuthToken(check.token);
      }
      await unlockOffline(session!.user.id,pin,false);setUnlocked(true);
    } catch(e:any) {setError(e.message||"No se pudo abrir la copia cifrada.");}
    finally {setBusy(false);}
  }
  if (isLoading) return <div className="auth-page"><div className="auth-card"><p>Cargando acceso seguro…</p></div></div>;
  if (sessionError || statusError) return <div className="auth-page"><div className="auth-card"><h1>Sin conexión al servidor</h1><p>La carga de empleados requiere conexión. Si ya activaste la copia local de Producción, desconecta el dispositivo y reintenta para registrar asistencia.</p><button className="btn primary wide" type="button" onClick={()=>{refetch();retryStatus();}}>Reintentar conexión</button></div></div>;
  if (!status) return <div className="auth-page"><div className="auth-card"><p>Verificando el modo de operación…</p></div></div>;
  if(session?.user?.role==="produccion" && (!unlocked || !offlineUnlocked(session.user.id)))
    return <div className="auth-page"><section className="auth-card"><h1>Desbloquear asistencia local</h1><p>{session.offline?"Sin conexión. Ingresa tu contraseña personal para abrir la copia cifrada de este dispositivo.":"Ingresa tu contraseña para habilitar la copia local de Producción."}</p><form onSubmit={unlockSession}><Field label="Contraseña de Producción" name="pin" type="password" required minLength={status.personnelIntake?12:4}/>{error&&<div className="feedback error" role="alert">{error}</div>}<button className="btn primary wide" disabled={busy}>{busy?"Comprobando…":"Desbloquear"}</button></form><small>La copia local solo incluye nombres mínimos y asistencia. Se cifra en este dispositivo; nómina y pagos permanecen bloqueados.</small></section></div>;
  if(session?.user) return <AppBody user={session.user} personnelIntake={!!status?.personnelIntake} offlineSession={!!session.offline} onLogout={async()=>{if(navigator.onLine)await apiRequest("POST","/api/auth/logout").catch(()=>{});await removeLocal("session").catch(()=>{});lockOffline();setUnlocked(false);setAuthToken("");queryClient.clear();await refetch();}}/>;
  return <div className="auth-page"><section className="auth-card">
    <div className="brand"><svg aria-label="ONEFIX" viewBox="0 0 40 40" width="38" height="38" fill="none"><path d="M20 3L35 12V28L20 37L5 28V12L20 3Z" stroke="currentColor" strokeWidth="2.5"/><path d="M12 20H28M20 12V28" stroke="currentColor" strokeWidth="3.5"/></svg><span><strong>ONEFIX</strong><small>OPERACIONES</small></span></div>
    <span className="eyebrow">CENTRO DE NÓMINA · {status?.personnelIntake?"OPERACIÓN REAL":"BETA"}</span>
    <h1>{invite?"Aceptar invitación":status?.hasUsers?"Iniciar sesión":"Instalación inicial"}</h1>
    <p>{invite?"Crea tu clave personal de al menos 12 caracteres.":status?.hasUsers?"Acceso limitado al equipo de Producción, Administración y Gerencia.":"Gerencia crea la primera cuenta; después invita al resto del equipo."}</p>
    {!invite&&status?.demoAccess&&<div className="demo-access-note"><strong>Accesos de prueba por área</strong><div className="demo-role-list">{(["gerencia","administracion","produccion"] as const).filter(role=>status.demoRoles.includes(role)).map(role=><div key={role}><span>{role==="gerencia"?"Gerencia":role==="administracion"?"Administración":"Producción"}</span><code>{role}</code></div>)}</div><small>Ingresa la clave de cuatro dígitos asignada a tu área. Solo datos ficticios; no utilizar con nóminas reales.</small></div>}
    {!status?.hasUsers&&!invite&&!status?.setupAvailable?<div className="feedback error">Falta configurar el código de instalación en el servidor. No hay acceso público.</div>:
      <form onSubmit={submit}>
        {!invite&&<Field label="Usuario" name="username" required placeholder="gerencia" autoComplete="username"/>}
        <Field label={status?.demoAccess&&status.hasUsers?"Clave":"Contraseña (mínimo 12 caracteres)"} name="password" type="password" required minLength={status?.demoAccess&&status.hasUsers?4:12}/>
        {!status?.hasUsers&&!invite&&<Field label="Código privado de instalación" name="setupToken" type="password" required/>}
        {error&&<div className="feedback error" role="alert">{error}</div>}
        <button className="btn primary wide" type="submit" disabled={busy} data-testid="button-auth">{busy?"Verificando…":invite?"Activar cuenta":status?.hasUsers?"Entrar":"Crear cuenta de Gerencia"}</button>
      </form>}
    <small>{status?.personnelIntake?"Fichas reales solo con conexión. Producción puede registrar asistencia; nómina, jornales y pagos siguen bloqueados.":"Solo datos ficticios durante esta beta. No usar para pagos reales."}</small>
  </section></div>;
}
function AppBody({user,onLogout,offlineSession,personnelIntake}:{user:User;onLogout:()=>Promise<void>;offlineSession:boolean;personnelIntake:boolean}) {
  const loadingDay = initialLoadOnly();
  const [tab,setTab] = useState<Tab>(personnelIntake ? user.role==="gerencia"?"accesos":user.role==="produccion"?"produccion":"personas" : loadingDay && user.role!=="gerencia" ? "personas" :user.role==="produccion"?"produccion":"inicio");
  const [modal,setModal] = useState<Modal>(null);
  const [chosen,setChosen] = useState<number|null>(null);
  const [personPayType,setPersonPayType] = useState("");
  const [dark,setDark] = useState(window.matchMedia("(prefers-color-scheme: dark)").matches);
  const [mobileMenu,setMobileMenu] = useState(false);
  const [error,setError] = useState("");
  const [success,setSuccess] = useState("");
  const [busy,setBusy] = useState(false);
  const [reviewNotes,setReviewNotes] = useState<Record<number,string>>({});
  const [reviewFilter,setReviewFilter] = useState<Record<number,"all"|"pending">>({});
  const [lineObservations,setLineObservations] = useState<Record<number,string>>({});
  const [managerConfirmed,setManagerConfirmed] = useState<number|null>(null);
  const [week,setWeek] = useState(()=>latestReadySaturday(day()));
  const selectedPeriod = (()=>{try{return payrollPeriod(week);}catch{return null;}})();
  const [inviteResult,setInviteResult]=useState("");
  const [offline,setOffline]=useState(offlineSession || !navigator.onLine);
  const [queue,setQueue]=useState<QueuedPayment[]>([]);
  const [attendanceQueue,setAttendanceQueue]=useState<QueuedAttendance[]>([]);
  const syncingAttendance=useRef(false);
  const [attendanceVersions,setAttendanceVersions]=useState<Record<string,number>>({});
  const production=user.role==="produccion",admin=user.role==="administracion",manager=user.role==="gerencia";
  const {data:users=[]}=useQuery<User[]>({queryKey:["/api/auth/users"],enabled:manager});
  const visibleNav=nav.filter(n=>n.key==="seguimiento"||n.key==="cobros" ? !production : personnelIntake ? manager?n.key==="personas":production?n.key==="produccion"||(!offline&&n.key==="personas"):["personas","produccion"].includes(n.key) : loadingDay ? !manager&&n.key==="personas" : production?["personas","produccion"].includes(n.key):manager?["inicio","obras","nomina"].includes(n.key):true);
  const {data:s,isLoading,isError,refetch:retryState} = useQuery<State>({queryKey:["/api/state",user.id],retry:(failureCount,error)=>failureCount<2 && /(?:^|\s)503:/.test(String(error)),retryDelay:attempt=>Math.min(1000*2**attempt,3000),queryFn:async()=>{
    try {
      const state=await (await apiRequest("GET","/api/state")).json() as State;
      removeLocal(`state-${user.id}`).catch(()=>{});
      if(production) {
        const minimal:State={people:state.people.filter(p=>p.kind==="empleado").map(p=>({id:p.id,name:p.name,kind:p.kind,payType:p.payType,active:p.active})),
          projects:state.projects.map(p=>({id:p.id,name:p.name})),attendance:state.attendance,
          attendanceConflicts:[],contracts:[],tasks:[],dailyPays:[],deductions:[],payrolls:[],amendments:[],absenceAdjustments:[]};
        await saveEncrypted(user.id,"state",minimal);
      }
      setOffline(false);return state;
    } catch(e) {
      if(String(e).startsWith("Error: 401:"))throw e;
      const cached=production?await loadEncrypted<State>(user.id,"state").catch(()=>undefined):undefined;
      if(cached){setOffline(true);return cached;}throw e;
    }
  }});
  const fixedAbsences = selectedPeriod ? (s?.people || []).filter(p=>p.kind==="empleado"&&p.payType==="fijo"&&p.active)
    .map(p=>({person:p,count:(s?.attendance || []).filter(a=>a.personId===p.id&&a.absent&&a.date>=week&&a.date<=selectedPeriod.weekEnd).length}))
    .filter(entry=>entry.count>0) : [];
  const missingAbsenceAmounts = fixedAbsences.filter(({person})=>!(s?.absenceAdjustments || []).some(a=>a.personId===person.id&&a.weekStart===week));
  useEffect(()=>{
    const update=()=>{setOffline(!navigator.onLine);if(personnelIntake && !production && !navigator.onLine){setModal(null);queryClient.removeQueries({queryKey:["/api/state",user.id]});}};
    const reconnect=()=>{
      update();
      queryClient.invalidateQueries({queryKey:["/api/auth/me"]}).then(()=>{
        const verified=queryClient.getQueryData<{user:User}|null>(["/api/auth/me"]);
        if(verified?.user?.id===user.id){
          queryClient.invalidateQueries({queryKey:["/api/state"]});
          if(production)syncAttendance().catch(()=>{});
        }
      }).catch(()=>{});
    };
    window.addEventListener("online",reconnect);window.addEventListener("offline",update);
    if(!personnelIntake)listPayments().then(items=>setQueue(items.filter(p=>p.userId===user.id))).catch(()=>{});
    if(production)listAttendance(user.id).then(items=>{setAttendanceQueue(items);if(navigator.onLine)syncAttendance().catch(()=>{});}).catch(()=>{});
    if(!previewOnly&&production&&"serviceWorker" in navigator) navigator.serviceWorker.register(new URL("sw.js",document.baseURI)).catch(()=>{});
    return ()=>{window.removeEventListener("online",reconnect);window.removeEventListener("offline",update);};
  },[user.id]);
  const people = s?.people || [], projects = s?.projects || [], contracts = s?.contracts || [], tasks = s?.tasks || [], payrolls = s?.payrolls || [], deductions = s?.deductions || [], attendance = s?.attendance || [], dailyPays = s?.dailyPays || [];
  const personName = (personId:number) => people.find(p=>p.id===personId)?.name || `#${personId}`;
  const projectName = (projectId:number) => projects.find(p=>p.id===projectId)?.name || `#${projectId}`;
  const activePayroll = payrolls[0];
  const pending = tasks.filter(t=>!t.approved).length;
  const weeklyGross = activePayroll?.lines.reduce((v,l)=>v+l.gross,0) || 0;
  const weeklyNet = activePayroll?.lines.reduce((v,l)=>v+l.net,0) || 0;
  const outstanding = deductions.reduce((v,d)=>v+Math.max(0,d.amount-d.applied),0);
  const setTheme = () => { const next = !dark; setDark(next); document.documentElement.setAttribute("data-theme",next?"dark":"light"); };
  if (document.documentElement.getAttribute("data-theme") !== (dark?"dark":"light")) document.documentElement.setAttribute("data-theme",dark?"dark":"light");
  async function syncAttendance() {
    if(!production || !navigator.onLine || syncingAttendance.current)return;
    syncingAttendance.current=true;
    try {
      for(const item of await listAttendance(user.id)) {
        try {
          if(item.status==="review") {
            const status=await (await apiRequest("GET",`/api/attendance/conflicts/${item.operationId}`)).json();
            if(status.status!=="pending")await removeAttendance(user.id,item.operationId);
            continue;
          }
          const expired=Date.now()-Date.parse(item.savedAt)>=7*24*60*60_000;
          if(!expired) {
            try {
              await apiRequest("POST","/api/attendance",{...item.proposed,expectedRevision:item.expectedRevision});
              await removeAttendance(user.id,item.operationId);
              continue;
            } catch(e:any) {if(!String(e.message).startsWith("409:"))throw e;}
          }
          const result=await (await apiRequest("POST","/api/attendance/conflicts",{operationId:item.operationId,expectedRevision:item.expectedRevision,proposed:item.proposed,expired,savedAt:item.savedAt})).json();
          await queueAttendance({...item,status:"review",message:expired?"Fuera de plazo: requiere revisión de Administración.":`En revisión por Administración (${result.status}).`});
        } catch(e:any) {
          await queueAttendance({...item,message:"No se pudo confirmar el envío. Reintenta al recuperar conexión."});
          setError(String(e.message).startsWith("401:")?"La sesión del servidor caducó. Conéctate e inicia sesión de nuevo antes de sincronizar. Las asistencias locales siguen cifradas en este dispositivo.":"Hay asistencias locales sin confirmar. No se descartaron; verifica la conexión y vuelve a sincronizar.");
          break;
        }
      }
      setAttendanceQueue(await listAttendance(user.id));
      await queryClient.invalidateQueries({queryKey:["/api/state"]});
    } finally {syncingAttendance.current=false;}
  }
  async function recordPayment(lineId:number,method:string,reference:string) {
    if(offline || !navigator.onLine) {
      setError("Para registrar un pago debes tener conexión y confirmación del servidor. No se guardó ningún pago local.");
      return;
    }
    if(!previewOnly) {
      try {
        if((await listPayments()).some(p=>p.userId===user.id&&p.lineId===lineId)){
          setError("Este recibo tiene un intento local anterior. Verifica su estado con Administración antes de registrar otro pago.");
          return;
        }
      } catch {
        setError("No se pudo consultar el almacenamiento de este dispositivo. El pago no se registró.");
        return;
      }
    }
    const payment:QueuedPayment={operationId:crypto.randomUUID(),lineId,method,reference,recordedAt:new Date().toISOString(),userId:user.id,status:"pending"};
    setBusy(true);setError("");setSuccess("");
    try {
      const result=await (await apiRequest("POST","/api/sync/payments",{items:[payment]})).json();
      const item=result.results?.[0];
      if(item?.status!=="synced") throw new Error(item?.message || "Pago no confirmado. Consulta el listado antes de repetir.");
      setModal(null);setChosen(null);setOffline(false);
      setSuccess("Pago confirmado en el servidor.");
      await queryClient.invalidateQueries({queryKey:["/api/state"]});
    } catch(e:any) {
      setError(`${e.message || "No se pudo confirmar el pago"}. Consulta el listado antes de repetir: la respuesta pudo haberse interrumpido después de registrarlo.`);
    } finally {setBusy(false);}
  }
  async function send(path:string,payload?:any) {
    setBusy(true); setError(""); setSuccess("");
    try {
      const response = await apiRequest("POST",path,payload);
      await response.json();
      await queryClient.invalidateQueries({queryKey:["/api/state"]});
      setSuccess("Cambios guardados correctamente.");
      setModal(null); setChosen(null);
      return true;
    } catch(e:any) { let text = e.message || "Error"; try { text = JSON.parse(text.slice(text.indexOf("{"))).error || text; } catch {} setError(text); return false; }
    finally { setBusy(false); }
  }
  async function removeDailyPay(dailyId:number) {
    setBusy(true);setError("");setSuccess("");
    try {
      await apiRequest("DELETE",`/api/daily-pay/${dailyId}`);
      await queryClient.invalidateQueries({queryKey:["/api/state"]});
      setSuccess("Jornal retirado. Las horas regulares volverán a calcularse con la tarifa por hora.");
      setModal(null);setChosen(null);
    } catch(e:any) { let text=e.message||"Error"; try{text=JSON.parse(text.slice(text.indexOf("{"))).error||text;}catch{} setError(text); }
    finally {setBusy(false);}
  }
  function open(type:Modal,value?:number) { setChosen(value ?? null);setError("");setSuccess("");if(type==="asistencia")setAttendanceVersions(Object.fromEntries(attendance.map(a=>[`${a.personId}:${a.date}`,a.revision ?? 1])));if(type==="persona"||type==="editarPersona")setPersonPayType(value ? people.find(p=>p.id===value)?.payType || "" : "");setModal(type); }
  function formSubmit(e:React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    if (modal === "persona" || modal === "editarPersona") {
      const original=modal==="editarPersona"?people.find(p=>p.id===chosen):null;
      const overtimeRate=personPayType==="fijo" ? (original?.payType==="fijo" ? original.overtimeRate : null) : f.get("overtimeRate") === "" ? null:number(f.get("overtimeRate"));
      return send(modal==="persona"?"/api/people":`/api/people/${chosen}`,{name:f.get("name"),kind:f.get("kind"),jobTitle:f.get("jobTitle"),document:f.get("document"),phone:f.get("phone"),email:f.get("email"),bank:f.get("bank"),account:f.get("account"),payType:f.get("payType"),rate:number(f.get("rate")),overtimeRate,active:true});
    }
    if (modal === "obra") return send("/api/projects",{name:f.get("name"),address:f.get("address")});
    if (modal === "contrato") return send("/api/contracts",{number:f.get("number"),personId:id(f.get("personId")),projectId:id(f.get("projectId")),description:f.get("description"),amount:number(f.get("amount")),date:f.get("date"),notes:f.get("notes")});
    if (modal === "tarea") return send("/api/tasks",{personId:id(f.get("personId")),projectId:id(f.get("projectId")),contractId:f.get("contractId")?id(f.get("contractId")):null,description:f.get("description"),amount:number(f.get("amount")),date:f.get("date"),approved:false});
    if (modal === "jornal" && chosen) return send("/api/daily-pay",{attendanceId:chosen,proposedAmount:number(f.get("proposedAmount")),note:f.get("note")});
    if (modal === "asistencia") {
      const projectName=String(f.get("projectName") || "").trim();
      const responsible=String(f.get("responsible") || "").trim();
      const absent=f.get("absent")==="on";
      const timeIn=String(f.get("timeIn") || ""), timeOut=String(f.get("timeOut") || "");
      const missing=[!projectName&&["projectName","Indica el proyecto o ubicación"],!responsible&&["responsible","Indica el responsable de la asistencia"],!absent&&!timeIn&&["timeIn","Indica la hora de entrada"],!absent&&!timeOut&&["timeOut","Indica la hora de salida"]].find(Boolean) as [string,string]|undefined;
      if (missing) {
        setError(missing[1]);
        (e.currentTarget.elements.namedItem(missing[0]) as HTMLInputElement)?.focus();
        return;
      }
      const allocations=absent?[]:JSON.parse(String(f.get("allocations")||"[]"));
      if (!absent && allocations.some((p:any)=>!p.projectName?.trim() || !Number.isFinite(p.regularHours) || !Number.isFinite(p.overtimeHours) || p.regularHours<-.0001 || p.overtimeHours<-.0001 || p.regularHours+p.overtimeHours<=0)) {
        setError("Cada proyecto debe tener nombre y horas válidas. No repartas más horas que las trabajadas.");
        return;
      }
      const personId=id(f.get("personId")), date=String(f.get("date") || "");
      const expectedRevision=attendanceVersions[`${personId}:${date}`] ?? 0;
      const proposed={personId,date,projectName,responsible,timeIn,timeOut,breakMinutes:number(f.get("breakMinutes")),hours:number(f.get("hours")),overtime:number(f.get("overtime")),allocations,absent,bonus:number(f.get("bonus")),note:String(f.get("note")||"")};
      if(offline || !navigator.onLine) {
        if(attendanceQueue.some(x=>x.proposed.personId===personId&&x.proposed.date===date)) {
          setError("Ya hay una asistencia local para esta persona y fecha. Sincronízala o espera la revisión antes de volver a registrarla.");return;
        }
        const item:QueuedAttendance={operationId:crypto.randomUUID(),userId:user.id,expectedRevision,proposed,savedAt:new Date().toISOString(),status:"pending"};
        queueAttendance(item).then(async()=>{setAttendanceQueue(await listAttendance(user.id));setModal(null);setSuccess("Asistencia guardada en este dispositivo. Aún no está confirmada en el servidor ni cuenta para nómina.");}).catch(()=>setError("No se pudo guardar la asistencia local. No cierres el formulario."));
        return;
      }
      return send("/api/attendance",{...proposed,expectedRevision});
    }
    if (modal === "ampliacion") return send(`/api/contracts/${chosen}/amend`,{delta:number(f.get("delta")),note:f.get("note")});
    if (modal === "pago" && chosen) return recordPayment(chosen,String(f.get("method")||""),String(f.get("reference")||""));
  }
  async function deductionSubmit(e:React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget);const file = f.get("photo") as File;
    if (file?.size > 1_400_000) {setError("La foto debe pesar menos de 1,4 MB"); return;}
    const photo = file?.size ? await new Promise<string>((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(String(r.result));r.onerror=reject;r.readAsDataURL(file);}) : null;
    send("/api/deductions",{personId:id(f.get("personId")),kind:f.get("kind"),amount:number(f.get("amount")),date:f.get("date"),note:f.get("note"),manager:f.get("manager"),photo});
  }
  async function download(path:string) {
    try {
      const response=await apiRequest("GET",path);
      const blob=await response.blob();
      const objectUrl=URL.createObjectURL(blob);
      const anchor=document.createElement("a");
      anchor.href=objectUrl;
      anchor.download=response.headers.get("Content-Disposition")?.match(/filename="([^"]+)"/)?.[1] || (path.endsWith("/photo")?"soporte-onefix.jpg":"reporte-onefix.pdf");
      anchor.click();
      setTimeout(()=>URL.revokeObjectURL(objectUrl),60_000);
    } catch(e:any){setError(e.message||"No se pudo abrir el archivo");}
  }
  const pdfLink=(path:string,label:string)=> <button className="btn outline" onClick={()=>download(path)} data-testid={`link-${label.replaceAll(" ","-")}`}><ArrowDownToLine size={15}/>{label}</button>;
  const title = nav.find(n=>n.key===tab)?.label || "Accesos";
  return <div className="app-shell">
    <a href="#main" className="skip">Saltar al contenido</a>
    <aside className={`sidebar ${mobileMenu?"visible":""}`}>
      <button className="sidebar-close" type="button" aria-label="Cerrar menú" onClick={()=>setMobileMenu(false)}><X size={20}/></button>
      <div className="brand"><svg aria-label="ONEFIX" viewBox="0 0 40 40" width="38" height="38" fill="none"><path d="M20 3L35 12V28L20 37L5 28V12L20 3Z" stroke="currentColor" strokeWidth="2.5"/><path d="M12 20H28M20 12V28" stroke="currentColor" strokeWidth="3.5" strokeLinecap="square"/></svg><span><strong>ONEFIX</strong><small>OPERACIONES</small></span></div>
      <div className="sidebar-label">ESPACIO DE TRABAJO</div>
      <nav aria-label="Navegación principal">{visibleNav.map(n=><button key={n.key} className={`nav-item ${tab===n.key?"selected":""}`} onClick={()=>{setTab(n.key);setMobileMenu(false);setError("");setSuccess("");}} data-testid={`nav-${n.key}`}><n.icon size={18}/>{n.label}{tab===n.key&&<span className="nav-marker"/>}</button>)}{manager&&<button className={`nav-item ${tab==="accesos"?"selected":""}`} onClick={()=>setTab("accesos" as Tab)} data-testid="nav-accesos"><Users size={18}/>Accesos</button>}</nav>
      <div className="side-bottom"><div className="status-dot"/><span>{personnelIntake?"Operación real":"Versión de prueba"}<br/><small>{personnelIntake?"Nómina y pagos bloqueados":"Datos en el servidor de vista previa"}</small></span></div>
    </aside>
    <div className="workspace">
      <header className="topbar"><div className="top-left"><button className="menu-button" aria-label="Abrir menú" onClick={()=>setMobileMenu(!mobileMenu)}><Menu size={20}/></button><span className="crumb">ONEFIX / <strong>{title}</strong></span></div><div className="top-actions"><span className="preview-chip">{user.role.toUpperCase()} · {user.email}</span><button className="icon-button" aria-label="Cambiar tema" onClick={setTheme} data-testid="button-theme">{dark?<Sun size={19}/>:<Moon size={19}/>}</button><button className="btn quiet" onClick={onLogout} data-testid="button-logout">Salir</button></div></header>
      <main id="main" className="main">
        <div className="content">
        <div className="page-heading"><div><span className="eyebrow">{tab==="cobros"?"COBROS · USD":personnelIntake?"EMPLEADOS Y ASISTENCIA · USD":"CONTROL SEMANAL · USD"}</span><h1>{tab==="inicio"?"Centro de nómina":title}</h1><p>{tab==="inicio"?"Una vista clara de lo que está pendiente, aprobado y pagado.": tab==="nomina"?"De sábado a viernes; disponible para envío desde el domingo siguiente. Revisión antes de aprobación.":tab==="produccion"?personnelIntake?"Registro diario de asistencia; nómina y pagos todavía no están habilitados.":"Asistencia, tareas y avances en una sola vista.":tab==="personas"?personnelIntake?"Fichas de empleados para la operación real, disponibles únicamente con conexión.":"Empleados y subcontratistas desde una ficha única.":tab==="obras"?"Obras, contratos y ampliaciones autorizadas.":tab==="seguimiento"?"Registro privado de valores, abonos, descuentos, saldos y observaciones.":tab==="cobros"?"Facturas, saldos informados y fechas de vencimiento definidas manualmente.":tab==="accesos"?"Invitaciones privadas para el equipo de tres roles.":"Anticipos, préstamos y daños documentados."}</p></div><div className="heading-action">
          {(admin||production)&&tab==="personas" && <button className="btn primary" disabled={personnelIntake&&offline} onClick={()=>open("persona")}><Plus size={17}/> {personnelIntake||production?"Nuevo empleado":"Nueva persona"}</button>}
          {admin&&tab==="obras" && <button className="btn primary" onClick={()=>open("contrato")} disabled={!people.length||!projects.length}><Plus size={17}/> Nuevo contrato</button>}
          {production&&!personnelIntake&&tab==="produccion" && <button className="btn primary" onClick={()=>open("tarea")} disabled={!people.length||!projects.length}><Plus size={17}/> Nueva tarea</button>}
          {admin&&tab==="descuentos" && <button className="btn primary" onClick={()=>open("descuento")} disabled={!people.length}><Plus size={17}/> Nuevo descuento</button>}
        </div></div>
        {tab!=="seguimiento"&&tab!=="cobros"&&<div className="scope-note"><Activity size={16}/><span>{personnelIntake?"Producción registra asistencia con proyecto, responsable y horas efectivas; puede guardar una copia cifrada sin conexión tras iniciar sesión en este dispositivo. Administración resuelve conflictos al reconectar. Las fichas se editan solo en línea. Nómina, jornales y pagos siguen bloqueados; Drive y WhatsApp no están conectados.":`${loadingDay?"Hasta el 26/09/2026 solo se permite preparar y corregir las fichas de personal. La asistencia, nómina y pagos se habilitan mañana. ":""}Esta beta usa datos ficticios. Producción puede guardar asistencia local mínima para sincronizar al reconectar; Administración decide conflictos. Los pagos requieren conexión. El almacenamiento local todavía no protege datos reales. Drive y WhatsApp aún no están disponibles. No usar para pagos reales.`}</span></div>}
        {production&&attendanceQueue.length>0&&<section className="panel sync-panel" data-testid="attendance-pending"><div className="panel-head"><div><h2>Asistencias de este dispositivo</h2><p>Una asistencia pendiente no entra en nómina hasta confirmarse en el servidor. Pasados siete días requiere revisión de Administración y nunca se borra sola.</p></div><button className="btn outline" disabled={offline||busy} onClick={()=>syncAttendance().catch(()=>setError("No se pudieron sincronizar las asistencias."))}>Sincronizar asistencia</button></div><div className="row-list">{attendanceQueue.map(item=><div className="list-row" key={item.operationId}><div className="row-main"><b>{personName(Number(item.proposed.personId))} · {String(item.proposed.date)} · {String(item.proposed.projectName)}</b><small>{item.status==="review"?"En revisión por Administración":Date.now()-Date.parse(item.savedAt)>=7*24*60*60_000?"Venció el plazo de 7 días: requiere revisión":"Pendiente de enviar"}{item.message?` · ${item.message}`:""}</small></div></div>)}</div></section>}
        {admin&&tab==="produccion"&&(s?.attendanceConflicts?.length ?? 0)>0&&<section className="panel sync-panel attendance-conflicts" data-testid="attendance-conflicts"><div className="panel-head"><div><h2>Conflictos de asistencia</h2><p>Compara la versión vigente con la propuesta enviada por Producción. Una decisión se registra para auditoría.</p></div></div><div className="row-list">{s!.attendanceConflicts.map(c=><div className="list-row" key={c.operationId}><div className="row-main"><b>{c.personName} · {c.date}{c.reason==="expired"?" · Fuera de plazo (7 días)":""}</b><small><strong>Vigente:</strong> {c.currentProject||"Sin registro"} · {c.currentAbsent?"Ausencia":`${c.currentTimeIn||"—"} a ${c.currentTimeOut||"—"}`} · Responsable: {c.currentResponsible||"—"} · revisión {c.currentRevision} · {c.currentHours??0} h regulares · {c.currentOvertime??0} h extra · descanso {c.currentBreakMinutes??0} min · bono {usd(c.currentBonus??0)} · {c.currentNote||"Sin nota"}</small><small>Proyectos vigentes: {(c.currentAllocations?.length?c.currentAllocations:[{projectName:c.currentProject||"Sin registro",regularHours:c.currentHours??0,overtimeHours:c.currentOvertime??0}]).map((x:any)=>`${x.projectName} (${x.regularHours} h + ${x.overtimeHours} h extra)`).join("; ")}</small><small><strong>Propuesta:</strong> {c.proposed.projectName} · {c.proposed.absent?"Ausencia":`${c.proposed.timeIn||"—"} a ${c.proposed.timeOut||"—"}`} · Responsable: {c.proposed.responsible} · {c.proposed.hours} h regulares · {c.proposed.overtime} h extra · descanso {c.proposed.breakMinutes} min · bono {usd(c.proposed.bonus)} · {c.proposed.note||"Sin nota"}</small><small>Proyectos propuestos: {(c.proposed.allocations?.length?c.proposed.allocations:[{projectName:c.proposed.projectName,regularHours:c.proposed.hours,overtimeHours:c.proposed.overtime}]).map((x:any)=>`${x.projectName} (${x.regularHours} h + ${x.overtimeHours} h extra)`).join("; ")}</small><small>Enviada: {new Date(c.submittedAt).toLocaleString("es-US")}</small></div><div className="line-actions"><button className="table-action" disabled={busy} onClick={()=>send(`/api/attendance/conflicts/${c.operationId}/resolve`,{decision:"keep"})}>Conservar vigente</button><button className="table-action" disabled={busy} onClick={()=>{if(window.confirm(`¿Aceptar la asistencia propuesta para ${c.personName} el ${c.date}? Se reemplazará la versión vigente.`))send(`/api/attendance/conflicts/${c.operationId}/resolve`,{decision:"accept"});}}>Aceptar propuesta</button></div></div>)}</div></section>}
        {(offline||(!personnelIntake&&queue.length>0))&&<section className="panel sync-panel" data-testid="status-offline"><div className="panel-head"><div><h2>{offline?"Sin conexión al servidor":"Intentos locales anteriores por verificar"}</h2><p>{personnelIntake?production?"Se muestra la última copia cifrada mínima. Las asistencias guardadas aquí se enviarán al recuperar la conexión; las fichas no pueden editarse sin el servidor.":"La carga real requiere conexión. No se permite consultar ni registrar empleados sin el servidor.":offline?"Solo se muestra la última copia ficticia. No se pueden registrar pagos sin conexión.":"Estos intentos de una versión anterior no se enviarán automáticamente. Verifica cada recibo con Administración antes de descartarlos."}</p></div></div>{!personnelIntake&&<div className="row-list">{queue.map(p=><div className="list-row" key={p.operationId}><div className="row-main"><b>Recibo #{p.lineId} · {p.reference}</b><small>{p.status==="pending"?"Intento local no confirmado":`Conflicto anterior: ${p.message}`}</small></div><button className="table-action" onClick={async()=>{if(window.confirm("¿Verificaste con Administración el estado de este pago antes de retirar el intento local?")){await removePayment(p.operationId);setQueue((await listPayments()).filter(x=>x.userId===user.id));}}}>Retirar tras verificar</button></div>)}</div>}</section>}
        {error && <div role="alert" className="feedback error">{error}<button onClick={()=>setError("")} aria-label="Cerrar error"><X size={15}/></button></div>}
        {success && <div role="status" className="feedback success">{success}<button onClick={()=>setSuccess("")} aria-label="Cerrar aviso"><X size={15}/></button></div>}
        {isLoading && <div className="loading-grid"><div className="skeleton"/><div className="skeleton"/><div className="skeleton"/></div>}
        {isError && <div className="feedback error" role="alert">No se pudieron cargar los datos. Comprueba que el servidor esté disponible. <button type="button" className="table-action" onClick={()=>retryState()} data-testid="retry-state">Reintentar carga</button></div>}
        {tab==="seguimiento"&&!production&&<ContractTracking admin={admin||manager} offline={offline}/>}
        {tab==="cobros"&&!production&&<Receivables offline={offline}/>}
        {manager&&tab==="accesos"&&<section className="panel"><div className="panel-head"><div><h2>Equipo autorizado</h2><p>Gerencia administra invitaciones de un solo uso, válidas por 24 horas.</p></div></div><div className="row-list">{users.map(u=><div className="list-row" key={u.id}><div className="row-main"><b>{u.email}</b><small>{u.role}</small></div></div>)}</div><form className="access-form" onSubmit={async e=>{e.preventDefault();setError("");setInviteResult("");const f=new FormData(e.currentTarget);try{const r=await (await apiRequest("POST","/api/auth/invite",{username:f.get("username"),role:f.get("role")})).json();setInviteResult(`${location.origin}${location.pathname}?invite=${encodeURIComponent(r.inviteToken)}`);}catch(err:any){setError(err.message);}}}><Field label="Usuario" name="username" required minLength={3} maxLength={32} placeholder="administracion"/><Field label="Rol" name="role" required><option value="produccion">Producción</option><option value="administracion">Administración</option><option value="gerencia">Gerencia</option></Field><button className="btn primary" type="submit" data-testid="button-invite">Crear invitación</button></form>{inviteResult&&<div className="feedback success"><p>Comparte el enlace privado solo con la persona invitada:</p><input aria-label="Enlace de invitación" readOnly value={inviteResult} onFocus={e=>e.target.select()} data-testid="input-invite-link"/><button className="btn outline" onClick={()=>navigator.clipboard?.writeText(inviteResult)}>Copiar enlace</button></div>}</section>}
        {s && tab==="inicio" && <>
          <section className="metric-grid" aria-label="Indicadores"><article className="metric featured"><span>Neto de la última nómina</span><strong data-testid="text-net">{usd(weeklyNet)}</strong><small>{activePayroll ? `${activePayroll.weekStart} a ${activePayroll.weekEnd}`:"Sin nóminas generadas"}</small></article><article className="metric"><span>Bruto calculado</span><strong>{usd(weeklyGross)}</strong><small>Empleados y tareas aprobadas</small></article><article className="metric"><span>Tareas por aprobar</span><strong>{pending.toString().padStart(2,"0")}</strong><small>Producción pendiente</small></article><article className="metric"><span>Descuentos por recuperar</span><strong>{usd(outstanding)}</strong><small>Anticipos, préstamos y daños</small></article></section>
          <div className="overview-grid"><section className="panel"><div className="panel-head"><div><h2>Últimas nóminas</h2><p>Revisión y desembolsos</p></div><button className="text-link" onClick={()=>setTab("nomina")}>Ver todas <ArrowRight size={15}/></button></div>{payrolls.length?<div className="row-list">{payrolls.slice(0,5).map(p=><div className="list-row" key={p.id}><div className="list-icon"><CalendarDays size={18}/></div><div className="row-main"><b>Semana {p.weekStart}</b><small>{p.lines.length} personas · termina {p.weekEnd}</small></div><Badge value={p.status}/><strong>{usd(p.lines.reduce((v,l)=>v+l.net,0))}</strong></div>)}</div>:<Empty title="Todavía no hay nóminas" description="Carga personas, asistencia o tareas y genera tu primera semana." action="Ir a producción" onClick={()=>setTab("produccion")}/>}</section>
          <section className="panel next-panel"><div className="panel-head"><div><h2>Siguiente paso</h2><p>Secuencia de trabajo</p></div></div><div className="step"><span>01</span><div><b>Prepara el equipo</b><p>Registra personas y obras desde cero.</p></div><Check size={16}/></div><div className="step"><span>02</span><div><b>Carga la producción</b><p>Asistencia diaria y tareas aprobadas.</p></div><Check size={16}/></div><div className="step"><span>03</span><div><b>Revisa y aprueba</b><p>Administración revisa; Gerencia aprueba.</p></div><Check size={16}/></div><button className="btn outline wide" onClick={()=>setTab("nomina")}>Abrir nómina semanal <ArrowRight size={16}/></button></section></div>
        </>}
        {s && (!personnelIntake||!offline) && tab==="personas" && <section className="panel"><div className="panel-head"><div><h2>Directorio</h2><p>{people.length} personas registradas</p></div></div>{people.length?<div className="table-wrap"><table><thead><tr><th>Nombre</th><th>Cargo</th><th>Tipo</th><th>Tarifa</th><th>Documento</th><th>Teléfono</th><th>Banco / cuenta</th><th></th></tr></thead><tbody>{people.map(p=><tr key={p.id}><td><b>{p.name}</b><small>{p.email || "Sin correo"}</small></td><td data-testid={`text-job-title-${p.id}`}>{p.jobTitle||"Sin cargo"}</td><td><Badge value={p.kind}/></td><td>{p.rate==null?"Restringida":p.payType==="tareas"?"Por tarea":`${usd(p.rate)} / ${p.payType==="hora"?"hora":"semana"}`}</td><td>{p.document||"—"}</td><td>{p.phone||"—"}</td><td>{p.bank || "—"}<small>{p.account || ""}</small></td><td>{(!manager&&(!production||p.kind==="empleado")&&!offline)&&<button className="table-action" onClick={()=>open("editarPersona",p.id)}>Editar</button>}</td></tr>)}</tbody></table></div>:<Empty title="Tu equipo comienza aquí" description="Agrega al primer empleado. La app no trae nombres precargados." action={!manager&&!offline?"Nuevo empleado":null} onClick={()=>open("persona")}/>}</section>}
        {s && tab==="obras" && <>{admin&&<div className="section-actions"><button className="btn outline" onClick={()=>open("obra")}><Plus size={16}/> Nueva obra</button></div>}<section className="panel"><div className="panel-head"><div><h2>Obras</h2><p>Ubicaciones activas</p></div></div>{projects.length?<div className="project-grid">{projects.map(p=><div className="project-tile" key={p.id}><BriefcaseBusiness size={21}/><b>{p.name}</b><small>{p.address || "Sin dirección"}</small><span>{contracts.filter(c=>c.projectId===p.id).length} contratos</span></div>)}</div>:<Empty title="Primero registra una obra" description="Cada contrato y tarea se asociará a un proyecto." action={admin?"Nueva obra":null} onClick={()=>open("obra")}/>}</section><section className="panel"><div className="panel-head"><div><h2>Seguimiento de contratos</h2><p>Saldo de alcance = autorizado menos tareas confirmadas. Descuentos personales no se imputan a contratos.</p></div></div>{contracts.length?<div className="contract-list">{contracts.map(c=>{const ledger=contractLedger(c,tasks,payrolls);const linked=tasks.filter(t=>t.contractId===c.id);const history=(s.amendments||[]).filter(a=>a.contractId===c.id);return <details className="contract-item" key={c.id} data-testid={`contract-${c.id}`}><summary data-testid={`button-contract-detail-${c.id}`}><span className="contract-identity"><b>#{c.number} · {personName(c.personId)}</b><small>{projectName(c.projectId)} · {c.description}</small></span><span className="contract-amount"><small>Autorizado</small><b>{usd(c.authorizedAmount)}</b></span><span className="contract-amount"><small>Confirmado</small><b>{usd(ledger.confirmed)}</b></span><span className="contract-amount"><small>Por ejecutar</small><b>{usd(ledger.remaining)}</b></span><ChevronDown className="contract-chevron" size={18}/></summary><div className="contract-detail" data-testid={`detail-contract-${c.id}`}><div className="contract-stages"><div><small>Valor original</small><strong>{usd(c.amount)}</strong></div><div><small>Ampliaciones</small><strong>{usd(c.authorizedAmount-c.amount)}</strong></div><div><small>Tareas pendientes de confirmar</small><strong>{usd(ledger.pending)}</strong></div><div><small>Confirmadas fuera de nómina</small><strong>{usd(ledger.toInclude)}</strong></div><div><small>Incluidas en nómina (bruto)</small><strong>{usd(ledger.included)}</strong></div><div><small>En nómina marcada pagada (bruto)</small><strong>{usd(ledger.markedPaid)}</strong></div></div><p className="contract-note">El bruto marcado como pagado identifica tareas de una nómina pagada, no el efectivo neto atribuido a este contrato. Anticipos, préstamos, daños y otros descuentos se controlan por persona.</p><div className="contract-history"><div><h3>Ampliaciones</h3>{history.length?<ul>{history.map(a=><li key={a.id}><span>{a.date} · {a.note}</span><b>+{usd(a.delta)}</b></li>)}</ul>:<p>Sin ampliaciones.</p>}</div><div><h3>Tareas vinculadas</h3>{linked.length?<ul>{linked.map(t=><li key={t.id}><span>{t.date} · {t.description}<small>{!t.approved?"Pendiente de confirmación":t.payrollId?`Nómina #${t.payrollId}`:"Confirmada, pendiente de nómina"}</small></span><b>{usd(t.amount)}</b></li>)}</ul>:<p>Sin tareas vinculadas.</p>}</div></div>{admin&&<button className="btn outline" onClick={()=>open("ampliacion",c.id)} data-testid={`button-amend-contract-${c.id}`}>Ampliar contrato</button>}</div></details>})}</div>:<Empty title="Sin contratos todavía" description="Crea una obra y un subcontratista antes de registrar contratos."/>}</section></>}
        {s && tab==="produccion" && <>
          <div className="section-actions">{production&&<button className="btn outline" onClick={()=>open("asistencia")} disabled={!people.some(p=>p.kind==="empleado")} data-testid="button-register-attendance"><Plus size={16}/> Registrar asistencia</button>}</div>
          {!personnelIntake&&<section className="panel"><div className="panel-head"><div><h2>Tareas</h2><p>{pending} pendientes de confirmación</p></div></div>
            {tasks.length?<div className="table-wrap"><table><thead><tr><th>Fecha</th><th>Persona / obra</th><th>Trabajo</th><th>Contrato</th><th>Monto</th><th>Estado</th></tr></thead><tbody>{tasks.map(t=><tr key={t.id}><td>{t.date}</td><td><b>{personName(t.personId)}</b><small>{projectName(t.projectId)}</small></td><td>{t.description}</td><td>{contracts.find(c=>c.id===t.contractId)?.number || "Independiente"}</td><td>{usd(t.amount)}</td><td>{t.payrollId?<Badge value="En nómina"/>:t.approved?<Badge value="aprobado"/>:production?<button disabled={busy} className="table-action" onClick={()=>send(`/api/tasks/${t.id}/approve`)}>Confirmar</button>:<Badge value="Pendiente"/>}</td></tr>)}</tbody></table></div>:<Empty title="Aún no hay tareas" description="Registra trabajos realizados por subcontratistas y confirma los montos." action={production?"Nueva tarea":null} onClick={()=>open("tarea")}/>}
          </section>}
          <section className="panel"><div className="panel-head"><div><h2>Asistencia</h2><p>Producción registra proyecto, responsable, horarios, horas y bonos diarios</p></div></div>
            {attendance.length?<div className="table-wrap"><table><thead><tr><th>Fecha</th><th>Empleado</th><th>Proyecto</th><th>Responsable</th><th>Entrada</th><th>Salida</th><th>Descanso</th><th>Efectivas</th><th>Regulares</th><th>Extras</th><th>Ausencia</th><th>Bono</th>{production&&<th>Acción</th>}</tr></thead><tbody>{attendance.map(a=>{const split=Array.isArray(a.allocations)?a.allocations:[];const proposal=dailyPays.find(x=>x.attendanceId===a.id);return <tr key={a.id}><td>{a.date}</td><td><b>{personName(a.personId)}</b></td><td>{split.length>1?split.map((p:any)=>`${p.projectName}: ${Number(p.regularHours+p.overtimeHours).toFixed(2)} h`).join(" · "):a.projectName || "—"}</td><td data-testid={`text-attendance-responsible-${a.id}`}>{a.responsible || "—"}</td><td>{a.timeIn || "—"}</td><td>{a.timeOut || "—"}</td><td>{a.breakMinutes || 0} min</td><td data-testid={`text-attendance-effective-${a.id}`}>{Number((Number(a.hours)+Number(a.overtime)).toFixed(2))}</td><td>{Number(Number(a.hours).toFixed(2))}</td><td>{a.overtime}</td><td>{a.absent?"Sí":"No"}</td><td>{usd(a.bonus)}</td>{production&&<td><button className="table-action" onClick={()=>open("asistencia",a.id)} data-testid={`button-edit-attendance-${a.id}`}>Editar</button>{!personnelIntake&&!a.absent&&people.find(p=>p.id===a.personId)?.payType==="hora"&&<button className="table-action" onClick={()=>open("jornal",a.id)} data-testid={`button-propose-daily-${a.id}`}>{proposal?proposal.status==="approved"?"Jornal confirmado":"Editar jornal":"Proponer jornal"}</button>}</td>}</tr>})}</tbody></table></div>:<Empty title="Todavía no hay asistencia" description="Registra proyecto, responsable, entrada, salida y descanso para calcular las horas efectivas." action={production?"Registrar asistencia":null} onClick={()=>open("asistencia")}/>}
          </section>
          {!personnelIntake&&(dailyPays.length>0)&&<section className="panel"><div className="panel-head"><div><h2>Pagos por día</h2><p>Producción propone; Administración fija el importe antes del cierre semanal.</p></div></div><div className="table-wrap"><table><thead><tr><th>Fecha / persona</th><th>Proyecto</th><th>Propuesto</th><th>Autorizado</th><th>Estado</th></tr></thead><tbody>{dailyPays.map(d=>{const a=attendance.find(x=>x.id===d.attendanceId);return <tr key={d.id}><td>{a?.date}<small>{personName(a?.personId)}</small></td><td>{a?.projectName||"—"}</td><td>{usd(d.proposedAmount)}</td><td>{d.status==="approved"?usd(d.approvedAmount):"Pendiente"}</td><td><Badge value={d.status==="approved"?"Confirmado":"Pendiente"}/></td></tr>})}</tbody></table></div></section>}
        </>}
        {s && tab==="descuentos" && <section className="panel"><div className="panel-head"><div><h2>Saldo por recuperar</h2><p>El cierre se bloquea si los descuentos pendientes exceden lo devengado</p></div><strong>{usd(outstanding)}</strong></div>{deductions.length?<div className="table-wrap"><table><thead><tr><th>Fecha</th><th>Persona</th><th>Concepto</th><th>Valor</th><th>Aplicado</th><th>Saldo</th><th>Soporte</th></tr></thead><tbody>{deductions.map(d=><tr key={d.id}><td>{d.date}</td><td><b>{personName(d.personId)}</b><small>{d.note}</small></td><td><Badge value={d.kind}/></td><td>{usd(d.amount)}</td><td>{usd(d.applied)}</td><td><b>{usd(d.amount-d.applied)}</b></td><td>{d.photo?<button className="table-action" onClick={()=>download(`/api/deductions/${d.id}/photo`)}>Descargar foto</button>:"—"}</td></tr>)}</tbody></table></div>:<Empty title="Sin descuentos activos" description="Registra anticipos, préstamos o daños con foto y autorización del manager." action="Nuevo descuento" onClick={()=>open("descuento")}/>}</section>}
        {s && tab==="nomina" && <>
          {admin&&dailyPays.some(d=>d.status!=="approved")&&<section className="panel"><div className="panel-head"><div><h2>Jornales por confirmar</h2><p>Fija el monto por día antes de generar la nómina. Sustituye solo las horas regulares de esa jornada; extras y bonos se agregan aparte.</p></div></div><div className="payroll-rules">{dailyPays.filter(d=>d.status!=="approved").map(d=>{const a=attendance.find(x=>x.id===d.attendanceId);return <form key={d.id} className="payroll-rule-row" onSubmit={e=>{e.preventDefault();const f=new FormData(e.currentTarget);send(`/api/daily-pay/${d.id}/confirm`,{amount:Number(f.get("amount"))});}}><div><b>{personName(a?.personId)} · {a?.date}</b><small>{a?.projectName} · Propuesto {usd(d.proposedAmount)} · {d.note}</small></div><Field label="Importe autorizado USD" name="amount" type="number" min=".01" step=".01" required defaultValue={d.proposedAmount}/><button className="btn outline" type="submit" disabled={busy} data-testid={`button-confirm-daily-${d.id}`}>Confirmar jornal</button></form>})}</div></section>}
          {admin&&<section className="panel payroll-builder"><div><span className="eyebrow">NUEVO CIERRE</span><h2>Preparar semana</h2><p>Selecciona el sábado de inicio. Se incluyen los siete días hasta el viernes. {selectedPeriod?`Cierra el ${selectedPeriod.weekEnd}; disponible desde el domingo ${selectedPeriod.availableOn}.`:"Elige un sábado válido."}</p><p>{payrolls.some(p=>p.weekStart===week)?"Ya existe una nómina para esta semana. Retírala antes de corregir el cálculo.":missingAbsenceAmounts.length?`Falta fijar el descuento por ausencia de ${missingAbsenceAmounts.length} persona(s), incluso si corresponde 0 USD.`:"Las ausencias están revisadas. Si los descuentos pendientes superan lo devengado, el cierre se bloqueará."}</p></div><div className="builder-controls"><label className="field"><span>Sábado de inicio</span><input type="date" value={week} onChange={e=>setWeek(e.target.value)} data-testid="input-week"/></label><button className="btn primary" disabled={busy||!selectedPeriod||missingAbsenceAmounts.length>0||payrolls.some(p=>p.weekStart===week)} onClick={()=>send("/api/payrolls",{weekStart:week})} data-testid="button-generate-payroll">Generar nómina <ArrowRight size={16}/></button></div></section>}
          {admin&&fixedAbsences.length>0&&!payrolls.some(p=>p.weekStart===week)&&<section className="panel"><div className="panel-head"><div><h2>Revisar ausencias</h2><p>Administración fija un importe global por persona para esta semana. Escribe 0 si la ausencia no se descuenta.</p></div></div><div className="payroll-rules">{fixedAbsences.map(({person,count})=>{const adjustment=s?.absenceAdjustments?.find(a=>a.personId===person.id&&a.weekStart===week);return <form key={`${person.id}-${week}`} className="payroll-rule-row" onSubmit={e=>{e.preventDefault();const f=new FormData(e.currentTarget);send("/api/payrolls/absence-adjustment",{personId:person.id,weekStart:week,amount:Number(f.get("amount"))});}}><div><b>{person.name}</b><small>{count} ausencia(s) · {adjustment?`Autorizado: ${usd(adjustment.amount)}`:"Sin importe fijado"}</small></div><Field label="Descuento total USD" name="amount" type="number" min="0" step=".01" required defaultValue={adjustment?.amount ?? ""}/><button type="submit" className="btn outline" disabled={busy} data-testid={`button-save-absence-${person.id}`}>Fijar descuento</button></form>})}</div></section>}
          {manager&&s?.people.some(p=>p.kind==="empleado"&&p.payType==="fijo"&&p.active)&&<section className="panel"><div className="panel-head"><div><h2>Horas extra con sueldo fijo</h2><p>Solo Gerencia decide por persona si las horas extra se pagan adicionalmente y autoriza la tarifa. Si no, se registran sin pago extra.</p></div></div><div className="payroll-rules">{s.people.filter(p=>p.kind==="empleado"&&p.payType==="fijo"&&p.active).map(p=><FixedOvertimeControl key={p.id} person={p} busy={busy} onSave={(personId,enabled,rate)=>send(`/api/people/${personId}/fixed-overtime`,{enabled,rate})}/>)}</div></section>}
          {payrolls.length?<div className="payroll-stack">{payrolls.map(p=><section className="panel" key={p.id}><div className="panel-head payroll-title"><div><span className="eyebrow">NÓMINA #{p.id}{legacyPeriod(p)?" · PERÍODO ANTERIOR":""}</span><h2>{p.weekStart} <span className="muted">al {p.weekEnd}</span></h2><p>{p.lines.length} personas · enviada {new Date(p.submittedAt).toLocaleString("es-US")}</p></div><Badge value={p.status}/></div><div className="payroll-summary"><div><span>Bruto</span><b>{usd(p.lines.reduce((v,l)=>v+l.gross,0))}</b></div><div><span>Descuentos</span><b>{usd(p.lines.reduce((v,l)=>v+l.deductions,0))}</b></div><div><span>Neto a pagar</span><b>{usd(p.lines.reduce((v,l)=>v+l.net,0))}</b></div></div>
          <div className="review-strip"><div><strong>Listado para revisión y aprobación</strong><p>{p.status==="borrador"?`${p.lines.filter(l=>l.reviewed).length} de ${p.lines.length} partidas revisadas por Administración. Verifica importes y conceptos antes de enviarlo.`:p.status==="revisado"?"Administración completó la revisión. Gerencia verifica el listado y confirma el neto antes de aprobar.":"Revisión y aprobación completadas; los importes quedan cerrados."}</p></div><span className="review-count">{p.lines.filter(l=>l.reviewed).length}/{p.lines.length}</span></div>
          {admin&&p.status==="borrador"&&<div className="review-filters" aria-label={`Filtrar partidas de nómina ${p.id}`}><button type="button" aria-pressed={(reviewFilter[p.id]??"all")==="all"} onClick={()=>setReviewFilter(v=>({...v,[p.id]:"all"}))} data-testid={`filter-all-${p.id}`}>Todas ({p.lines.length})</button><button type="button" aria-pressed={reviewFilter[p.id]==="pending"} onClick={()=>setReviewFilter(v=>({...v,[p.id]:"pending"}))} data-testid={`filter-pending-${p.id}`}>Pendientes ({p.lines.filter(l=>!l.reviewed).length})</button><small>Los totales corresponden a la nómina completa.</small></div>}
          <div className="table-wrap payroll-list-wrap"><table className="payroll-list-table"><thead><tr><th>Persona</th><th>Detalle</th><th>Horas efectivas</th><th>Bruto</th><th>Descuento</th><th>Neto</th><th>Observación</th><th>Revisión</th><th>Pago / recibo</th></tr></thead><tbody>{p.lines.filter(l=>reviewFilter[p.id]!=="pending"||p.status!=="borrador"||!admin||!l.reviewed).map(l=>{
            const draft=lineObservations[l.id] ?? l.observation;
            const dirty=draft!==l.observation;
            const hours=l.kind==="empleado" ? weeklyEffectiveHours(l.attendanceSnapshot) : null;
            return <tr key={l.id} data-testid={`payroll-line-${l.id}`}>
              <td data-label="Persona"><b>{l.personName}</b><small>{l.kind}</small></td>
              <td data-label="Conceptos" className="details"><ul className="concept-list">{l.details.split("\n").filter(Boolean).map((part,i)=><li key={i}>{part}</li>)}</ul></td>
              <td data-label="Horas efectivas" className="weekly-hours-cell" data-testid={`text-weekly-hours-${l.id}`}>{l.kind!=="empleado"?"No aplica":hours?<><b>{hours.total.toFixed(2)} h</b><small>{hours.regular.toFixed(2)} reg. · {hours.overtime.toFixed(2)} extra</small></>:"Sin dato histórico"}</td>
              <td data-label="Bruto">{usd(l.gross)}</td><td data-label="Descuentos">{usd(l.deductions)}</td>
              <td data-label="Neto" className="net-cell"><b>{usd(l.net)}</b></td>
              <td data-label="Observación" className="observation-cell">{admin&&p.status==="borrador"?<div className="line-observation"><textarea aria-label={`Observación de ${l.personName}`} maxLength={500} value={draft} disabled={busy} onChange={e=>setLineObservations(v=>({...v,[l.id]:e.target.value}))} placeholder="Observación de esta persona" data-testid={`input-line-observation-${l.id}`}/><button type="button" className="table-action" disabled={busy||!dirty} onClick={async()=>{const saved=await send(`/api/payrolls/${p.id}/lines/${l.id}/observation`,{observation:draft});if(saved)setLineObservations(v=>({...v,[l.id]:draft.trim()}));}} data-testid={`button-save-line-observation-${l.id}`}>Guardar observación</button>{dirty&&<small>Sin guardar. Guarda antes de revisar.</small>}</div>:<span className="observation-text">{l.observation||"Sin observación"}</span>}</td>
              <td data-label="Revisión">{admin&&p.status==="borrador"?<label className="review-check"><input type="checkbox" checked={l.reviewed} disabled={busy||dirty} onChange={e=>send(`/api/payrolls/${p.id}/lines/${l.id}/review`,{reviewed:e.target.checked})} data-testid={`check-review-line-${l.id}`}/><span>{l.reviewed?"Revisado":"Revisar"}</span></label>:<Badge value={l.reviewed?"Revisado":"Pendiente"}/>}</td>
              <td data-label="Pago / recibo">{p.status==="aprobado"?<div className="line-actions">{l.paid?<Badge value="Pagado"/>:admin?<button className="table-action" disabled={offline} onClick={()=>open("pago",l.id)}>Registrar pago</button>:<Badge value="Pendiente"/>}{pdfLink(`/api/lines/${l.id}/pdf`,"Recibo PDF")}</div>:"Tras aprobar"}</td>
            </tr>;
          })}</tbody></table>{admin&&p.status==="borrador"&&reviewFilter[p.id]==="pending"&&p.lines.every(l=>l.reviewed)&&<div className="review-empty">No quedan partidas pendientes. <button type="button" className="table-action" onClick={()=>setReviewFilter(v=>({...v,[p.id]:"all"}))}>Ver listado completo</button></div>}</div>
          {(()=>{const report=projectReport(p);return <section className="project-report" aria-label={`Personas por proyecto de nómina ${p.id}`} data-testid={`project-report-${p.id}`}>
            <div className="project-report-head"><div><h3>Personas por proyecto</h3><p>Devengado bruto de esta nómina por obra. Sueldo fijo según horas efectivas, incluido el tiempo extra; los descuentos y el neto se muestran solo por persona.</p></div><div className="project-report-actions"><span>{report.groups.length} proyecto(s)</span>{pdfLink(`/api/payrolls/${p.id}/pdf/proyectos`,"Proyectos PDF")}</div></div>
            {report.groups.length>0?<div className="project-report-grid">{report.groups.map((group,i)=><div className="project-report-card" key={i}><div className="project-report-title"><strong>{group.name}</strong><b>{usd(group.items.reduce((sum,item)=>sum+item.amount,0))}</b></div><div className="project-report-people">{group.items.map((item,j)=><div key={j}><span>{item.personName}<small>{item.kind==="subcontratista"?"Tareas aprobadas":`${item.hours.toFixed(2)} h efectivas`}</small></span><b>{usd(item.amount)}</b></div>)}</div></div>)}</div>:!report.historical.length?<p className="project-report-empty">No hay importes asignados a proyectos.</p>:null}
            {report.historical.length>0&&<p className="project-report-legacy" data-testid={`project-report-historical-${p.id}`}>Sin desglose histórico: {report.historical.map(l=>l.personName).join(", ")} ({usd(report.historical.reduce((sum,l)=>sum+l.gross,0))} bruto). Esta nómina se creó antes de guardar la asignación y no se reconstruye con asistencia posterior.</p>}
            <p className="project-report-note">Las tareas aprobadas tarde pueden proceder de un período anterior; aquí constan cuando se incluyen en la nómina.</p>
          </section>})()}
          <div className="review-panel">
            {p.status==="borrador"&&admin?<label className="field"><span>Nota de revisión para Gerencia (opcional)</span><textarea maxLength={500} value={reviewNotes[p.id] ?? ""} onChange={e=>setReviewNotes(v=>({...v,[p.id]:e.target.value}))} placeholder="Observaciones sobre importes, descuentos o partidas" data-testid={`input-review-note-${p.id}`}/></label>:<div className="review-stamps"><span><b>Administración</b> {p.reviewedAt?`${p.reviewer || "Revisión anterior"} · ${new Date(p.reviewedAt).toLocaleString("es-US")}`:"Pendiente de revisión"}</span><span><b>Gerencia</b> {p.approvedAt?`${p.approver || "Aprobación anterior"} · ${new Date(p.approvedAt).toLocaleString("es-US")}`:"Pendiente de aprobación"}</span>{p.note&&<span><b>Nota</b> {p.note}</span>}</div>}
            {manager&&p.status==="revisado"&&<label className="review-check manager-check"><input type="checkbox" checked={managerConfirmed===p.id} onChange={e=>setManagerConfirmed(e.target.checked?p.id:null)} data-testid={`check-confirm-payroll-${p.id}`}/><span>He comprobado las partidas y confirmo el total neto de {usd(p.lines.reduce((v,l)=>v+l.net,0))}.</span></label>}
          </div>
          <div className="panel-footer"><div className="footer-links">{pdfLink(`/api/payrolls/${p.id}/pdf/lista`,"Listado PDF")}{pdfLink(`/api/payrolls/${p.id}/pdf/contable`,"Contable PDF")}</div><div className="footer-links">{admin&&p.status!=="aprobado"&&<button className="btn quiet" disabled={busy} onClick={()=>send(`/api/payrolls/${p.id}/withdraw`)}>Retirar para corregir</button>}{admin&&p.status==="borrador"&&<button className="btn primary" disabled={busy||!p.lines.length||p.lines.some(l=>!l.reviewed||(lineObservations[l.id]??l.observation)!==l.observation)} onClick={()=>send(`/api/payrolls/${p.id}/review`,{note:reviewNotes[p.id] ?? ""})} data-testid={`button-submit-review-${p.id}`}>Enviar revisión a Gerencia <Check size={16}/></button>}{manager&&p.status==="revisado"&&<button className="btn primary" disabled={busy||managerConfirmed!==p.id} onClick={()=>send(`/api/payrolls/${p.id}/approve`,{confirmed:true})} data-testid={`button-approve-payroll-${p.id}`}>Gerencia: aprobar <Check size={16}/></button>}</div></div>
          </section>)}</div>:<section className="panel"><Empty title="Sin cierres semanales" description="Cuando tengas asistencia o tareas confirmadas, selecciona un sábado y genera la nómina desde el domingo posterior al cierre."/></section>}</>}
        </div>
      </main>
    </div>
    {modal && <div className="overlay" onMouseDown={e=>{if(e.target===e.currentTarget)setModal(null)}}><section className="dialog" role="dialog" aria-modal="true" aria-label={`Formulario ${modal}`}><div className="dialog-head"><div><span className="eyebrow">ONEFIX · REGISTRO</span><h2>{({persona:"Nueva persona",editarPersona:"Editar persona",obra:"Nueva obra",contrato:"Nuevo contrato",tarea:"Nueva tarea",asistencia:"Registrar asistencia",jornal:"Proponer pago por día",descuento:"Nuevo descuento",ampliacion:"Ampliar contrato",pago:"Registrar pago"})[modal]}</h2></div><button className="icon-button" aria-label="Cerrar" onClick={()=>setModal(null)}><X size={20}/></button></div>
      {error && <div role="alert" className="feedback error">{error}</div>}
      <form onSubmit={modal==="descuento"?deductionSubmit:formSubmit} className="dialog-body">
        {(modal==="persona"||modal==="editarPersona")&&(()=>{
          const p=modal==="editarPersona"?people.find(x=>x.id===chosen):null;
          return <><div className="form-grid">
            <Field label="Nombre completo" name="name" required defaultValue={p?.name}/>
            <Field label="Cargo (escrito por Producción o Administración)" name="jobTitle" required={personPayType!=="tareas"} maxLength={120} defaultValue={p?.jobTitle || ""} placeholder="Ej. Ayudante de construcción"/>
            <Field label="Tipo de persona" name="kind" required defaultValue={p?.kind || (production||personnelIntake?"empleado":undefined)}><option value="empleado">Empleado</option>{!production&&!personnelIntake&&<option value="subcontratista">Subcontratista</option>}</Field>
            <Field label="Documento" name="document" required defaultValue={p?.document}/>
            <Field label="Teléfono / WhatsApp" name="phone" required defaultValue={p?.phone}/>
            <Field label="Correo" name="email" type="email" defaultValue={p?.email}/>
            <Field label="Banco" name="bank" defaultValue={p?.bank}/>
            <Field label="Número de cuenta" name="account" defaultValue={p?.account}/>
            <Field label="Modalidad" name="payType" required value={personPayType} onChange={(e:React.ChangeEvent<HTMLSelectElement>)=>setPersonPayType(e.target.value)}><option value="fijo">Sueldo fijo semanal</option><option value="hora">Por hora</option>{!production&&!personnelIntake&&<option value="tareas">Por tareas</option>}</Field>
            <Field label={production?"Tarifa USD":"Tarifa USD (0 por tareas)"} name="rate" type="number" min="0" step=".01" required defaultValue={p?.rate ?? 0}/>
            <Field label="Tarifa extra USD/h" name="overtimeRate" type="number" min="0" step=".01" disabled={personPayType==="fijo"} placeholder="Gerencia autoriza sueldo fijo" defaultValue={p?.overtimeRate ?? ""}/>
          </div><p className="form-hint">{personnelIntake?"La regla de horas extra para sueldo fijo se configurará al habilitar Nómina semanal.":"Para sueldo fijo, solo Gerencia autoriza el pago de extras y su tarifa en Nómina semanal."}{!production&&!personnelIntake&&" Para subcontratistas, selecciona «Por tareas»."}</p></>;
        })()}
        {modal==="obra"&&<><Field label="Nombre de la obra" name="name" required placeholder="Ej. 1037 E Yukon St"/><Field label="Dirección" name="address" placeholder="Ciudad y dirección"/></>}
        {modal==="contrato"&&<><div className="form-grid"><Field label="Número único" name="number" required/><Field label="Subcontratista" name="personId" required>{people.filter(p=>p.kind==="subcontratista").map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</Field><Field label="Obra" name="projectId" required>{projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</Field><Field label="Valor original USD" name="amount" type="number" min=".01" step=".01" required/><Field label="Fecha" name="date" type="date" required defaultValue={day()}/></div><Field label="Descripción del trabajo" name="description" required/><Field label="Notas" name="notes"/></>}
        {modal==="tarea"&&<><div className="form-grid"><Field label="Subcontratista" name="personId" required>{people.filter(p=>p.kind==="subcontratista").map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</Field><Field label="Obra" name="projectId" required>{projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</Field><Field label="Contrato existente (opcional)" name="contractId"><option value="none">Sin contrato</option>{contracts.map(c=><option key={c.id} value={c.id}>#{c.number} · {personName(c.personId)} · {projectName(c.projectId)}</option>)}</Field><Field label="Monto aprobado USD" name="amount" type="number" min=".01" step=".01" required/><Field label="Fecha de trabajo" name="date" type="date" required defaultValue={day()}/></div><Field label="Descripción de tarea" name="description" required/><p className="form-hint">Se crea pendiente. Producción confirma el monto antes de incluirla en nómina.</p></>}
        {modal==="asistencia"&&<AttendanceFields key={chosen ?? "new"} a={attendance.find(x=>x.id===chosen)} people={people} projects={projects} onValidationError={setError} onValidationInput={()=>setError("")}/>}
        {modal==="jornal"&&<><p className="form-hint">Esta propuesta sustituye el pago por horas regulares de la asistencia seleccionada. No duplica el sueldo; las horas extra y el bono se mantienen. Administración debe confirmar el importe antes de generar nómina.</p><p>{personName(attendance.find(a=>a.id===chosen)?.personId)} · {attendance.find(a=>a.id===chosen)?.date}</p><Field label="Importe propuesto USD" name="proposedAmount" type="number" min=".01" step=".01" required defaultValue={dailyPays.find(d=>d.attendanceId===chosen)?.proposedAmount??""}/><Field label="Motivo o referencia" name="note" required maxLength={300} defaultValue={dailyPays.find(d=>d.attendanceId===chosen)?.note??""}/>{dailyPays.find(d=>d.attendanceId===chosen) && <button type="button" className="table-action" disabled={busy} onClick={()=>removeDailyPay(dailyPays.find(d=>d.attendanceId===chosen).id)} data-testid="button-remove-daily">Retirar propuesta de jornal</button>}</>}
        {modal==="descuento"&&<><div className="form-grid"><Field label="Persona" name="personId" required>{people.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</Field><Field label="Concepto" name="kind" required><option value="anticipo">Anticipo</option><option value="prestamo">Préstamo</option><option value="dano">Daño</option></Field><Field label="Importe USD" name="amount" type="number" min=".01" step=".01" required/><Field label="Fecha" name="date" type="date" required defaultValue={day()}/><Field label="Manager que autoriza daños" name="manager"/><Field label="Foto para daños (JPG, PNG o WEBP)" name="photo" type="file"/></div><Field label="Motivo / referencia" name="note" required/><p className="form-hint">Un daño exige foto y nombre del manager. La nómina no se genera si la suma pendiente de descuentos supera lo devengado.</p></>}
        {modal==="ampliacion"&&<><p className="form-hint">Solo Administración debe autorizar la ampliación. Esta vista de prueba todavía no autentica usuarios.</p><Field label="Aumento autorizado USD" name="delta" type="number" min=".01" step=".01" required/><Field label="Justificación" name="note" required/></>}
        {modal==="pago"&&<><p className="form-hint">Registra el pago únicamente después de la transferencia o entrega del dinero. Requiere conexión y respuesta del servidor.</p><Field label="Método de pago" name="method" required placeholder="Ej. transferencia"/><Field label="Referencia" name="reference" required placeholder="Número de confirmación"/></>}
        <div className="dialog-actions"><button type="button" className="btn quiet" onClick={()=>setModal(null)}>Cancelar</button><button className="btn primary" type="submit" disabled={busy||(modal==="pago"&&offline)}>{busy?"Guardando…":"Guardar"}<ArrowRight size={16}/></button></div>
      </form></section></div>}
  </div>;
}
export default function App(){return <QueryClientProvider client={queryClient}><AuthGate/></QueryClientProvider>;}
