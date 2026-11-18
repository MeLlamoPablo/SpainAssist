/**
 * An incremental update to a PDF: new or changed objects appended after the original bytes, with
 * their own cross-reference section (a classic table, or an xref stream when the file uses them)
 * pointing back to the previous one. The original bytes are never touched, so earlier signatures
 * stay valid. pdf-lib only reads objects here; the update is written by hand.
 */
import crypto from 'node:crypto';
import { PDFArray, PDFDict, PDFDocument, type PDFObject, PDFRef } from 'pdf-lib';
import { AfirmaError } from './errors';
import { isPdf } from './mime';

interface PendingObject {
  ref: PDFRef;
  body: Buffer;
}

function findStartXref(pdf: Buffer): number {
  const tail = pdf.subarray(Math.max(0, pdf.length - 4096)).toString('latin1');
  const all = [...tail.matchAll(/startxref\s+(\d+)/g)];
  const last = all[all.length - 1];
  if (!last) throw AfirmaError.notPdf();
  return Number(last[1]);
}

function previousSize(pdf: Buffer, startXref: number): number {
  const chunk = pdf
    .subarray(startXref, Math.min(pdf.length, startXref + 64 * 1024))
    .toString('latin1');
  if (chunk.startsWith('xref')) {
    const m = /trailer[\s\S]*?\/Size\s+(\d+)/.exec(chunk);
    return m ? Number(m[1]) : 0;
  }
  const m = /\/Size\s+(\d+)/.exec(chunk.slice(0, 4096));
  return m ? Number(m[1]) : 0;
}

export class PdfUpdate {
  readonly ctx: PDFDocument['context'];
  readonly rootRef: PDFRef;
  readonly catalog: PDFDict;
  private readonly prevXref: number;
  private readonly prevIsStream: boolean;
  private nextNumber: number;
  private readonly pending: PendingObject[] = [];

  private constructor(
    readonly original: Buffer,
    readonly doc: PDFDocument,
  ) {
    this.ctx = doc.context;
    const rootRef = this.ctx.trailerInfo.Root;
    if (!(rootRef instanceof PDFRef)) throw AfirmaError.notPdf();
    this.rootRef = rootRef;
    this.catalog = this.ctx.lookup(rootRef, PDFDict);
    this.prevXref = findStartXref(original);
    this.prevIsStream =
      original.subarray(this.prevXref, this.prevXref + 4).toString('latin1') !== 'xref';
    this.nextNumber = Math.max(
      this.ctx.largestObjectNumber + 1,
      previousSize(original, this.prevXref),
    );
  }

  /** Reads `pdf` (an AfirmaError when it isn't one) to append an update to it. */
  static async open(pdf: Buffer): Promise<PdfUpdate> {
    if (!isPdf(pdf)) throw AfirmaError.notPdf();
    let doc: PDFDocument;
    try {
      doc = await PDFDocument.load(pdf, {
        ignoreEncryption: true,
        updateMetadata: false,
        throwOnInvalidObject: false,
      });
    } catch {
      throw AfirmaError.notPdf();
    }
    return new PdfUpdate(pdf, doc);
  }

  newRef(): PDFRef {
    return PDFRef.of(this.nextNumber++, 0);
  }

  /** Adds (or replaces, under the same number) an object in the update. */
  write(ref: PDFRef, obj: PDFObject | string): void {
    this.pending.push({ ref, body: Buffer.from(obj.toString(), 'latin1') });
  }

  writeStream(ref: PDFRef, dict: string, data: Buffer): void {
    this.pending.push({
      ref,
      body: Buffer.concat([
        Buffer.from(`<< ${dict} /Length ${data.length} >>\nstream\n`, 'latin1'),
        data,
        Buffer.from('\nendstream', 'latin1'),
      ]),
    });
  }

  lookupDict(obj: PDFObject | undefined): PDFDict | undefined {
    if (!obj) return undefined;
    const v = obj instanceof PDFRef ? this.ctx.lookup(obj) : obj;
    return v instanceof PDFDict ? v : undefined;
  }

  lookupArray(obj: PDFObject | undefined): PDFArray | undefined {
    if (!obj) return undefined;
    const v = obj instanceof PDFRef ? this.ctx.lookup(obj) : obj;
    return v instanceof PDFArray ? v : undefined;
  }

  /**
   * The original followed by the update. `idSeed` varies the trailer's second /ID. `bodyOffset`
   * gives where each written object's body starts in the result.
   */
  finish(idSeed: string): { pdf: Buffer; bodyOffset(ref: PDFRef): number } {
    const { original, ctx } = this;
    const parts: Buffer[] = [original];
    let offset = original.length;
    const lastByte = original[original.length - 1];
    if (lastByte !== 0x0a && lastByte !== 0x0d) {
      parts.push(Buffer.from('\n'));
      offset += 1;
    }
    const offsets = new Map<number, { offset: number; gen: number }>();
    const bodies = new Map<PDFRef, number>();
    for (const obj of this.pending) {
      const head = Buffer.from(
        `${obj.ref.objectNumber} ${obj.ref.generationNumber} obj\n`,
        'latin1',
      );
      const tail = Buffer.from('\nendobj\n', 'latin1');
      offsets.set(obj.ref.objectNumber, { offset, gen: obj.ref.generationNumber });
      bodies.set(obj.ref, offset + head.length);
      parts.push(head, obj.body, tail);
      offset += head.length + obj.body.length + tail.length;
    }

    const id0 = (() => {
      const id = ctx.trailerInfo.ID;
      const arr = id instanceof PDFArray ? id : undefined;
      const first = arr?.get(0);
      return first ? first.toString() : `<${crypto.randomBytes(16).toString('hex')}>`;
    })();
    const id1 = `<${crypto.createHash('md5').update(original).update(idSeed).digest('hex')}>`;
    const info = ctx.trailerInfo.Info ? `/Info ${ctx.trailerInfo.Info.toString()}\n` : '';
    const root = this.rootRef.toString();
    const xrefStart = offset;
    if (this.prevIsStream) {
      const xrefRef = this.newRef();
      offsets.set(xrefRef.objectNumber, { offset: xrefStart, gen: 0 });
      const numbers = [...offsets.keys()].sort((a, b) => a - b);
      const rows = numbers.map((num) => {
        const e = offsets.get(num) as { offset: number; gen: number };
        const row = Buffer.alloc(7);
        row[0] = 1;
        row.writeUInt32BE(e.offset, 1);
        row.writeUInt16BE(e.gen, 5);
        return row;
      });
      const data = Buffer.concat(rows);
      const index = numbers.map((num) => `${num} 1`).join(' ');
      const dict =
        `<<\n/Type /XRef\n/Size ${this.nextNumber}\n/W [1 4 2]\n/Index [${index}]\n/Root ${root}\n` +
        `${info}/ID [${id0} ${id1}]\n/Prev ${this.prevXref}\n/Length ${data.length}\n>>`;
      parts.push(
        Buffer.from(`${xrefRef.objectNumber} 0 obj\n${dict}\nstream\n`, 'latin1'),
        data,
        Buffer.from(`\nendstream\nendobj\nstartxref\n${xrefStart}\n%%EOF\n`, 'latin1'),
      );
    } else {
      const numbers = [...offsets.keys()].sort((a, b) => a - b);
      let table = 'xref\n';
      for (let i = 0; i < numbers.length; ) {
        let j = i;
        while (j + 1 < numbers.length && numbers[j + 1] === numbers[j] + 1) j++;
        table += `${numbers[i]} ${j - i + 1}\n`;
        for (let k = i; k <= j; k++) {
          const e = offsets.get(numbers[k]) as { offset: number; gen: number };
          table += `${String(e.offset).padStart(10, '0')} ${String(e.gen).padStart(5, '0')} n\r\n`;
        }
        i = j + 1;
      }
      table +=
        `trailer\n<<\n/Size ${this.nextNumber}\n/Root ${root}\n${info}` +
        `/ID [${id0} ${id1}]\n/Prev ${this.prevXref}\n>>\nstartxref\n${xrefStart}\n%%EOF\n`;
      parts.push(Buffer.from(table, 'latin1'));
    }
    const pdf = Buffer.concat(parts);
    return {
      pdf,
      bodyOffset: (ref) => {
        const at = bodies.get(ref);
        if (at === undefined) throw AfirmaError.internal('Objeto PDF no escrito');
        return at;
      },
    };
  }
}
