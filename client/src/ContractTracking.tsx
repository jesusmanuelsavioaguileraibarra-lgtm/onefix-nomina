import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "./lib/queryClient";

type Contract = {
  id:number;number:string;project:string;subcontractor:string;work:string;
  valueCents:number;appliedCents:number;status:string;note:string;needsReview:boolean;
};
const statuses=["Activo","Por aprobar","Por definir","Retención","Compensación","Terminado","Pagado"];
const money=(cents:number)=>new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"}).format(cents/100);
const toCents=(value:string)=>Math.round(Number(value)*100);

export default function ContractTracking({admin,offline}:{admin:boolean;offline:boolean}) {
  const {data:records=[],isLoading,isError,refetch}=useQuery<Contract[]>({
    queryKey:["contract-tracking"], queryFn:async()=>await (await apiRequest("GET","/api/contract-tracking")).json(),
    enabled:!offline, staleTime:0, refetchOnMount:"always",
  });
  const [search,setSearch]=useState("");
  const [showReview,setShowReview]=useState(false);
  const [editing,setEditing]=useState<Contract|null>(null);
  const [formOpen,setFormOpen]=useState(false);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [message,setMessage]=useState("");
  const visible=useMemo(()=>records.filter(c=>(!showReview||c.needsReview) &&
    [c.number,c.project,c.subcontractor,c.work,c.status].some(text=>String(text||"").toLocaleLowerCase("es").includes(search.toLocaleLowerCase("es")))),[records,search,showReview]);
  const sum=(key:"valueCents"|"appliedCents")=>visible.reduce((amount,c)=>amount+c[key],0);
  async function save(event:React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form=new FormData(event.currentTarget);
    const data={
      number:String(form.get("number")||"").trim(),project:String(form.get("project")||"").trim(),
      subcontractor:String(form.get("subcontractor")||"").trim(),work:String(form.get("work")||"").trim(),
      valueCents:toCents(String(form.get("value")||"")),appliedCents:toCents(String(form.get("applied")||"")),
      status:String(form.get("status")||"Activo"),note:String(form.get("note")||"").trim(),
      needsReview:form.get("needsReview")==="on",
    };
    if(!Number.isSafeInteger(data.valueCents)||!Number.isSafeInteger(data.appliedCents)||data.valueCents<0||data.appliedCents<0){
      setError("Valor y abonado/descuento deben ser importes válidos, no negativos.");return;
    }
    setBusy(true);setError("");
    try {
      await apiRequest(editing?"PATCH":"POST",editing?`/api/contract-tracking/${editing.id}`:"/api/contract-tracking",data);
      await queryClient.invalidateQueries({queryKey:["contract-tracking"]});
      setFormOpen(false);setEditing(null);setMessage("Registro guardado. El saldo se recalculó; no se creó ningún pago en Nómina.");
    } catch(err) {setError(err instanceof Error?err.message:"No se pudo guardar");}
    finally {setBusy(false);}
  }
  return <div className="tracking" data-testid="contract-tracking">
    <div className="tracking-intro"><div><span className="eyebrow">REGISTRO PRIVADO · USD</span>
      <h2>Libro de contratos</h2><p>Valor contratado, abonado o descontado y saldo pendiente por obra y subcontratista.</p></div>
      {admin&&<button className="btn primary" disabled={offline} onClick={()=>{setEditing(null);setFormOpen(true);setError("");}}>Nuevo contrato</button>}
    </div>
    <div className="scope-note">Este registro es independiente de las tareas, recibos y pagos de Nómina. “Abonado / Desc.” puede incluir descuentos: verifica cada concepto antes de considerarlo pagado.</div>
    {offline&&<div className="feedback error" role="alert">El seguimiento privado solo está disponible con conexión; no se almacena una copia local.</div>}
    {isError&&<div className="feedback error" role="alert">No se pudo consultar el seguimiento. <button onClick={()=>refetch()}>Reintentar</button></div>}
    {message&&<div className="feedback success" role="status">{message}</div>}
    {!offline&&<><div className="tracking-filters"><label className="field"><span>Buscar número, obra, persona o trabajo</span><input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Buscar contratos" data-testid="tracking-search"/></label><label className="check-field"><input type="checkbox" checked={showReview} onChange={e=>setShowReview(e.target.checked)}/> Solo por verificar</label></div>
      <div className="tracking-metrics"><div><span>Contratos visibles</span><b>{visible.length}</b></div><div><span>Valor</span><b>{money(sum("valueCents"))}</b></div><div><span>Abonado / Desc.</span><b>{money(sum("appliedCents"))}</b></div><div><span>Saldo</span><b>{money(sum("valueCents")-sum("appliedCents"))}</b></div></div>
      <section className="panel"><div className="panel-head"><div><h2>Contratos y observaciones</h2><p>{records.filter(c=>c.needsReview).length} por verificar · El número original puede estar vacío o repetido, con revisión obligatoria.</p></div></div>
        {isLoading?<div className="empty">Cargando registro privado…</div>:visible.length?<div className="table-wrap"><table><thead><tr><th>No.</th><th>Proyecto / Job</th><th>Subcontratista</th><th>Trabajo</th><th>Valor</th><th>Abonado / Desc.</th><th>Saldo</th><th>Estado</th><th>Observación</th>{admin&&<th>Acción</th>}</tr></thead><tbody>{visible.map(c=><tr key={c.id} data-testid={`tracking-row-${c.id}`}><td>{c.number||"Sin número"}</td><td><b>{c.project}</b></td><td>{c.subcontractor}</td><td>{c.work}</td><td>{money(c.valueCents)}</td><td>{money(c.appliedCents)}</td><td><b>{money(c.valueCents-c.appliedCents)}</b></td><td>{c.status}{c.needsReview&&<small className="tracking-flag">Por verificar</small>}</td><td className="details">{c.note||"—"}</td>{admin&&<td><button className="table-action" onClick={()=>{setEditing(c);setFormOpen(true);setError("");}}>Editar</button></td>}</tr>)}</tbody></table></div>:<div className="empty"><h3>Sin contratos en este filtro</h3><p>{records.length?"Prueba otra búsqueda o desactiva «Solo por verificar».":"El registro está vacío. Administración puede cargar contratos tras revisar los números y saldos del Excel consolidado."}</p></div>}</section>
    </>}
    {formOpen&&admin&&<div className="overlay" role="presentation" onMouseDown={e=>{if(e.target===e.currentTarget)setFormOpen(false);}}><div className="dialog" role="dialog" aria-modal="true" aria-label={editing?"Editar contrato":"Nuevo contrato"}>
      <div className="dialog-head"><div><span className="eyebrow">SEGUIMIENTO PRIVADO</span><h2>{editing?"Editar contrato":"Nuevo contrato"}</h2></div><button className="icon-button" onClick={()=>setFormOpen(false)} aria-label="Cerrar">×</button></div>
      <form onSubmit={save} className="dialog-body"><div className="form-grid">
        <label className="field"><span>No. original (puede quedar vacío)</span><input name="number" defaultValue={editing?.number||""} maxLength={40}/></label>
        <label className="field"><span>Proyecto / Job</span><input name="project" required maxLength={240} defaultValue={editing?.project||""}/></label>
        <label className="field"><span>Subcontratista</span><input name="subcontractor" required maxLength={180} defaultValue={editing?.subcontractor||""}/></label>
        <label className="field"><span>Estado</span><select name="status" defaultValue={editing?.status||"Activo"}>{statuses.map(s=><option key={s}>{s}</option>)}</select></label>
        <label className="field"><span>Valor contratado (USD)</span><input name="value" type="number" min="0" step=".01" required defaultValue={editing?(editing.valueCents/100).toFixed(2):""}/></label>
        <label className="field"><span>Abonado / Desc. (USD)</span><input name="applied" type="number" min="0" step=".01" required defaultValue={editing?(editing.appliedCents/100).toFixed(2):"0.00"}/></label>
      </div><label className="field"><span>Trabajo</span><input name="work" required maxLength={1000} defaultValue={editing?.work||""}/></label>
      <label className="field"><span>Observación</span><textarea name="note" rows={3} maxLength={3000} defaultValue={editing?.note||""}/></label>
      <label className="check-field"><input type="checkbox" name="needsReview" defaultChecked={editing?.needsReview||false}/> Por verificar (número, persona, saldo o soporte)</label>
      {error&&<div className="feedback error" role="alert">{error}</div>}
      <div className="dialog-actions"><button type="button" className="btn outline" onClick={()=>setFormOpen(false)}>Cancelar</button><button className="btn primary" disabled={busy} type="submit">{busy?"Guardando…":"Guardar contrato"}</button></div></form>
    </div></div>}
  </div>;
}
