import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "./lib/queryClient";
import { dueStatus } from "./lib/receivable-alerts";

type Invoice = {
  id:number;source_row:number;job:string;invoice_number:string;issue_date:string|null;
  raw_date:string;gross_cents:number|null;paid_cents:number|null;
  balance_2025_cents:number|null;balance_2026_cents:number|null;
  note:string;client:string;cancelled:boolean;review_reasons:string;due_date:string|null;
};
const usd=(cents:number|null)=>cents===null?"No indicado":
  new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"}).format(cents/100);

export default function Receivables({offline}:{offline:boolean}) {
  const {data:items=[],isLoading,isError,refetch}=useQuery<Invoice[]>({
    queryKey:["receivables"],queryFn:async()=>await (await apiRequest("GET","/api/receivables")).json(),
    enabled:!offline,staleTime:0,refetchOnMount:"always",
  });
  const [search,setSearch]=useState("");
  const [filter,setFilter]=useState("todas");
  const [page,setPage]=useState(0);
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
        ||filter==="vencidas"&&dueStatus(i,today)==="Vencida");
  }),[items,search,filter,today]);
  const pageSize=25;
  const pageCount=Math.ceil(visible.length/pageSize);
  const currentPage=Math.min(page,Math.max(0,pageCount-1));
  const pageItems=visible.slice(currentPage*pageSize,(currentPage+1)*pageSize);
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
      <label className="field"><span>Buscar factura, job, cliente u observación</span><input value={search} onChange={e=>{setSearch(e.target.value);setPage(0);}} placeholder="Buscar en el archivo" data-testid="input-search-receivables"/></label>
      <label className="field"><span>Mostrar</span><select value={filter} onChange={e=>{setFilter(e.target.value);setPage(0);}} data-testid="select-receivables-filter">
        <option value="todas">Todas</option><option value="revisar">Por verificar</option><option value="sin-fecha">Sin vencimiento</option><option value="vencidas">Vencidas</option><option value="canceladas">Canceladas</option>
      </select></label>
    </div>
    <div className="tracking-metrics"><div><span>Filas visibles</span><b data-testid="text-invoice-count">{visible.length}</b></div>
      <div><span>Por verificar</span><b>{visible.filter(i=>!!i.review_reasons).length}</b></div>
      <div><span>Sin vencimiento</span><b>{visible.filter(i=>!i.due_date&&!i.cancelled).length}</b></div>
      <div><span>Saldo positivo informado en facturas no canceladas</span><b data-testid="text-collectible">{usd(collectible)}</b></div></div>
    <section className="panel"><div className="panel-head"><div><h2>Detalle de facturas</h2><p>Abre cada factura para ver todos sus importes y observaciones. Los saldos del archivo no equivalen a importes conciliados.</p></div></div>
      {isLoading?<div className="empty">Cargando facturas…</div>:visible.length?<><div className="receivable-list">
        {pageItems.map(i=><details className="receivable-item" key={i.id} data-testid={`receivable-row-${i.source_row}`}>
          <summary data-testid={`summary-receivable-${i.source_row}`}>
            <span className="receivable-id"><b>{i.invoice_number||"Sin número"}</b><small>Fila {i.source_row} del Excel</small></span>
            <span className="receivable-party"><b>{i.client||"Cliente no indicado"}</b><small>Job: {i.job||"Sin job"}</small></span>
            <span className="receivable-amount"><small>Saldo 2025 + 2026</small><b>{i.balance_2025_cents===null&&i.balance_2026_cents===null?"No indicado":usd((i.balance_2025_cents||0)+(i.balance_2026_cents||0))}</b></span>
            <span className="receivable-state"><b>{dueStatus(i,today)}</b><small>{i.due_date?`Vence: ${i.due_date}`:i.review_reasons?"Por verificar":"Vencimiento sin definir"}</small></span>
            <span className="receivable-cue" aria-hidden="true">⌄</span>
          </summary>
          <div className="receivable-detail">
            <dl className="receivable-fields">
              <div><dt>Fecha de emisión</dt><dd>{i.issue_date||i.raw_date||"No indicada"}{!i.issue_date&&!!i.raw_date&&" (revisar)"}</dd></div>
              <div><dt>Importe original</dt><dd>{usd(i.gross_cents)}</dd></div>
              <div><dt>Pagos informados</dt><dd>{usd(i.paid_cents)}</dd></div>
              <div><dt>Saldo 2025</dt><dd>{usd(i.balance_2025_cents)}</dd></div>
              <div><dt>Saldo 2026</dt><dd>{usd(i.balance_2026_cents)}</dd></div>
              <div><dt>Vencimiento</dt><dd>{i.due_date||"Sin definir"}</dd></div>
            </dl>
            {i.review_reasons&&<p className="receivable-review"><strong>Por verificar:</strong> {i.review_reasons}</p>}
            <p className="receivable-note"><strong>Observaciones:</strong> {i.note||"Ninguna en el archivo"}</p>
            <button className="btn outline" data-testid={`button-due-date-${i.source_row}`} onClick={()=>{setEditing(i);setError("");}}>Editar vencimiento</button>
          </div>
        </details>)}
      </div>
      <nav className="receivable-pagination" aria-label="Páginas de facturas">
        <span data-testid="text-receivable-range">Mostrando {currentPage*pageSize+1}–{Math.min((currentPage+1)*pageSize,visible.length)} de {visible.length} filas · Página {currentPage+1} de {pageCount}</span>
        <div><button className="btn outline" disabled={currentPage===0} onClick={()=>setPage(currentPage-1)} data-testid="button-previous-receivables">Anterior</button>
          <button className="btn outline" disabled={currentPage>=pageCount-1} onClick={()=>setPage(currentPage+1)} data-testid="button-next-receivables">Siguiente</button></div>
      </nav></>:<div className="empty"><h3>{items.length?"Sin coincidencias":"Aún no hay facturas"}</h3><p>{items.length?"Prueba otro filtro o búsqueda.":"El archivo debe importarse antes de comenzar a fijar vencimientos."}</p></div>}</section></>}
    {editing&&<div className="overlay" role="presentation" onMouseDown={e=>{if(e.target===e.currentTarget)setEditing(null);}}><div className="dialog" role="dialog" aria-modal="true" aria-label="Editar vencimiento">
      <div className="dialog-head"><div><span className="eyebrow">FECHA MANUAL</span><h2>{editing.invoice_number||`Fila ${editing.source_row}`}</h2></div><button className="icon-button" onClick={()=>setEditing(null)} aria-label="Cerrar">×</button></div>
      <form onSubmit={save} className="dialog-body"><p>Define la fecha de vencimiento solamente si está confirmada. Puedes dejarla vacía.</p>
        <label className="field"><span>Fecha de vencimiento</span><input name="dueDate" type="date" defaultValue={editing.due_date||""} data-testid="input-due-date"/></label>
        {error&&<div className="feedback error" role="alert">{error}</div>}
        <div className="dialog-actions"><button type="button" className="btn outline" onClick={()=>setEditing(null)}>Cancelar</button><button type="submit" className="btn primary" disabled={saving} data-testid="button-save-due-date">{saving?"Guardando…":"Guardar fecha"}</button></div>
      </form></div></div>}
  </div>;
}
