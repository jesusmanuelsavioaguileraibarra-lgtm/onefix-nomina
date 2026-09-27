import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "./lib/queryClient";

type Invoice = {
  id:number;source_row:number;job:string;invoice_number:string;issue_date:string|null;
  raw_date:string;gross_cents:number|null;paid_cents:number|null;
  balance_2025_cents:number|null;balance_2026_cents:number|null;
  note:string;client:string;cancelled:boolean;review_reasons:string;due_date:string|null;
};
const usd=(cents:number|null)=>cents===null?"No indicado":
  new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"}).format(cents/100);
function status(item:Invoice,today:string) {
  if(item.cancelled)return "Cancelada";
  if(!item.invoice_number.startsWith("INV"))return "Sin factura emitida";
  if(!item.due_date)return "Sin vencimiento";
  const balance=(item.balance_2025_cents||0)+(item.balance_2026_cents||0);
  if(balance<=0)return "Sin saldo positivo";
  if(item.due_date<today)return "Vencida";
  if(item.due_date<=new Date(Date.parse(`${today}T12:00:00Z`)+7*86400000).toISOString().slice(0,10))return "Próxima";
  return "Vigente";
}

export default function Receivables({offline}:{offline:boolean}) {
  const {data:items=[],isLoading,isError,refetch}=useQuery<Invoice[]>({
    queryKey:["receivables"],queryFn:async()=>await (await apiRequest("GET","/api/receivables")).json(),
    enabled:!offline,staleTime:0,refetchOnMount:"always",
  });
  const [search,setSearch]=useState("");
  const [filter,setFilter]=useState("todas");
  const [editing,setEditing]=useState<Invoice|null>(null);
  const [saving,setSaving]=useState(false);
  const [error,setError]=useState("");
  const [message,setMessage]=useState("");
  const today=new Date().toLocaleDateString("en-CA",{timeZone:"America/New_York"});
  const visible=useMemo(()=>items.filter(i=>{
    const needle=search.toLocaleLowerCase("es");
    return [i.invoice_number,i.job,i.client,i.note].some(value=>value.toLocaleLowerCase("es").includes(needle))
      && (filter==="todas"||filter==="revisar"&&!!i.review_reasons
        ||filter==="canceladas"&&i.cancelled||filter==="sin-fecha"&&!i.due_date&&!i.cancelled
        ||filter==="vencidas"&&status(i,today)==="Vencida");
  }),[items,search,filter,today]);
  const collectible=visible.filter(i=>!i.cancelled&&i.invoice_number.startsWith("INV")).reduce((sum,i)=>sum+Math.max(0,(i.balance_2025_cents||0)+(i.balance_2026_cents||0)),0);
  async function save(event:React.FormEvent<HTMLFormElement>){
    event.preventDefault();
    if(!editing)return;
    const date=String(new FormData(event.currentTarget).get("dueDate")||"");
    setSaving(true);setError("");
    try {
      await apiRequest("PATCH",`/api/receivables/${editing.id}/due-date`,{dueDate:date||null});
      await queryClient.invalidateQueries({queryKey:["receivables"]});
      setEditing(null);
      setMessage(date?`Vencimiento guardado para ${editing.invoice_number||`fila ${editing.source_row}`}.`:"Vencimiento retirado. No se calcularán alertas para esta fila.");
    } catch(err){setError(err instanceof Error?err.message:"No se pudo guardar");}
    finally{setSaving(false);}
  }
  return <div className="tracking receivables" data-testid="receivables">
    <div className="tracking-intro"><div><span className="eyebrow">CUENTAS POR COBRAR · USD</span><h2>Facturas y vencimientos</h2>
      <p>Registro independiente de nómina y contratos de subcontratistas. Cada fila conserva su referencia al Excel original.</p></div></div>
    <div className="scope-note">Los vencimientos del archivo no estaban indicados. Permanecen vacíos hasta que Administración o Gerencia los definan. Las canceladas y las filas sin factura emitida se conservan, pero no suman al saldo cobrable. Los importes marcados para revisión no se han conciliado.</div>
    {offline&&<div className="feedback error" role="alert">Esta área privada requiere conexión. No se conserva una copia local.</div>}
    {isError&&<div className="feedback error" role="alert">No se pudieron cargar las facturas. <button onClick={()=>refetch()} data-testid="button-retry-receivables">Reintentar</button></div>}
    {message&&<div className="feedback success" role="status">{message}</div>}
    {!offline&&<><div className="tracking-filters">
      <label className="field"><span>Buscar factura, job, cliente u observación</span><input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Buscar en el archivo" data-testid="input-search-receivables"/></label>
      <label className="field"><span>Mostrar</span><select value={filter} onChange={e=>setFilter(e.target.value)} data-testid="select-receivables-filter">
        <option value="todas">Todas</option><option value="revisar">Por verificar</option><option value="sin-fecha">Sin vencimiento</option><option value="vencidas">Vencidas</option><option value="canceladas">Canceladas</option>
      </select></label>
    </div>
    <div className="tracking-metrics"><div><span>Filas visibles</span><b data-testid="text-invoice-count">{visible.length}</b></div>
      <div><span>Por verificar</span><b>{visible.filter(i=>!!i.review_reasons).length}</b></div>
      <div><span>Sin vencimiento</span><b>{visible.filter(i=>!i.due_date&&!i.cancelled).length}</b></div>
      <div><span>Saldo positivo informado en facturas no canceladas</span><b data-testid="text-collectible">{usd(collectible)}</b></div></div>
    <section className="panel"><div className="panel-head"><div><h2>Detalle de facturas</h2><p>El saldo mostrado procede de las columnas 2025 y 2026 del archivo; no equivale a un importe conciliado.</p></div></div>
      {isLoading?<div className="empty">Cargando facturas…</div>:visible.length?<div className="table-wrap"><table><thead><tr><th>Fila</th><th>Factura</th><th>Job / cliente</th><th>Fecha emisión</th><th>Importe</th><th>Pagos</th><th>Saldo 2025</th><th>Saldo 2026</th><th>Vencimiento</th><th>Estado / revisión</th><th>Observaciones</th><th>Acción</th></tr></thead>
        <tbody>{visible.map(i=><tr key={i.id} data-testid={`receivable-row-${i.source_row}`}>
          <td>{i.source_row}</td><td><b>{i.invoice_number||"Sin número"}</b></td><td>{i.job||"Sin job"}<small>{i.client||"Cliente no indicado"}</small></td>
          <td>{i.issue_date||i.raw_date||"No indicada"}{!i.issue_date&&!!i.raw_date&&<small>Revisar fecha</small>}</td>
          <td>{usd(i.gross_cents)}</td><td>{usd(i.paid_cents)}</td><td>{usd(i.balance_2025_cents)}</td><td>{usd(i.balance_2026_cents)}</td>
          <td>{i.due_date||"Sin definir"}</td><td>{status(i,today)}{!!i.review_reasons&&<small className="tracking-flag">{i.review_reasons}</small>}</td>
          <td className="details">{i.note||"—"}</td><td><button className="table-action" data-testid={`button-due-date-${i.source_row}`} onClick={()=>{setEditing(i);setError("");}}>Vencimiento</button></td>
        </tr>)}</tbody></table></div>:<div className="empty"><h3>{items.length?"Sin coincidencias":"Aún no hay facturas"}</h3><p>{items.length?"Prueba otro filtro o búsqueda.":"El archivo debe importarse antes de comenzar a fijar vencimientos."}</p></div>}</section></>}
    {editing&&<div className="overlay" role="presentation" onMouseDown={e=>{if(e.target===e.currentTarget)setEditing(null);}}><div className="dialog" role="dialog" aria-modal="true" aria-label="Editar vencimiento">
      <div className="dialog-head"><div><span className="eyebrow">FECHA MANUAL</span><h2>{editing.invoice_number||`Fila ${editing.source_row}`}</h2></div><button className="icon-button" onClick={()=>setEditing(null)} aria-label="Cerrar">×</button></div>
      <form onSubmit={save} className="dialog-body"><p>Define la fecha de vencimiento solamente si está confirmada. Puedes dejarla vacía.</p>
        <label className="field"><span>Fecha de vencimiento</span><input name="dueDate" type="date" defaultValue={editing.due_date||""} data-testid="input-due-date"/></label>
        {error&&<div className="feedback error" role="alert">{error}</div>}
        <div className="dialog-actions"><button type="button" className="btn outline" onClick={()=>setEditing(null)}>Cancelar</button><button type="submit" className="btn primary" disabled={saving} data-testid="button-save-due-date">{saving?"Guardando…":"Guardar fecha"}</button></div>
      </form></div></div>}
  </div>;
}
