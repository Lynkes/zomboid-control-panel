// Shared constructor-bytecode reader for the jar-audit extractors
// (extract-sandbox-options.mjs, extract-server-options.mjs). Both read a
// class whose option table is a straight run of literal constructor calls,
// so a structural class-file + Code-attribute walk recovers every option's
// real bounds straight off the constant pool. Moved here verbatim from
// extract-sandbox-options.mjs when the ServerOptions extractor needed the
// same reader (GH#182); no behavior change for the sandbox extractor.

// ---- minimal structural class-file parser (constant pool + one method's
// Code attribute) -- self-contained rather than extending
// classfile-parser.mjs, which deliberately skips attribute bodies
// (bytecode) entirely; see that file's own header for why. Correctly
// reconstructs IEEE754 double constants (the shared parser's generic
// Long/Double handling combines the two halves with plain arithmetic,
// which is right for a signed 64-bit long but NOT for a double's bit
// pattern -- this parser reads the 8 bytes into a Buffer and uses
// readDoubleBE, which is).
export function parseClassFile(buf) {
  let p = 0;
  const u1 = () => buf[p++];
  const u2 = () => { const v = buf.readUInt16BE(p); p += 2; return v; };
  const u4 = () => { const v = buf.readUInt32BE(p); p += 4; return v; };

  if (u4() !== 0xcafebabe) throw new Error("not a Java class file");
  u2(); u2(); // minor, major

  const cpCount = u2();
  const cp = new Array(cpCount);
  for (let i = 1; i < cpCount; i++) {
    const tag = u1();
    switch (tag) {
      case 1: { const len = u2(); cp[i] = { tag, value: buf.slice(p, p + len).toString("utf8") }; p += len; break; }
      case 7: case 8: case 16: case 19: case 20: cp[i] = { tag, ref: u2() }; break;
      case 15: cp[i] = { tag, refKind: u1(), ref: u2() }; break;
      case 9: case 10: case 11: case 12: case 17: case 18: cp[i] = { tag, ref1: u2(), ref2: u2() }; break;
      case 3: cp[i] = { tag, value: buf.readInt32BE(p) }; p += 4; break; // Integer
      case 4: cp[i] = { tag, value: buf.readFloatBE(p) }; p += 4; break; // Float
      case 5: cp[i] = { tag, value: buf.readBigInt64BE(p) }; p += 8; i++; break; // Long (2 slots)
      case 6: cp[i] = { tag, value: buf.readDoubleBE(p) }; p += 8; i++; break; // Double (2 slots)
      default: throw new Error(`unknown constant pool tag ${tag} at index ${i}`);
    }
  }
  const utf8 = (idx) => (cp[idx] && cp[idx].tag === 1 ? cp[idx].value : null);

  u2(); // access_flags
  u2(); // this_class
  u2(); // super_class
  const ifaceCount = u2();
  p += ifaceCount * 2;

  function skipAttributes() {
    const count = u2();
    for (let i = 0; i < count; i++) { u2(); const len = u4(); p += len; }
  }
  const fieldsCount = u2();
  for (let i = 0; i < fieldsCount; i++) { u2(); u2(); u2(); skipAttributes(); }

  const methodsCount = u2();
  const methods = [];
  for (let i = 0; i < methodsCount; i++) {
    u2(); // access_flags
    const nameIdx = u2();
    const descIdx = u2();
    const attrCount = u2();
    let codeBytes = null;
    for (let a = 0; a < attrCount; a++) {
      const attrNameIdx = u2();
      const len = u4();
      const attrName = utf8(attrNameIdx);
      const attrEnd = p + len;
      if (attrName === "Code") {
        u2(); // max_stack
        u2(); // max_locals
        const codeLen = u4();
        codeBytes = buf.slice(p, p + codeLen);
      }
      p = attrEnd;
    }
    methods.push({ name: utf8(nameIdx), descriptor: utf8(descIdx), codeBytes });
  }
  return { cp, methods };
}

// Operand byte-length for every standard JVM opcode with a fixed-size
// immediate operand (JVMS 6.5); everything not listed here takes 0.
// tableswitch/lookupswitch/wide are variable-length and handled specially
// below -- a straight-line constructor calling factory methods in sequence
// is never expected to contain one, so hitting one is treated as fatal
// (loud failure beats silently misreading the rest of the stream).
export const FIXED_OPERAND_LEN = {
  0x10: 1, 0x11: 2, 0x12: 1, 0x13: 2, 0x14: 2, // bipush sipush ldc ldc_w ldc2_w
  0x15: 1, 0x16: 1, 0x17: 1, 0x18: 1, 0x19: 1, // iload lload fload dload aload
  0x36: 1, 0x37: 1, 0x38: 1, 0x39: 1, 0x3a: 1, // istore lstore fstore dstore astore
  0x84: 2, // iinc
  0x99: 2, 0x9a: 2, 0x9b: 2, 0x9c: 2, 0x9d: 2, 0x9e: 2, // ifeq..ifle
  0x9f: 2, 0xa0: 2, 0xa1: 2, 0xa2: 2, 0xa3: 2, 0xa4: 2, // if_icmp*
  0xa5: 2, 0xa6: 2, // if_acmp*
  0xa7: 2, 0xa8: 2, 0xa9: 1, // goto jsr ret
  0xb2: 2, 0xb3: 2, 0xb4: 2, 0xb5: 2, // getstatic putstatic getfield putfield
  0xb6: 2, 0xb7: 2, 0xb8: 2, // invokevirtual invokespecial invokestatic
  0xb9: 4, 0xba: 4, // invokeinterface invokedynamic
  0xbb: 2, 0xbc: 1, 0xbd: 2, // new newarray anewarray
  0xc0: 2, 0xc1: 2, // checkcast instanceof
  0xc5: 3, 0xc6: 2, 0xc7: 2, // multianewarray ifnull ifnonnull
  0xc8: 4, 0xc9: 4, // goto_w jsr_w
};
export const VARIABLE_LEN_OPCODES = new Set([0xaa, 0xab, 0xc4]); // tableswitch lookupswitch wide

// Decodes a Code attribute's raw bytes into {op, cpIndex?}[] -- cpIndex is
// resolved for the opcodes this extractor actually cares about (ldc/
// ldc_w/ldc2_w, putfield, invoke*); every other opcode with operands is
// correctly SKIPPED (so the stream stays in sync) but not decoded further.
export function decodeCode(codeBytes) {
  const instrs = [];
  let p = 0;
  while (p < codeBytes.length) {
    const op = codeBytes[p];
    const start = p;
    p += 1;
    if (VARIABLE_LEN_OPCODES.has(op)) {
      throw new Error(`hit variable-length opcode 0x${op.toString(16)} at offset ${start} -- extractor does not support tableswitch/lookupswitch/wide`);
    }
    const len = FIXED_OPERAND_LEN[op] || 0;
    let cpIndex = null;
    if (op === 0x12) cpIndex = codeBytes[p]; // ldc: 1-byte index
    else if (op === 0x13 || op === 0x14) cpIndex = codeBytes.readUInt16BE(p); // ldc_w/ldc2_w: 2-byte
    else if (len === 2 && (op === 0xb2 || op === 0xb3 || op === 0xb4 || op === 0xb5 || op === 0xb6 || op === 0xb7 || op === 0xb8 || op === 0xbb || op === 0xc0 || op === 0xc1)) {
      cpIndex = codeBytes.readUInt16BE(p);
    }
    instrs.push({ op, cpIndex });
    p += len;
  }
  return instrs;
}

export function constValue(cp, idx) {
  const entry = cp[idx];
  if (!entry) return null;
  if (entry.tag === 1) return entry.value; // Utf8 (used for e.g. String constant's ref target)
  if (entry.tag === 3) return entry.value; // Integer
  if (entry.tag === 4) return entry.value; // Float
  if (entry.tag === 5) return entry.value; // Long (BigInt)
  if (entry.tag === 6) return entry.value; // Double
  if (entry.tag === 8) return constValue(cp, entry.ref); // String -> its Utf8
  return null;
}

export const OPCODE_INT_PUSH = {
  0x02: -1, 0x03: 0, 0x04: 1, 0x05: 2, 0x06: 3, 0x07: 4, 0x08: 5, // iconst_m1..5
};

// bipush/sipush operands need the raw immediate byte(s), not a cp lookup --
// re-decode with immediates attached (decodeCode() above only resolves
// cpIndex for opcodes that need one; this second pass adds `imm` for the
// two integer-immediate opcodes extractOptions() also consumes).
export function decodeCodeWithImmediates(codeBytes) {
  const instrs = decodeCode(codeBytes);
  let p = 0;
  for (const instr of instrs) {
    const { op } = instr;
    p += 1;
    if (op === 0x10) instr.imm = codeBytes.readInt8(p);
    else if (op === 0x11) instr.imm = codeBytes.readInt16BE(p);
    p += FIXED_OPERAND_LEN[op] || 0;
  }
  return instrs;
}
