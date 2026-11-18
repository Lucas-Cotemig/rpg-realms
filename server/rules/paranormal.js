// Sistema "Investigação Paranormal" — regras próprias inspiradas no estilo das campanhas
// de RPG do Cellbit (Ordem Paranormal). Texto e números escritos para este projeto.
//
// Resumo das regras:
// - 5 atributos (0 a 5): AGI, FOR, INT, PRE, VIG.
// - Teste: rola 1d20 por ponto do atributo e fica com o MAIOR. Atributo 0 = rola 2d20 e fica com o MENOR.
//   Soma o bônus da perícia: treinado +5, veterano +10, expert +15.
// - Classes: combatente, especialista, ocultista. NEX (5% a 99%) define o nível.
// - Ataque: teste de Luta (corpo a corpo) ou Pontaria (distância) contra a Defesa do alvo (10 + AGI + equipamentos).
//   Acerto crítico quando o d20 escolhido alcança a margem de ameaça da arma: os dados de dano são multiplicados.
// - Dano corpo a corpo soma FOR.

const ATRIBUTOS = [
  { id: 'agi', nome: 'Agilidade' },
  { id: 'for', nome: 'Força' },
  { id: 'int', nome: 'Intelecto' },
  { id: 'pre', nome: 'Presença' },
  { id: 'vig', nome: 'Vigor' },
];

const PERICIAS = [
  ['acrobacia', 'Acrobacia', 'agi'], ['adestramento', 'Adestramento', 'pre'], ['artes', 'Artes', 'pre'],
  ['atletismo', 'Atletismo', 'for'], ['atualidades', 'Atualidades', 'int'], ['ciencias', 'Ciências', 'int'],
  ['crime', 'Crime', 'agi'], ['diplomacia', 'Diplomacia', 'pre'], ['enganacao', 'Enganação', 'pre'],
  ['fortitude', 'Fortitude', 'vig'], ['furtividade', 'Furtividade', 'agi'], ['iniciativa', 'Iniciativa', 'agi'],
  ['intimidacao', 'Intimidação', 'pre'], ['intuicao', 'Intuição', 'pre'], ['investigacao', 'Investigação', 'int'],
  ['luta', 'Luta', 'for'], ['medicina', 'Medicina', 'int'], ['ocultismo', 'Ocultismo', 'int'],
  ['percepcao', 'Percepção', 'pre'], ['pilotagem', 'Pilotagem', 'agi'], ['pontaria', 'Pontaria', 'agi'],
  ['profissao', 'Profissão', 'int'], ['reflexos', 'Reflexos', 'agi'], ['religiao', 'Religião', 'pre'],
  ['sobrevivencia', 'Sobrevivência', 'int'], ['tatica', 'Tática', 'int'], ['tecnologia', 'Tecnologia', 'int'],
  ['vontade', 'Vontade', 'pre'],
].map(([id, nome, atributo]) => ({ id, nome, atributo }));

const GRAUS = [
  { id: 0, nome: 'Destreinado', bonus: 0 },
  { id: 1, nome: 'Treinado', bonus: 5 },
  { id: 2, nome: 'Veterano', bonus: 10 },
  { id: 3, nome: 'Expert', bonus: 15 },
];

const CLASSES = {
  combatente: { nome: 'Combatente', pv: [20, 4], pe: [2, 2], san: [12, 3], descricao: 'Linha de frente: mais vida, ataques fortes.' },
  especialista: { nome: 'Especialista', pv: [16, 3], pe: [3, 3], san: [16, 4], descricao: 'Versátil: mais perícias e soluções criativas.' },
  ocultista: { nome: 'Ocultista', pv: [12, 2], pe: [4, 4], san: [20, 5], descricao: 'Estudioso do paranormal: mais esforço e sanidade.' },
};

const NEX = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 99];

const ARMAS_PRONTAS = [
  { nome: 'Faca', dano: '1d4', critico: 19, multiplicador: 2, pericia: 'luta' },
  { nome: 'Machadinha', dano: '1d6', critico: 20, multiplicador: 3, pericia: 'luta' },
  { nome: 'Bastão', dano: '1d6', critico: 20, multiplicador: 2, pericia: 'luta' },
  { nome: 'Espada', dano: '1d8', critico: 19, multiplicador: 2, pericia: 'luta' },
  { nome: 'Revólver', dano: '2d6', critico: 19, multiplicador: 3, pericia: 'pontaria' },
  { nome: 'Pistola', dano: '1d12', critico: 18, multiplicador: 2, pericia: 'pontaria' },
  { nome: 'Espingarda', dano: '4d6', critico: 20, multiplicador: 3, pericia: 'pontaria' },
  { nome: 'Fuzil', dano: '2d10', critico: 19, multiplicador: 3, pericia: 'pontaria' },
];

const clampInt = (v, min, max, def) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};
const str = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max) : '');

function nivel(nex) { return Math.max(1, NEX.indexOf(nex) + 1); }

// Recalcula os valores derivados (máximos e defesa) a partir de classe, NEX e atributos
function derivar(d) {
  const c = CLASSES[d.classe] || CLASSES.combatente;
  const n = nivel(d.nex);
  const a = d.atributos;
  const pvMax = c.pv[0] + a.vig + (n - 1) * (c.pv[1] + a.vig);
  const peMax = c.pe[0] + a.pre + (n - 1) * (c.pe[1] + a.pre);
  const sanMax = c.san[0] + (n - 1) * c.san[1];
  const bonusDefesa = d.inventario.filter((i) => i.equipado && i.tipo === 'protecao').reduce((s, i) => s + (i.defesa || 0), 0);
  return { pvMax: Math.max(1, pvMax), peMax: Math.max(0, peMax), sanMax, defesa: 10 + a.agi + bonusDefesa, nivel: n };
}

// Valida e normaliza a ficha enviada pelo navegador (nada é aceito sem passar por aqui)
function normalizarFicha(input, anterior) {
  const i = input && typeof input === 'object' ? input : {};
  const prev = anterior || {};
  const atributos = {};
  for (const at of ATRIBUTOS) atributos[at.id] = clampInt(i.atributos && i.atributos[at.id], 0, 5, 1);
  const pericias = {};
  for (const p of PERICIAS) {
    const g = clampInt(i.pericias && i.pericias[p.id], 0, 3, 0);
    if (g) pericias[p.id] = g;
  }
  const inventario = (Array.isArray(i.inventario) ? i.inventario : []).slice(0, 60).map((it) => {
    const tipo = ['arma', 'protecao', 'item', 'consumivel'].includes(it.tipo) ? it.tipo : 'item';
    const item = { nome: str(it.nome, 50) || 'Item', tipo, qtd: clampInt(it.qtd, 0, 999, 1), equipado: !!it.equipado, descricao: str(it.descricao, 200) };
    if (tipo === 'arma') {
      item.dano = /^\d{1,2}d\d{1,3}([+-]\d{1,3})?$/.test(String(it.dano || '').replace(/\s/g, '')) ? String(it.dano).replace(/\s/g, '') : '1d6';
      item.critico = clampInt(it.critico, 2, 20, 20);
      item.multiplicador = clampInt(it.multiplicador, 2, 5, 2);
      item.pericia = it.pericia === 'pontaria' ? 'pontaria' : 'luta';
      item.bonus = clampInt(it.bonus, -10, 20, 0);
    }
    if (tipo === 'protecao') item.defesa = clampInt(it.defesa, 0, 20, 2);
    if (tipo === 'consumivel') item.cura = /^\d{1,2}d\d{1,3}([+-]\d{1,3})?$/.test(String(it.cura || '').replace(/\s/g, '')) ? String(it.cura).replace(/\s/g, '') : '';
    return item;
  });
  const d = {
    sistema: 'paranormal',
    nome: str(i.nome, 60) || 'Sem nome',
    apelido: str(i.apelido, 40),
    origem: str(i.origem, 60),
    historia: str(i.historia, 4000),
    classe: CLASSES[i.classe] ? i.classe : 'combatente',
    nex: NEX.includes(Number(i.nex)) ? Number(i.nex) : 5,
    atributos,
    pericias,
    inventario,
    dinheiro: clampInt(i.dinheiro, 0, 1e9, 0),
    experiencia: clampInt(i.experiencia, 0, 1e9, 0),
    condicoes: (Array.isArray(i.condicoes) ? i.condicoes : []).map((c) => str(c, 30)).filter(Boolean).slice(0, 15),
    anotacoes: str(i.anotacoes, 4000),
    evolucao: Array.isArray(prev.evolucao) ? prev.evolucao.slice(-100) : [],
  };
  const der = derivar(d);
  Object.assign(d, der);
  const keep = (k, max) => clampInt(i[k] ?? prev[k] ?? max, -max, max, max);
  d.pv = keep('pv', d.pvMax);
  d.pe = Math.max(0, keep('pe', d.peMax));
  d.san = Math.max(0, keep('san', d.sanMax));
  if (prev.nex && prev.nex !== d.nex) d.evolucao.push({ em: new Date().toISOString(), texto: `NEX ${prev.nex}% → ${d.nex}%` });
  if (prev.classe && prev.classe !== d.classe) d.evolucao.push({ em: new Date().toISOString(), texto: `Classe: ${CLASSES[prev.classe]?.nome} → ${CLASSES[d.classe].nome}` });
  return d;
}

// Monta a expressão de dados de um teste: nd20kh + bônus (atributo 0 → 2d20kl)
function expressaoTeste(valorAtributo, bonus) {
  const base = valorAtributo <= 0 ? '2d20kl' : `${Math.min(valorAtributo, 10)}d20kh`;
  return base + (bonus > 0 ? `+${bonus}` : bonus < 0 ? `${bonus}` : '');
}

function bonusPericia(ficha, periciaId) {
  return (GRAUS[(ficha.pericias || {})[periciaId] || 0] || GRAUS[0]).bonus;
}

// Ficha mínima de NPC/inimigo criada pelo mestre
function normalizarNpc(i, anterior) {
  const prev = anterior || {};
  const atributos = {};
  for (const at of ATRIBUTOS) atributos[at.id] = clampInt(i.atributos && i.atributos[at.id], 0, 6, prev.atributos ? prev.atributos[at.id] : 1);
  const pvMax = clampInt(i.pvMax ?? prev.pvMax, 1, 9999, 20);
  const ataques = (Array.isArray(i.ataques) ? i.ataques : prev.ataques || []).slice(0, 6).map((a) => ({
    nome: str(a.nome, 40) || 'Ataque',
    dano: /^\d{1,2}d\d{1,3}([+-]\d{1,3})?$/.test(String(a.dano || '').replace(/\s/g, '')) ? String(a.dano).replace(/\s/g, '') : '1d6',
    bonus: clampInt(a.bonus, -10, 40, 0),
    critico: clampInt(a.critico, 2, 20, 20),
    multiplicador: clampInt(a.multiplicador, 2, 5, 2),
    pericia: a.pericia === 'pontaria' ? 'pontaria' : 'luta',
  }));
  return {
    atributos,
    pvMax,
    pv: clampInt(i.pv ?? prev.pv ?? pvMax, -pvMax, pvMax, pvMax),
    defesa: clampInt(i.defesa ?? prev.defesa, 0, 60, 12),
    iniciativa: clampInt(i.iniciativa ?? prev.iniciativa, -10, 40, 0),
    ataques: ataques.length ? ataques : [{ nome: 'Ataque', dano: '1d6', bonus: 0, critico: 20, multiplicador: 2, pericia: 'luta' }],
  };
}

module.exports = {
  id: 'paranormal',
  nome: 'Investigação Paranormal',
  versao: '1.0',
  ATRIBUTOS, PERICIAS, GRAUS, CLASSES, NEX, ARMAS_PRONTAS,
  normalizarFicha, normalizarNpc, derivar, expressaoTeste, bonusPericia,
};
