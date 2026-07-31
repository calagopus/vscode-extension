export function joinPath(directory: string, name: string): string {
  return directory === '/' ? `/${name}` : `${directory}/${name}`;
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

export function dirname(path: string): string {
  return splitPath(path).parent;
}

export function splitPath(path: string): { parent: string; name: string } {
  const trimmed = path.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return {
    parent: idx <= 0 ? '/' : trimmed.slice(0, idx),
    name: trimmed.slice(idx + 1),
  };
}
