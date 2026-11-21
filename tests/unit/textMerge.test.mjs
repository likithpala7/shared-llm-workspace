import test from 'node:test';
import assert from 'node:assert/strict';
import { applyExternalChange, applyMinimalDiff } from '../../server/src/textMerge.ts';

/** A stand-in for a Yjs text, with the same delete/insert semantics. */
function text(initial) {
  let value = initial;
  return {
    toString: () => value,
    delete(index, length) {
      value = value.slice(0, index) + value.slice(index + length);
    },
    insert(index, inserted) {
      value = value.slice(0, index) + inserted + value.slice(index);
    },
  };
}

test('applyMinimalDiff replaces only what differs', () => {
  const doc = text('const a = 1\nconst b = 2\n');
  assert.equal(applyMinimalDiff(doc, 'const a = 1\nconst b = 9\n'), true);
  assert.equal(doc.toString(), 'const a = 1\nconst b = 9\n');
});

test('applyMinimalDiff is a no-op when the text already matches', () => {
  const doc = text('same');
  assert.equal(applyMinimalDiff(doc, 'same'), false);
});

test('an append on disk lands at the end even after typing at the top', () => {
  const base = 'line one\nline two\n';
  const doc = text(`TYPED ${base}`);
  applyExternalChange(doc, base, `${base}line three\n`);
  assert.equal(doc.toString(), 'TYPED line one\nline two\nline three\n');
});

test('a change at the top lands there even after typing at the end', () => {
  const base = 'const a = 1\ntail\n';
  const doc = text(`${base}TYPED`);
  applyExternalChange(doc, base, 'const a = 2\ntail\n');
  assert.equal(doc.toString(), 'const a = 2\ntail\nTYPED');
});

test('unsaved typing is never dropped by an unrelated disk change', () => {
  const base = 'alpha\nbeta\ngamma\n';
  const doc = text('alpha\nbeta\ngamma\nUNSAVED');
  applyExternalChange(doc, base, 'alpha\nBETA\ngamma\n');
  const result = doc.toString();
  assert.ok(result.includes('UNSAVED'), result);
  assert.ok(result.includes('BETA'), result);
});

test('our own write coming back as a watcher event changes nothing', () => {
  // The echo case: disk now holds exactly what the document holds.
  const current = 'written by us\n';
  const doc = text(current);
  assert.equal(applyExternalChange(doc, 'older\n', current), false);
});

test('an unchanged file is ignored even when the document has moved on', () => {
  const doc = text('doc has extra');
  assert.equal(applyExternalChange(doc, 'base', 'base'), false);
  assert.equal(doc.toString(), 'doc has extra');
});

test('a deletion on disk removes the right region', () => {
  const base = 'keep\ndelete me\nkeep too\n';
  const doc = text(base);
  applyExternalChange(doc, base, 'keep\nkeep too\n');
  assert.equal(doc.toString(), 'keep\nkeep too\n');
});

test('repeated appends do not duplicate earlier content', () => {
  // The duplication bug: the same change applied twice must not double it.
  let base = 'start\n';
  const doc = text('start\n');
  for (let i = 0; i < 5; i++) {
    const next = `${base}line ${i}\n`;
    applyExternalChange(doc, base, next);
    applyExternalChange(doc, next, next); // the echo of our own write
    base = next;
  }
  assert.equal(doc.toString(), 'start\nline 0\nline 1\nline 2\nline 3\nline 4\n');
});

test('typing and disk changes interleave without loss or duplication', () => {
  // A rough model of the formatter-versus-typing race, run many times with
  // pseudo-random edits on both sides.
  let seed = 7;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };

  for (let round = 0; round < 200; round++) {
    let base = 'aaa\nbbb\nccc\nddd\n';
    const doc = text(base);
    const typed = [];

    for (let step = 0; step < 6; step++) {
      // Someone types a unique marker somewhere in the document.
      const marker = String.fromCodePoint(0x2460 + step);
      const at = Math.floor(random() * doc.toString().length);
      doc.insert(at, marker);
      typed.push(marker);

      // Meanwhile the file on disk changes, based on what was last written.
      const next =
        random() < 0.5
          ? `${base}appended ${step}\n`
          : base.replace('bbb', `bbb-${step}`);
      applyExternalChange(doc, base, next);
      base = next;
    }

    const result = doc.toString();
    for (const marker of typed) {
      const count = result.split(marker).length - 1;
      assert.equal(count, 1, `round ${round}: "${marker}" appears ${count} times in ${JSON.stringify(result)}`);
    }
  }
});
