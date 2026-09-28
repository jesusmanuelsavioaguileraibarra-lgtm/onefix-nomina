import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowDownToLine, Plus, X } from "lucide-react";
import { apiRequest, queryClient } from "./lib/queryClient";
import { estimateTotalCents } from "@shared/estimate";

type Client = { id:number;name:string;contact:string;email:string;phone:string;address:string;note:string;revision:number };
type Item = { description:string;quantityMilli:number;unitCents:number };
type Estimate = {
  id:number;number:string;client_id:number;client_name:string;title:string;project_name:string;
  valid_until:string|null;scope:string;note:string;items:Item[];total_cents:number;
  status:"borrador"|"en_revision"|"aceptado"|"rechazado";reference:string;revision:number;
};
type DraftItem = { description:string; quantity:string; unitPrice:string };
const blankItem = ():DraftItem => ({description:"",quantity:"1",unitPrice:""});
const money = (cents:number) => new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"}).format(cents/100);
const errorText = (error:unknown) => {
  const text=error instanceof Error?error.message:"No se pudo completar la operación";
  try { return JSON.parse(text.slice(text.indexOf("{"))).error || text; } catch { return text; }
};
const dateValue = (value:FormDataEntryValue|null) => String(value||"");

export default function Sales({offline}:{offline:boolean}) {
  const {data:clients=[],isLoading:clientsLoading,isError:clientsError,refetch:reloadClients}=useQuery<Client[]>({
    queryKey:["sales","clients"],enabled:!offline,staleTime:0,refetchOnMount:"always",
    queryFn:async()=>await (await apiRequest("GET","/api/sales/clients")).json(),
  });
  const {data:estimates=[],isLoading:estimatesLoading,isError:estimatesError,refetch:reloadEstimates}=useQuery<Estimate[]>({
    queryKey:["sales","estimates"],enabled:!offline,staleTime:0,refetchOnMount:"always",
    queryFn:async()=>await (await apiRequest("GET","/api/sales/estimates")).json(),
  });
  const [search,setSearch]=useState("");
  const [clientForm,setClientForm]=useState<Client|null|undefined>(undefined);
  const [estimateForm,setEstimateForm]=useState<Estimate|null|undefined>(undefined);
  const [items,setItems]=useState<DraftItem[]>([blankItem()]);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [message,setMessage]=useState("");
  const [statusForm,setStatusForm]=useState<Estimate|null>(null);
  const visible=useMemo(()=>estimates.filter(e=>
    [e.number,e.client_name,e.title,e.project_name].some(value=>value.toLocaleLowerCase("es").includes(search.toLocaleLowerCase("es")))
  ),[estimates,search]);
  const calculated=(()=>{
    try {return estimateTotalCents(items.map(item=>({
      description:item.description,quantityMilli:Math.round(Number(item.quantity)*1000),
      unitCents:Math.round(Number(item.unitPrice)*100),
    })));} catch {return null;}
  })();
  const close=()=>{setClientForm(undefined);setEstimateForm(undefined);setStatusForm(null);setError("");};
  const editEstimate=(estimate:Estimate|null)=>{
    setEstimateForm(estimate);setError("");
    setItems(estimate?.items.map(i=>({description:i.description,quantity:String(i.quantityMilli/1000),unitPrice:(i.unitCents/100).toFixed(2)}))||[blankItem()]);
  };
  const refresh=async()=>{await Promise.all([
    queryClient.invalidateQueries({queryKey:["sales","clients"]}),
    queryClient.invalidateQueries({queryKey:["sales","estimates"]}),
  ]);};
  async function saveClient(event:React.FormEvent<HTMLFormElement>) {
    event.preventDefault();setBusy(true);setError("");
    const form=new FormData(event.currentTarget);
    const data={name:dateValue(form.get("name")),contact:dateValue(form.get("contact")),
      email:dateValue(form.get("email")),phone:dateValue(form.get("phone")),
      address:dateValue(form.get("address")),note:dateValue(form.get("note")),
      ...(clientForm?{revision:clientForm.revision}:{})};
    try {
      await apiRequest(clientForm?"PATCH":"POST",clientForm?`/api/sales/clients/${clientForm.id}`:"/api/sales/clients",data);
      await refresh();close();setMessage("Ficha de cliente guardada.");
    } catch(err) {setError(errorText(err));} finally {setBusy(false);}
  }
  async function saveEstimate(event:React.FormEvent<HTMLFormElement>) {
    event.preventDefault();setError("");
    const form=new FormData(event.currentTarget);
    const parsed:Item[]=[];
    for (const item of items) {
      const q=Number(item.quantity), price=Number(item.unitPrice);
      if (!item.description.trim()||!Number.isFinite(q)||q<=0||!Number.isFinite(price)||price<0
          ||Math.abs(q*1000-Math.round(q*1000))>1e-6||Math.abs(price*100-Math.round(price*100))>1e-6) {
        setError("Cada partida necesita descripción, cantidad de hasta tres decimales y precio USD de hasta dos decimales.");
        return;
      }
      parsed.push({description:item.description.trim(),quantityMilli:Math.round(q*1000),unitCents:Math.round(price*100)});
    }
    const data={clientId:Number(form.get("clientId")),title:dateValue(form.get("title")),
      projectName:dateValue(form.get("projectName")),validUntil:dateValue(form.get("validUntil")),
      scope:dateValue(form.get("scope")),note:dateValue(form.get("note")),
      items:parsed,...(estimateForm?{revision:estimateForm.revision}:{})};
    setBusy(true);
    try {
      await apiRequest(estimateForm?"PATCH":"POST",estimateForm?`/api/sales/estimates/${estimateForm.id}`:"/api/sales/estimates",data);
      await refresh();close();setMessage("Estimado guardado como borrador. No se envió al cliente ni se creó un contrato.");
    } catch(err) {setError(errorText(err));} finally {setBusy(false);}
  }
  async function changeStatus(event:React.FormEvent<HTMLFormElement>) {
    event.preventDefault();if(!statusForm)return;
    const form=new FormData(event.currentTarget);
    const status=dateValue(form.get("status"));
    if(status==="aceptado"&&!window.confirm("¿Confirmas que existe aceptación del cliente y que la referencia ingresada se puede verificar? El estimado quedará cerrado para edición."))return;
    setBusy(true);setError("");
    try {
      await apiRequest("PATCH",`/api/sales/estimates/${statusForm.id}/status`,{
        status,reference:dateValue(form.get("reference")),revision:statusForm.revision,
      });
      await refresh();close();setMessage("Estado actualizado. Este registro no envió mensajes ni creó un contrato.");
    } catch(err) {setError(errorText(err));} finally {setBusy(false);}
  }
  async function downloadEstimate(id:number) {
    setError("");
    try {
      const response=await apiRequest("GET",`/api/sales/estimates/${id}/pdf`);
      const url=URL.createObjectURL(await response.blob());
      const anchor=document.createElement("a");anchor.href=url;anchor.download=`EST-${String(id).padStart(6,"0")}.pdf`;
      anchor.click();setTimeout(()=>URL.revokeObjectURL(url),60000);
    } catch(err) {setError(errorText(err));}
  }
  return <div className="sales" data-testid="sales-area">
    <div className="tracking-intro"><div><span className="eyebrow">ÁREA COMERCIAL · USD</span><h2>Clientes y estimados</h2>
      <p>Fichas de clientes y presupuestos con partidas. Área independiente de nómina, cuentas por cobrar y contratos.</p></div>
      {!offline&&<div className="sales-actions"><button className="btn outline" onClick={()=>{setClientForm(null);setError("");}} data-testid="button-new-client"><Plus size={16}/> Nuevo cliente</button>
      <button className="btn primary" disabled={!clients.length} onClick={()=>editEstimate(null)} data-testid="button-new-estimate"><Plus size={16}/> Nuevo estimado</button></div>}</div>
    <div className="scope-note">El estimado PDF no es un contrato ni acredita firma digital. Los estados son registros internos; no se envía automáticamente al cliente ni se crea una factura.</div>
    {offline&&<div className="feedback error" role="alert">Clientes y estimados requieren conexión. No se guardan en la copia local.</div>}
    {(clientsError||estimatesError)&&<div className="feedback error" role="alert">No se pudo cargar el área comercial. <button type="button" onClick={()=>{reloadClients();reloadEstimates();}}>Reintentar</button></div>}
    {message&&<div className="feedback success" role="status">{message}</div>}
    {error&&clientForm===undefined&&estimateForm===undefined&&!statusForm&&<div className="feedback error" role="alert">{error}</div>}
    {!offline&&<><section className="panel"><div className="panel-head"><div><h2>Directorio de clientes</h2><p>{clients.length} ficha(s). Una ficha puede aparecer en varios estimados.</p></div></div>
      {clientsLoading?<p className="preflight-message">Cargando clientes…</p>:clients.length?<div className="sales-client-list">{clients.map(c=><div className="sales-client" key={c.id}>
        <div><strong>{c.name}</strong><small>{[c.contact,c.email,c.phone].filter(Boolean).join(" · ")||"Sin datos de contacto"}</small><small>{c.address||"Sin dirección"}</small></div>
        <button className="table-action" type="button" onClick={()=>{setClientForm(c);setError("");}} data-testid={`button-edit-client-${c.id}`}>Editar ficha</button>
      </div>)}</div>:<div className="empty"><h3>Aún no hay clientes</h3><p>Agrega la primera ficha para preparar un estimado.</p></div>}</section>
      <section className="panel"><div className="panel-head"><div><h2>Estimados</h2><p>Numeración única automática. Las partidas y el total se guardan juntos; un estimado aceptado queda cerrado.</p></div></div>
        <div className="sales-search"><label className="field"><span>Buscar estimado, cliente o proyecto</span><input value={search} onChange={e=>setSearch(e.target.value)} data-testid="input-search-estimates"/></label></div>
        {estimatesLoading?<p className="preflight-message">Cargando estimados…</p>:visible.length?<div className="sales-estimates">{visible.map(e=><article key={e.id} className="sales-estimate" data-testid={`estimate-${e.id}`}>
          <div className="sales-estimate-heading"><div><span className="eyebrow">{e.number} · {e.status.replace("_"," ")}</span><h3>{e.title}</h3><p>{e.client_name}{e.project_name?` · ${e.project_name}`:""}</p></div><strong>{money(e.total_cents)}</strong></div>
          <p>{e.items.length} partida(s) · Vigencia: {e.valid_until||"Sin definir"}{e.reference?` · Referencia: ${e.reference}`:""}</p>
          <div className="sales-estimate-actions"><button className="btn outline" type="button" onClick={()=>downloadEstimate(e.id)} data-testid={`button-estimate-pdf-${e.id}`}><ArrowDownToLine size={16}/> PDF</button>
            {e.status==="borrador"&&<button className="btn outline" type="button" onClick={()=>editEstimate(e)} data-testid={`button-edit-estimate-${e.id}`}>Editar partidas</button>}
            {(e.status==="borrador"||e.status==="en_revision")&&<button className="btn outline" type="button" onClick={()=>{setStatusForm(e);setError("");}} data-testid={`button-status-estimate-${e.id}`}>Cambiar estado</button>}
          </div></article>)}</div>:<div className="empty"><h3>{estimates.length?"Sin coincidencias":"No hay estimados"}</h3><p>{estimates.length?"Prueba otra búsqueda.":"Crea un cliente y prepara el primer borrador."}</p></div>}
      </section></>}
    {clientForm!==undefined&&<div className="overlay" role="presentation" onMouseDown={e=>{if(e.target===e.currentTarget)close();}}><div className="dialog" role="dialog" aria-modal="true" aria-label={clientForm?"Editar cliente":"Nuevo cliente"}>
      <div className="dialog-head"><div><span className="eyebrow">DIRECTORIO</span><h2>{clientForm?"Editar cliente":"Nuevo cliente"}</h2></div><button className="icon-button" type="button" aria-label="Cerrar" onClick={close}><X size={18}/></button></div>
      <form className="dialog-body" onSubmit={saveClient}><div className="form-grid">
        <label className="field"><span>Cliente / razón social</span><input name="name" required minLength={2} maxLength={180} defaultValue={clientForm?.name||""} data-testid="input-client-name"/></label>
        <label className="field"><span>Contacto</span><input name="contact" maxLength={160} defaultValue={clientForm?.contact||""}/></label>
        <label className="field"><span>Correo</span><input name="email" type="email" defaultValue={clientForm?.email||""}/></label>
        <label className="field"><span>Teléfono</span><input name="phone" maxLength={40} defaultValue={clientForm?.phone||""}/></label>
      </div><label className="field"><span>Dirección</span><input name="address" maxLength={300} defaultValue={clientForm?.address||""}/></label>
      <label className="field"><span>Notas internas</span><textarea name="note" rows={3} maxLength={1500} defaultValue={clientForm?.note||""}/></label>
      {error&&<div className="feedback error" role="alert">{error}</div>}
      <div className="dialog-actions"><button className="btn outline" type="button" onClick={close}>Cancelar</button><button className="btn primary" disabled={busy} type="submit" data-testid="button-save-client">{busy?"Guardando…":"Guardar cliente"}</button></div></form>
    </div></div>}
    {estimateForm!==undefined&&<div className="overlay" role="presentation" onMouseDown={e=>{if(e.target===e.currentTarget)close();}}><div className="dialog sales-dialog" role="dialog" aria-modal="true" aria-label={estimateForm?"Editar estimado":"Nuevo estimado"}>
      <div className="dialog-head"><div><span className="eyebrow">ESTIMADO EN USD</span><h2>{estimateForm?`Editar ${estimateForm.number}`:"Nuevo estimado"}</h2></div><button className="icon-button" type="button" aria-label="Cerrar" onClick={close}><X size={18}/></button></div>
      <form className="dialog-body" onSubmit={saveEstimate}><div className="form-grid">
        <label className="field"><span>Cliente</span><select name="clientId" required defaultValue={estimateForm?.client_id||""} data-testid="select-estimate-client"><option value="" disabled>Selecciona un cliente</option>{clients.map(c=><option value={c.id} key={c.id}>{c.name}</option>)}</select></label>
        <label className="field"><span>Título / trabajo</span><input name="title" required minLength={2} maxLength={180} defaultValue={estimateForm?.title||""} data-testid="input-estimate-title"/></label>
        <label className="field"><span>Nombre del proyecto</span><input name="projectName" maxLength={180} defaultValue={estimateForm?.project_name||""}/></label>
        <label className="field"><span>Vigente hasta (opcional)</span><input name="validUntil" type="date" defaultValue={estimateForm?.valid_until||""}/></label>
      </div><label className="field"><span>Alcance</span><textarea name="scope" rows={3} maxLength={2500} defaultValue={estimateForm?.scope||""}/></label>
      <div className="sales-items"><div className="sales-items-header"><h3>Partidas</h3><button className="btn outline" type="button" disabled={items.length>=60} onClick={()=>setItems(v=>[...v,blankItem()])} data-testid="button-add-estimate-item"><Plus size={15}/> Añadir partida</button></div>
        {items.map((item,index)=><div className="sales-item" key={index} data-testid={`estimate-item-${index}`}>
          <label className="field"><span>Descripción {index+1}</span><input required maxLength={500} value={item.description} onChange={e=>setItems(v=>v.map((x,i)=>i===index?{...x,description:e.target.value}:x))} data-testid={`input-item-description-${index}`}/></label>
          <label className="field"><span>Cantidad</span><input required type="number" min=".001" max="10000" step=".001" value={item.quantity} onChange={e=>setItems(v=>v.map((x,i)=>i===index?{...x,quantity:e.target.value}:x))} data-testid={`input-item-quantity-${index}`}/></label>
          <label className="field"><span>USD / unidad</span><input required type="number" min="0" step=".01" value={item.unitPrice} onChange={e=>setItems(v=>v.map((x,i)=>i===index?{...x,unitPrice:e.target.value}:x))} data-testid={`input-item-price-${index}`}/></label>
          <button className="table-action" type="button" disabled={items.length===1} onClick={()=>setItems(v=>v.filter((_,i)=>i!==index))} data-testid={`button-remove-estimate-item-${index}`}>Quitar</button>
        </div>)}</div>
      <p className="sales-total">Total calculado <strong data-testid="text-estimate-total">{calculated===null?"Revisa las partidas":money(calculated)}</strong></p>
      <label className="field"><span>Observaciones</span><textarea name="note" rows={2} maxLength={1500} defaultValue={estimateForm?.note||""}/></label>
      {error&&<div className="feedback error" role="alert">{error}</div>}
      <div className="dialog-actions"><button className="btn outline" type="button" onClick={close}>Cancelar</button><button className="btn primary" type="submit" disabled={busy} data-testid="button-save-estimate">{busy?"Guardando…":"Guardar borrador"}</button></div></form>
    </div></div>}
    {statusForm&&<div className="overlay" role="presentation" onMouseDown={e=>{if(e.target===e.currentTarget)close();}}><div className="dialog" role="dialog" aria-modal="true" aria-label="Cambiar estado del estimado">
      <div className="dialog-head"><div><span className="eyebrow">{statusForm.number}</span><h2>Registrar estado</h2></div><button className="icon-button" type="button" aria-label="Cerrar" onClick={close}><X size={18}/></button></div>
      <form className="dialog-body" onSubmit={changeStatus}><p>La aceptación se registra de forma interna y exige una referencia comprobable. No constituye firma digital ni convierte el estimado en contrato.</p>
        <label className="field"><span>Estado</span><select name="status" required defaultValue={statusForm.status} data-testid="select-estimate-status"><option value="borrador">Borrador</option><option value="en_revision">En revisión</option><option value="aceptado">Aceptado (referencia obligatoria)</option><option value="rechazado">Rechazado</option></select></label>
        <label className="field"><span>Referencia de decisión / aceptación</span><input name="reference" maxLength={250} defaultValue={statusForm.reference||""} data-testid="input-estimate-reference"/></label>
        {error&&<div className="feedback error" role="alert">{error}</div>}
        <div className="dialog-actions"><button className="btn outline" type="button" onClick={close}>Cancelar</button><button className="btn primary" type="submit" disabled={busy} data-testid="button-save-estimate-status">Guardar estado</button></div>
      </form></div></div>}
  </div>;
}
