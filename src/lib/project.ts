/** Display name of a project file: the base name without `.json`. */
export function projectName(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const base = path.split(/[\\/]/).pop() ?? path;
  return base.replace(/\.json$/i, "");
}
