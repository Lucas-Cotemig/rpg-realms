// Motor de dados do RPG Realms
// - Interpreta expressões como "1d20+5", "2d6", "3d8+2", "1d100", "d%", "4d6-1d4+2"
// - Gera resultados com commit-reveal: HMAC-SHA256(semente_do_servidor, "clientSeed:nonce:indice:tentativa")
//   A semente é aleatória (crypto.randomBytes) e seu hash é publicado ANTES das rolagens.
const crypto = require('crypto');

const MAX_DICE = 100;
const MAX_SIDES = 1000;

class DiceError extends Error {}

function parseExpression(input) {
  if (typeof input !== 'string') throw new DiceError('Expressão inválida');
  const expr = input.toLowerCase().replace(/\s+/g, '').replace(/d%/g, 'd100');
  if (!expr || expr.length > 60) throw new DiceError('Expressão vazia ou longa demais');
  if (!/^[+-]?(\d*d\d+|\d+)([+-](\d*d\d+|\d+))*$/.test(expr)) {
    throw new DiceError('Use o formato 1d20+5, 2d6, 3d8+2 ou 1d100');
  }
  const terms = [];
  let modifier = 0;
  let diceCount = 0;
  const re = /([+-]?)(\d*d\d+|\d+)/g;
  let m;
  while ((m = re.exec(expr))) {
    const sign = m[1] === '-' ? -1 : 1;
    const tok = m[2];
    if (tok.includes('d')) {
      const [c, s] = tok.split('d');
      const count = c === '' ? 1 : parseInt(c, 10);
      const sides = parseInt(s, 10);
      if (count < 1) throw new DiceError('Quantidade de dados deve ser pelo menos 1');
      if (sides < 2 || sides > MAX_SIDES) throw new DiceError(`Dados devem ter entre 2 e ${MAX_SIDES} lados`);
      diceCount += count;
      terms.push({ sign, count, sides });
    } else {
      const n = parseInt(tok, 10);
      if (n > 10000) throw new DiceError('Modificador grande demais');
      modifier += sign * n;
    }
  }
  if (!terms.length) throw new DiceError('A expressão precisa ter pelo menos um dado');
  if (diceCount > MAX_DICE) throw new DiceError(`Máximo de ${MAX_DICE} dados por rolagem`);
  return { terms, modifier, normalized: normalize(terms, modifier) };
}

function normalize(terms, modifier) {
  let s = terms.map((t, i) => `${t.sign < 0 ? '-' : i ? '+' : ''}${t.count}d${t.sides}`).join('');
  if (modifier) s += (modifier > 0 ? '+' : '') + modifier;
  return s;
}

function newSeed() {
  const seed = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(Buffer.from(seed, 'hex')).digest('hex');
  return { seed, hash };
}

// Valor uniforme 1..sides sem viés (amostragem por rejeição)
function dieValue(seedHex, clientSeed, nonce, index, sides) {
  const key = Buffer.from(seedHex, 'hex');
  const limit = Math.floor(0x100000000 / sides) * sides;
  for (let attempt = 0; attempt < 1000; attempt++) {
    const mac = crypto.createHmac('sha256', key).update(`${clientSeed}:${nonce}:${index}:${attempt}`).digest();
    const x = mac.readUInt32BE(0);
    if (x < limit) return (x % sides) + 1;
  }
  throw new Error('Falha improvável na geração do dado');
}

function computeRoll(parsed, seedHex, clientSeed, nonce) {
  let index = 0;
  let total = parsed.modifier;
  const terms = parsed.terms.map((t) => {
    const results = [];
    for (let i = 0; i < t.count; i++) results.push(dieValue(seedHex, clientSeed, nonce, index++, t.sides));
    const sum = results.reduce((a, b) => a + b, 0);
    total += t.sign * sum;
    return { sign: t.sign, count: t.count, sides: t.sides, results, sum };
  });
  return { terms, total };
}

function validClientSeed(s) {
  return typeof s === 'string' && /^[a-zA-Z0-9]{8,64}$/.test(s);
}

module.exports = { parseExpression, computeRoll, newSeed, dieValue, validClientSeed, DiceError };
