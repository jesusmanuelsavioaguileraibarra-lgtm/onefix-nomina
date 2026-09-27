type ContractRecord = { id:number; authorizedAmount:number };
type TaskRecord = { id:number; contractId:number|null; personId:number; amount:number; approved:boolean; payrollId:number|null };
type PayrollRecord = { id:number; lines:{ personId:number; paid:boolean }[] };

export function contractLedger(contract:ContractRecord,tasks:TaskRecord[],payrolls:PayrollRecord[]) {
  const linked=tasks.filter(task=>task.contractId===contract.id);
  const approved=linked.filter(task=>task.approved);
  const cents=(amount:number)=>Math.round(amount*100);
  const total=(items:TaskRecord[])=>items.reduce((sum,task)=>sum+cents(task.amount),0)/100;
  const included=approved.filter(task=>task.payrollId !== null);
  const markedPaid=included.filter(task=>payrolls.some(p=>p.id===task.payrollId&&p.lines.some(line=>line.personId===task.personId&&line.paid)));
  const confirmed=total(approved);
  return {
    pending:total(linked.filter(task=>!task.approved)),
    confirmed,
    included:total(included),
    markedPaid:total(markedPaid),
    toInclude:total(approved.filter(task=>task.payrollId===null)),
    remaining:(cents(contract.authorizedAmount)-cents(confirmed))/100,
  };
}
