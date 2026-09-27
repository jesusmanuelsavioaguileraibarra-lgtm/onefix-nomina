/** A payroll period runs Saturday through the following Friday.
 * It can be submitted starting on the Sunday after that Friday. */
export function payrollPeriod(start:string) {
  const saturday = new Date(`${start}T12:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) ||
      Number.isNaN(saturday.getTime()) ||
      saturday.toISOString().slice(0,10) !== start ||
      saturday.getUTCDay() !== 6)
    throw new Error("El inicio debe ser un sábado válido");
  const end = new Date(saturday);
  end.setUTCDate(end.getUTCDate() + 6);
  const ready = new Date(saturday);
  ready.setUTCDate(ready.getUTCDate() + 8);
  return { weekStart:start, weekEnd:end.toISOString().slice(0,10), availableOn:ready.toISOString().slice(0,10) };
}

export function latestReadySaturday(today:string) {
  const date = new Date(`${today}T12:00:00Z`);
  if(Number.isNaN(date.getTime())) throw new Error("Fecha actual inválida");
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 1) % 7) - 7);
  let candidate = date.toISOString().slice(0,10);
  if (payrollPeriod(candidate).availableOn > today) {
    date.setUTCDate(date.getUTCDate() - 7);
    candidate = date.toISOString().slice(0,10);
  }
  return candidate;
}
