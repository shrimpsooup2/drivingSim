/**
 * Java source in, runnable classes out.
 *
 * The front door: parse every file, compile them together so they can see each
 * other's classes, and build the result with `new Function`. Several files at
 * once because a real op-mode references the team's own helpers, and a compiler
 * that could only see one file would be no use on an actual repository.
 *
 * @module
 */
import { JavaSyntaxError } from './tokenize.js';
import { parseJava } from './parse.js';
import { emitProgram } from './emit.js';

/**
 * @typedef {object} CompiledJava
 * @property {(runtime: any) => Record<string, any>} factory
 * @property {string} code the JavaScript, for looking at when something is odd
 * @property {string[]} classes
 * @property {any[]} opModes
 * @property {string[]} warnings
 */

/**
 * @param {Array<{name: string, source: string}>} sources
 * @returns {CompiledJava}
 * @throws {JavaSyntaxError} with the file it came from in the message
 */
export function compileJava(sources) {
  const files = [];
  for (const { name, source } of sources) {
    try {
      files.push({ name, ast: parseJava(source) });
    } catch (err) {
      if (err instanceof JavaSyntaxError) {
        err.file = name;
        err.message = `${name}, ${err.message}`;
      }
      throw err;
    }
  }

  const emitted = emitProgram(files);
  let factory;
  try {
    factory = new Function('__rt', `"use strict";\n${emitted.code}`);
  } catch (err) {
    // A syntax error here is a bug in the emitter rather than in the Java, so
    // it says so: a team should not be left thinking their own file is wrong.
    throw new JavaSyntaxError(
      `the compiler produced JavaScript it could not parse (${err.message}). ` +
        'This is a bug in the simulator, not in your op-mode.',
      0,
    );
  }

  return { factory, code: emitted.code, classes: emitted.classes, opModes: emitted.opModes, warnings: emitted.warnings };
}

/**
 * Does this look like Java rather than the JavaScript the editor also takes?
 *
 * Structural rather than clever: a class declaration, a package, an import, or
 * one of the annotations. Deliberately does not guess from `{` and `;`, which
 * both languages are full of.
 */
export function looksLikeJava(source) {
  const text = String(source ?? '');
  if (/^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/|\s)*package\s+[\w.]+\s*;/.test(text)) return true;
  if (/^\s*import\s+[\w.*]+\s*;/m.test(text)) return true;
  if (/@(?:Autonomous|TeleOp|Override|Disabled|Config)\b/.test(text)) return true;
  if (/\b(?:public|abstract)\s+class\s+\w+/.test(text)) return true;
  if (/\bextends\s+(?:Linear)?OpMode\b/.test(text)) return true;
  return false;
}

export { JavaSyntaxError };
