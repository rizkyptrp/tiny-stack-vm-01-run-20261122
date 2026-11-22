// Tiny stack VM for make.fun's tiny-stack-vm-01 ISA (ISA.md in the kit).
// 32-bit wrapping ints, 256-value data stack, 64-deep call stack, 256 words
// of memory, 1,000,000 steps, 65,536 output bytes, ten traps (exit 2..11).
// Runs every /input/<id>/ program and writes /output/<id>/stdout.bin + exit.txt.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function run(p: Uint8Array, q: Uint8Array): { o: Uint8Array; c: number } {
  const D = new Int32Array(256);
  const C = new Int32Array(64);
  const M = new Int32Array(256);
  const o = new Uint8Array(65536);
  let sp = 0, cp = 0, pc = 0, st = 0, ip = 0, ol = 0;
  const n = p.length;
  const end = (c: number): { o: Uint8Array; c: number } => ({ o: o.slice(0, ol), c });
  for (;;) {
    if (st === 1000000) return end(10); // step limit
    if (pc < 0 || pc >= n) return end(9); // pc outside the program
    const op = p[pc];
    // Immediate bytes, pops and pushes of this opcode (0 = unknown, except
    // HALT 0x00 and RET 0x34 which take no immediate and touch no stack).
    let im = 0, po = 0, pu = 0;
    if (op === 1) { im = 1; pu = 1; } // PUSH8
    else if (op === 2) { im = 4; pu = 1; } // PUSH32
    else if (op === 3) po = 1; // POP
    else if (op === 4) { po = 1; pu = 2; } // DUP
    else if (op === 5) { po = 2; pu = 2; } // SWAP
    else if (op === 6) { po = 2; pu = 3; } // OVER
    else if (op === 7) { po = 3; pu = 3; } // ROT
    else if (op === 0x17 || op === 0x1b) { po = 1; pu = 1; } // NEG, NOT
    else if (op === 0x30 || op === 0x33) im = 2; // JMP, CALL
    else if (op === 0x31 || op === 0x32) { im = 2; po = 1; } // JZ, JNZ
    else if (op === 0x40) { po = 1; pu = 1; } // LOAD
    else if (op === 0x41) po = 2; // STORE
    else if (op === 0x50 || op === 0x51 || op === 0x53) po = 1; // PRINT, PUTC, EXIT
    else if (op === 0x52) pu = 1; // IN
    else if ((op >= 0x10 && op <= 0x16) || (op >= 0x18 && op <= 0x1a) || (op >= 0x1c && op <= 0x1e) || (op >= 0x20 && op <= 0x22)) { po = 2; pu = 1; } // binary ops
    else if (op !== 0 && op !== 0x34) return end(5); // unknown opcode
    if (pc + im >= n) return end(9); // immediate cut off by the program's end
    st++;
    const nx = pc + 1 + im;
    if (sp < po) return end(2); // stack underflow
    if (sp - po + pu > 256) return end(3); // stack overflow
    pc = nx;
    switch (op) {
      case 0: return end(0); // HALT
      case 1: D[sp++] = (p[nx - 1] << 24) >> 24; break; // PUSH8, sign-extended
      case 2: D[sp++] = p[nx - 4] | (p[nx - 3] << 8) | (p[nx - 2] << 16) | (p[nx - 1] << 24); break; // PUSH32
      case 3: sp--; break; // POP
      case 4: D[sp] = D[sp - 1]; sp++; break; // DUP
      case 5: { const t = D[sp - 1]; D[sp - 1] = D[sp - 2]; D[sp - 2] = t; break; } // SWAP
      case 6: D[sp] = D[sp - 2]; sp++; break; // OVER
      case 7: { const a = D[sp - 3]; D[sp - 3] = D[sp - 2]; D[sp - 2] = D[sp - 1]; D[sp - 1] = a; break; } // ROT
      case 0x17: D[sp - 1] = -D[sp - 1] | 0; break; // NEG, wraps
      case 0x1b: D[sp - 1] = ~D[sp - 1]; break; // NOT
      case 0x30: case 0x31: case 0x32: { // JMP, JZ, JNZ
        const rel = ((p[nx - 2] | (p[nx - 1] << 8)) << 16) >> 16;
        if (op === 0x30) { pc = nx + rel; break; }
        const v = D[--sp];
        if ((op === 0x31) === (v === 0)) pc = nx + rel;
        break;
      }
      case 0x33: // CALL
        if (cp === 64) return end(7); // call stack overflow
        C[cp++] = nx;
        pc = p[nx - 2] | (p[nx - 1] << 8);
        break;
      case 0x34: // RET
        if (cp === 0) return end(8); // empty call stack
        pc = C[--cp];
        break;
      case 0x40: { // LOAD
        const a = D[sp - 1];
        if (a < 0 || a > 255) return end(6);
        D[sp - 1] = M[a];
        break;
      }
      case 0x41: { // STORE
        const a = D[sp - 1];
        if (a < 0 || a > 255) return end(6);
        M[a] = D[sp - 2];
        sp -= 2;
        break;
      }
      case 0x50: { // PRINT: decimal ASCII, no newline
        const s = String(D[sp - 1]);
        if (ol + s.length > 65536) return end(11); // output limit, writes nothing
        sp--;
        for (let i = 0; i < s.length; i++) o[ol++] = s.charCodeAt(i);
        break;
      }
      case 0x51: // PUTC
        if (ol + 1 > 65536) return end(11);
        o[ol++] = D[--sp] & 255;
        break;
      case 0x52: D[sp++] = ip < q.length ? q[ip++] : -1; break; // IN, -1 past the end
      case 0x53: return end(D[--sp] & 255); // EXIT, low byte
      default: { // binary ops: pops b then a, pushes the result
        const b = D[sp - 1], a = D[sp - 2];
        let r: number;
        if (op === 0x10) r = (a + b) | 0; // ADD, wraps
        else if (op === 0x11) r = (a - b) | 0; // SUB, wraps
        else if (op === 0x12) r = Math.imul(a, b); // MUL, low 32 bits exactly
        else if (op === 0x13) { if (b === 0) return end(4); r = a === -2147483648 && b === -1 ? a : (a / b) | 0; } // DIV, truncates toward zero
        else if (op === 0x14) { if (b === 0) return end(4); r = b === -1 ? 0 : (a % b) | 0; } // MOD, sign of a
        else if (op === 0x15) { if (b === 0) return end(4); r = Math.floor((a >>> 0) / (b >>> 0)) | 0; } // DIVU, unsigned
        else if (op === 0x16) { if (b === 0) return end(4); r = ((a >>> 0) % (b >>> 0)) | 0; } // MODU, unsigned
        else if (op === 0x18) r = a & b; // AND
        else if (op === 0x19) r = a | b; // OR
        else if (op === 0x1a) r = a ^ b; // XOR
        else if (op === 0x1c) r = a << (b & 31); // SHL, low 5 bits of the count
        else if (op === 0x1d) r = a >> (b & 31); // SHR, arithmetic
        else if (op === 0x1e) r = (a >>> (b & 31)) | 0; // SHRU, logical
        else if (op === 0x20) r = a === b ? 1 : 0; // EQ
        else if (op === 0x21) r = a < b ? 1 : 0; // LT, signed
        else r = (a >>> 0) < (b >>> 0) ? 1 : 0; // LTU, unsigned
        sp -= 2;
        D[sp++] = r;
        break;
      }
    }
  }
}

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
for (const id of readdirSync(I).sort()) {
  const r = run(new Uint8Array(readFileSync(join(I, id, 'program.bin'))), new Uint8Array(readFileSync(join(I, id, 'input.bin'))));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'stdout.bin'), r.o);
  writeFileSync(join(O, id, 'exit.txt'), r.c + '\n');
}
