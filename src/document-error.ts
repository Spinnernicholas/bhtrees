export class DocumentError extends TypeError {
  constructor(public readonly path: string, message: string) { super(`${path}: ${message}`); this.name = 'DocumentError'; }
}
