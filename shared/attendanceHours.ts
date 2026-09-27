const minutesOfDay = (time: string) => {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error("Hora de entrada o salida inválida");
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
};

export function calculateAttendanceHours(timeIn: string, timeOut: string, breakMinutes: number, overtime: number) {
  const start = minutesOfDay(timeIn);
  const end = minutesOfDay(timeOut);
  if (start === end) throw new Error("La entrada y la salida no pueden ser iguales");
  const shiftMinutes = (end - start + 1440) % 1440;
  if (!Number.isInteger(breakMinutes) || breakMinutes < 0 || breakMinutes >= shiftMinutes)
    throw new Error("El descanso debe ser menor que la duración del turno");
  const worked = (shiftMinutes - breakMinutes) / 60;
  if (!Number.isFinite(overtime) || overtime < 0 || overtime > worked)
    throw new Error("Las horas extra no pueden superar las horas trabajadas");
  return { worked, regular: worked - overtime };
}
