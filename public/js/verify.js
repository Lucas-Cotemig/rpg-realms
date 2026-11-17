// Conferência independente das rolagens, feita no navegador de cada jogador.
// Reproduz exatamente o cálculo do servidor usando a semente revelada.
const enc = new TextEncoder();
const hexToBytes = (hex) => new Uint8Array(hex.match(/../g).map((b) => parseInt(b, 16)));
const bytesToHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function sha256Hex(seedHex) {
  return bytesToHex(await crypto.subtle.digest('SHA-256', hexToBytes(seedHex)));
}

const keyCache = new Map();
async function key(seedHex) {
  if (!keyCache.has(seedHex)) {
    keyCache.set(seedHex, crypto.subtle.importKey('raw', hexToBytes(seedHex), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']));
  }
  return keyCache.get(seedHex);
}

async function dieValue(seedHex, clientSeed, nonce, index, sides) {
  const k = await key(seedHex);
  const limit = Math.floor(0x100000000 / sides) * sides;
  for (let attempt = 0; attempt < 1000; attempt++) {
    const mac = new DataView(await crypto.subtle.sign('HMAC', k, enc.encode(`${clientSeed}:${nonce}:${index}:${attempt}`)));
    const x = mac.getUint32(0, false);
    if (x < limit) return (x % sides) + 1;
  }
  throw new Error('falha');
}

// Retorna true se todos os dados e o total batem com a semente revelada
export async function verifyRoll(roll, seedHex) {
  let index = 0;
  let total = roll.modifier;
  for (const t of roll.terms) {
    for (const v of t.results) {
      const expected = await dieValue(seedHex, roll.clientSeed, roll.nonce, index++, t.sides);
      if (expected !== v) return false;
      total += t.sign * v;
    }
  }
  return total === roll.total;
}
