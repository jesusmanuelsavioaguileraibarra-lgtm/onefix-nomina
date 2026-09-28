export type DueInvoice = {
  id:number;
  invoice_number:string;
  client:string;
  job:string;
  due_date:string|null;
  cancelled:boolean;
  review_reasons:string;
  balance_2025_cents:number|null;
  balance_2026_cents:number|null;
};

export function invoiceBalance(item:DueInvoice):number|null {
  if(item.balance_2025_cents===null && item.balance_2026_cents===null)return null;
  return (item.balance_2025_cents||0)+(item.balance_2026_cents||0);
}

function validDate(value:string|null):value is string {
  return !!value && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(`${value}T12:00:00Z`)) &&
    new Date(`${value}T12:00:00Z`).toISOString().slice(0,10)===value;
}

export function dueStatus(item:DueInvoice,today:string) {
  if(item.cancelled)return "Cancelada";
  if(!item.invoice_number.startsWith("INV"))return "Sin factura emitida";
  if(!item.due_date)return "Sin vencimiento";
  const balance=invoiceBalance(item);
  if(balance===null)return "Saldo no indicado";
  if(balance<=0)return "Sin saldo positivo";
  if(!validDate(item.due_date))return "Fecha por verificar";
  if(item.due_date<today)return "Vencida";
  const sevenDays=new Date(Date.parse(`${today}T12:00:00Z`)+7*86400000).toISOString().slice(0,10);
  if(item.due_date<=sevenDays)return "Próxima";
  return "Vigente";
}

export function summarizeDueInvoices(items:DueInvoice[],today:string) {
  const overdue:DueInvoice[]=[];
  const upcoming:DueInvoice[]=[];
  const undated:DueInvoice[]=[];
  const review:DueInvoice[]=[];
  for(const item of items){
    if(item.cancelled || !item.invoice_number.startsWith("INV"))continue;
    const balance=invoiceBalance(item);
    if(item.review_reasons || balance===null || (item.due_date!==null && !validDate(item.due_date))){
      review.push(item);
      continue;
    }
    if(balance<=0)continue;
    if(!item.due_date){undated.push(item);continue;}
    const status=dueStatus(item,today);
    if(status==="Vencida")overdue.push(item);
    if(status==="Próxima")upcoming.push(item);
  }
  const byDate=(a:DueInvoice,b:DueInvoice)=>(a.due_date||"").localeCompare(b.due_date||"")||a.id-b.id;
  overdue.sort(byDate);
  upcoming.sort(byDate);
  return {
    overdue,upcoming,undated,review,
    overdueCents:overdue.reduce((sum,item)=>sum+(invoiceBalance(item)||0),0),
    upcomingCents:upcoming.reduce((sum,item)=>sum+(invoiceBalance(item)||0),0),
  };
}
