import { describe, expect, it } from 'vitest';
import {
  describePrompt,
  isEmptyMatcher,
  matchesPrompt,
  promptText,
  validateMatcher,
} from '../../src/answers/matcher';
import {
  hostMatches,
  shorten,
  stripDiacritics,
  testPattern,
  testRegex,
} from '../../src/answers/text';
import type { PendingPrompt } from '../../src/contracts';

const methodsForm: PendingPrompt = {
  itemId: 'i1',
  agent: 'procedure',
  procedureId: 'p_1',
  kind: 'form',
  title: '¿Cómo quieres identificarte?',
  message: 'La Seguridad Social te pide identificarte.',
  fields: [
    {
      key: 'metodo',
      type: 'select',
      label: 'Método de identificación',
      options: [
        { value: 'cp', label: 'Cl@ve Permanente (usuario y contraseña)' },
        { value: 'cm', label: 'Cl@ve Móvil (app en el móvil)' },
      ],
    },
    { key: 'nota', type: 'text', label: 'Nota' },
  ],
};

const credentialPrompt: PendingPrompt = {
  itemId: 'i2',
  agent: 'procedure',
  kind: 'credential',
  title: 'Añade tu Cl@ve Permanente',
  credentialKind: 'clave_permanente',
};

describe('matchesPrompt', () => {
  it('matches everything with an empty matcher', () => {
    expect(isEmptyMatcher({})).toBe(true);
    expect(isEmptyMatcher({ fieldKeys: [] })).toBe(true);
    expect(isEmptyMatcher({ kind: 'form' })).toBe(false);
    expect(matchesPrompt({}, methodsForm)).toBe(true);
    expect(matchesPrompt({}, credentialPrompt)).toBe(true);
  });

  it('requires every field of the matcher to hold', () => {
    expect(matchesPrompt({ kind: 'form', agent: 'procedure' }, methodsForm)).toBe(true);
    expect(matchesPrompt({ kind: 'form', agent: 'assistant' }, methodsForm)).toBe(false);
    expect(matchesPrompt({ kind: 'confirm' }, methodsForm)).toBe(false);
    expect(
      matchesPrompt({ kind: 'credential', credentialKind: 'clave_permanente' }, credentialPrompt),
    ).toBe(true);
    expect(matchesPrompt({ credentialKind: 'dnie' }, credentialPrompt)).toBe(false);
    expect(matchesPrompt({ credentialKind: 'clave_permanente' }, methodsForm)).toBe(false);
  });

  it('tests text against title and message, case-insensitively', () => {
    expect(matchesPrompt({ text: 'SEGURIDAD SOCIAL' }, methodsForm)).toBe(true);
    expect(matchesPrompt({ text: 'identificarte\\?' }, methodsForm)).toBe(true);
    expect(matchesPrompt({ text: 'identificarte\\?\\nLa Seguridad' }, methodsForm)).toBe(true); // title, newline, message
    expect(matchesPrompt({ text: 'identificarte\\?.*Seguridad' }, methodsForm)).toBe(false); // "." stops at the newline
    expect(matchesPrompt({ text: 'padron' }, methodsForm)).toBe(false);
    expect(promptText(methodsForm)).toContain('\n');
    expect(promptText(credentialPrompt)).toBe('Añade tu Cl@ve Permanente');
  });

  it('finds text with or without accents', () => {
    expect(matchesPrompt({ text: 'cómo quieres' }, methodsForm)).toBe(true);
    expect(matchesPrompt({ text: 'como quieres' }, methodsForm)).toBe(true);
    expect(matchesPrompt({ optionLabel: 'cl@ve movil' }, methodsForm)).toBe(true);
    expect(matchesPrompt({ optionLabel: 'cl@ve móvil' }, methodsForm)).toBe(true);
  });

  it('requires every listed field key', () => {
    expect(matchesPrompt({ fieldKeys: ['metodo'] }, methodsForm)).toBe(true);
    expect(matchesPrompt({ fieldKeys: ['metodo', 'nota'] }, methodsForm)).toBe(true);
    expect(matchesPrompt({ fieldKeys: ['metodo', 'otro'] }, methodsForm)).toBe(false);
    expect(matchesPrompt({ fieldKeys: ['metodo'] }, credentialPrompt)).toBe(false);
  });

  it('matches some option label of some field', () => {
    expect(matchesPrompt({ optionLabel: 'cl@ve\\s*permanente' }, methodsForm)).toBe(true);
    expect(matchesPrompt({ optionLabel: 'certificado' }, methodsForm)).toBe(false);
    expect(matchesPrompt({ optionLabel: 'x' }, credentialPrompt)).toBe(false);
  });

  it('throws a clear error for an invalid regex', () => {
    expect(() => matchesPrompt({ text: '(' }, methodsForm)).toThrow(
      /matcher\.text: invalid regular expression/,
    );
    expect(validateMatcher({ text: '(', optionLabel: '[' }, 'answer a')).toHaveLength(2);
    expect(validateMatcher({ text: 'ok' }, 'answer a')).toEqual([]);
  });

  it('describes a prompt in one line', () => {
    expect(describePrompt(methodsForm)).toBe('procedure form "¿Cómo quieres identificarte?"');
  });
});

describe('text helpers', () => {
  it('strips accents but keeps case', () => {
    expect(stripDiacritics('Cl@ve Móvil, ÁÉÍÓÚ ñ')).toBe('Cl@ve Movil, AEIOU n');
  });

  it('tests regexes without lastIndex state', () => {
    const re = /ab/g;
    expect(testRegex(re, 'ab')).toBe(true);
    expect(testRegex(re, 'ab')).toBe(true);
    expect(re.lastIndex).toBe(0);
    expect(testPattern(/movil/i, 'Móvil')).toBe(true);
  });

  it('matches hosts exactly or by *.suffix, with ports and trailing dots ignored', () => {
    expect(hostMatches('Portal.Seg-Social.gob.es:443', 'portal.seg-social.gob.es')).toBe(true);
    expect(hostMatches('a.b.example.com.', '*.example.com')).toBe(true);
    expect(hostMatches('example.com', '*.example.com')).toBe(true);
    expect(hostMatches('badexample.com', '*.example.com')).toBe(false);
    expect(hostMatches('a.example.com', 'example.com')).toBe(false);
  });

  it('shortens text to one line', () => {
    expect(shorten('a\n b   c', 100)).toBe('a b c');
    expect(shorten('x'.repeat(50), 10)).toHaveLength(10);
  });
});
