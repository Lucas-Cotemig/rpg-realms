const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { parseExpression, computeRoll, newSeed, dieValue } = require('../server/dice');

test('interpreta expressões comuns', () => {
  assert.deepStrictEqual(parseExpression('1d20').normalized, '1d20');
  assert.deepStrictEqual(parseExpression('d20 + 5').normalized, '1d20+5');
  assert.deepStrictEqual(parseExpression('3D8+2').normalized, '3d8+2');
  assert.deepStrictEqual(parseExpression('1d%').normalized, '1d100');
  assert.deepStrictEqual(parseExpression('4d6-1d4+2-1').normalized, '4d6-1d4+1');
});

test('recusa expressões inválidas', () => {
  for (const e of ['', 'oi', '1d1', '0d6', '1d1001', '101d6', '1d20*2', '2+3', '1d20++2']) {
    assert.throws(() => parseExpression(e), undefined, e);
  }
});

test('resultados ficam dentro do intervalo e são reproduzíveis', () => {
  const { seed } = newSeed();
  const p = parseExpression('10d6+3');
  const a = computeRoll(p, seed, 'abc12345', 7);
  const b = computeRoll(p, seed, 'abc12345', 7);
  assert.deepStrictEqual(a, b);
  a.terms[0].results.forEach((v) => assert.ok(v >= 1 && v <= 6));
  assert.strictEqual(a.total, a.terms[0].sum + 3);
});

test('hash da semente confere', () => {
  const { seed, hash } = newSeed();
  assert.strictEqual(crypto.createHash('sha256').update(Buffer.from(seed, 'hex')).digest('hex'), hash);
});

test('distribuição do d20 é uniforme (qui-quadrado)', () => {
  const { seed } = newSeed();
  const counts = new Array(20).fill(0);
  const N = 40000;
  for (let i = 0; i < N; i++) counts[dieValue(seed, 'teste123', i, 0, 20) - 1]++;
  const exp = N / 20;
  const chi = counts.reduce((s, c) => s + (c - exp) ** 2 / exp, 0);
  assert.ok(chi < 43.8, 'qui-quadrado alto: ' + chi); // p≈0.001 com 19 graus de liberdade
});
