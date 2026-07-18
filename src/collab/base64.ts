export function toBase64(data: Uint8Array): string {
  return Buffer.from(data).toString('base64');
}

export function fromBase64(data: string): Uint8Array {
  return new Uint8Array(Buffer.from(data, 'base64'));
}
