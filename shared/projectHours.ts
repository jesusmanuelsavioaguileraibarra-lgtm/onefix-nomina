export type ProjectHoursEntry = { projectName: string; hours: number };
export type ProjectHourAllocation = {
  projectName: string;
  regularHours: number;
  overtimeHours: number;
};

// The main project gets the hours not entered for another project. Overtime
// follows the proportion of effective hours so the distribution does not
// assume an order in which projects were worked.
export function distributeProjectHours(
  effectiveHours: number,
  overtimeHours: number,
  mainProject: string,
  otherProjects: ProjectHoursEntry[],
): { primaryHours: number; allocations: ProjectHourAllocation[] } {
  if (!Number.isFinite(effectiveHours) || effectiveHours <= 0
    || !Number.isFinite(overtimeHours) || overtimeHours < 0 || overtimeHours > effectiveHours)
    throw new Error("Revisa las horas efectivas y las horas extra de la jornada.");
  const names = [mainProject, ...otherProjects.map(p => p.projectName)].map(name => name.trim().toLocaleLowerCase());
  if (names.some(name => !name)) throw new Error("Indica el nombre de cada proyecto.");
  if (new Set(names).size !== names.length) throw new Error("No repitas el mismo proyecto en la distribución.");
  if (otherProjects.some(p => !Number.isFinite(p.hours) || p.hours <= 0 || p.hours > 24))
    throw new Error("Indica las horas efectivas de cada proyecto adicional, mayores que cero.");

  const otherTotal = otherProjects.reduce((total, project) => total + project.hours, 0);
  const primaryHours = effectiveHours - otherTotal;
  if (primaryHours < 0.000001)
    throw new Error("Deja horas efectivas para el proyecto principal; cambia el proyecto principal si toda la jornada fue en otra obra.");

  const secondary = otherProjects.map(project => {
    const extra = Number((overtimeHours * project.hours / effectiveHours).toFixed(6));
    return {
      projectName: project.projectName.trim(),
      regularHours: project.hours - extra,
      overtimeHours: extra,
    };
  });
  const mainExtra = overtimeHours - secondary.reduce((total, project) => total + project.overtimeHours, 0);
  const mainRegular = effectiveHours - overtimeHours
    - secondary.reduce((total, project) => total + project.regularHours, 0);
  return {
    primaryHours,
    allocations: [
      { projectName: mainProject.trim(), regularHours: mainRegular, overtimeHours: mainExtra },
      ...secondary,
    ],
  };
}
