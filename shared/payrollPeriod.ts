/** A payroll period runs Saturday through the following Friday.
 * It can be generated on any day, including before the period ends. */
export function payrollPeriod(start:string) {
  const saturday = new Date(`${start}T12:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) ||
      Number.isNaN(saturday.getTime()) ||
      saturday.toISOString().slice(0,10) !== start ||
      saturday.getUTCDay() !== 6)
    throw new Error("El inicio debe ser un sábado válido");
  const end = new Date(saturday);
  end.setUTCDate(end.getUTCDate() + 6);
  return { weekStart:start, weekEnd:end.toISOString().slice(0,10) };
}

/** Saturday of the most recent period that ends on or before today
 * (on a Friday this is the current week). */
export function latestReadySaturday(today:string) {
  const date = new Date(`${today}T12:00:00Z`);
  if(Number.isNaN(date.getTime())) throw new Error("Fecha actual inválida");
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 2) % 7) - 6);
  return date.toISOString().slice(0,10);
}
