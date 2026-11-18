# RPG Realms

Plataforma de RPG de mesa online, multiplayer e em tempo real.

**Etapas prontas:** 1 (estrutura), 2 (personagens), 3 (mapa multiplayer), 4 (dados), 5 (combate) — sistema **Investigação Paranormal**, regras próprias inspiradas no estilo das campanhas do Cellbit

### Novidades das etapas 2, 3 e 5
- Fichas: classe (combatente, especialista, ocultista), NEX, atributos AGI/FOR/INT/PRE/VIG, 28 perícias com graus, PV/PE/Sanidade calculados no servidor, inventário com armas/proteções/consumíveis, condições, imagem (PNG transparente), histórico de evolução
- Biblioteca "Meus personagens" e levar personagem para qualquer campanha
- Mapas com imagem própria ou quadriculado, grade ajustável, zoom e arrastar; mapas secretos (só o mestre vê até ativar)
- Tokens de personagens, NPCs e inimigos sincronizados em tempo real, com barra de vida, tokens ocultos e regra "mover só na vez"
- Combate: iniciativa rolada no servidor, ordem de turnos, ataque contra Defesa (teste = vários d20, fica o maior + perícia), crítico pela margem da arma, dano aplicado automaticamente, testes de perícia, dano/cura manual
- Tudo registrado no histórico de eventos

### Regras (resumo)
- Teste: 1d20 por ponto do atributo, fica o maior (atributo 0: 2d20, fica o menor) + perícia (treinado +5, veterano +10, expert +15)
- Ataque: Luta (FOR) ou Pontaria (AGI) contra Defesa (10 + AGI + proteção). Crítico se o d20 alcançar a margem da arma: dados de dano multiplicados. Corpo a corpo soma FOR ao dano
- PV/PE/SAN por classe e NEX (ver `server/rules/paranormal.js`)

**Etapa 1** também inclui:
- Cadastro, login e recuperação de senha (Supabase Auth)
- Campanhas com código de convite, limite de participantes e administrador
- Participantes online em tempo real, remoção de jogadores, sair da campanha
- Dados d4, d6, d8, d10, d12, d20, d100 e personalizados (dX), com quantidade, modificador e expressões livres (`2d6+1d4+3`)
- Rolagens sorteadas **no servidor**, iguais para todos, com histórico que não pode ser alterado nem apagado
- Commit-reveal: o lacre (SHA-256) da semente é publicado antes das rolagens; depois de revelada, qualquer jogador confere tudo no próprio navegador
- Chat geral, mensagens privadas, narração do mestre, "digitando…" e notificações
- Registro cronológico de eventos da campanha
- Funciona no computador, tablet e celular

## Tecnologias

| Parte | Tecnologia |
|---|---|
| Servidor | Node.js 20+, Express, Socket.IO |
| Banco | PostgreSQL (Supabase), schema `rpg` |
| Login | Supabase Auth (e-mail e senha) |
| Site | HTML, CSS e JavaScript (módulos), sem etapa de build |

## Variáveis de ambiente

| Nome | Descrição |
|---|---|
| `DATABASE_URL` | Conexão PostgreSQL (no Supabase use o *Session pooler*) |
| `SUPABASE_URL` | URL do projeto Supabase |
| `SUPABASE_ANON_KEY` | Chave pública (anon / publishable) do Supabase |
| `PORT` | Porta (o Render define sozinho) |
| `PGSSL` | `disable` só para banco local sem SSL |
| `AUTH_MODE` | `dev` só para testes locais (nunca em produção) |

Nenhuma chave secreta vai para o navegador. O servidor cria as tabelas sozinho ao iniciar.

## Rodar localmente

```bash
npm install
DATABASE_URL=postgres://... SUPABASE_URL=... SUPABASE_ANON_KEY=... npm start
```

## Testes

```bash
# servidor em modo de teste em outro terminal:
DATABASE_URL=postgres://.../rpg_teste PGSSL=disable AUTH_MODE=dev PORT=3999 npm start
DATABASE_URL=postgres://.../rpg_teste PGSSL=disable npm test
```

## Estrutura

```
server/index.js      API REST + eventos em tempo real
server/dice.js       motor de dados e commit-reveal
server/schema.sql    tabelas, imutabilidade e segurança
server/auth.js       validação do login
public/              site (index.html, css/, js/)
test/                testes automáticos
```

## API REST

Todas as rotas (menos `/api/config`, `/api/universes` e `/api/health`) exigem `Authorization: Bearer <token do Supabase>`.

| Método | Rota | O que faz |
|---|---|---|
| GET | `/api/me` | Perfil do usuário |
| PUT | `/api/me` | Altera o nome exibido `{displayName}` |
| GET | `/api/universes` | Lista os 12 universos |
| GET | `/api/campaigns` | Minhas campanhas |
| POST | `/api/campaigns` | Cria `{name, universe, description, maxPlayers}` |
| POST | `/api/campaigns/join` | Entra com `{code}` |
| GET | `/api/campaigns/:id` | Detalhes, participantes e lacre atual (código só para o admin) |
| PUT | `/api/campaigns/:id` | Admin: altera `{maxPlayers}` |
| POST | `/api/campaigns/:id/code` | Admin: gera novo código |
| DELETE | `/api/campaigns/:id/members/:userId` | Admin: remove participante |
| POST | `/api/campaigns/:id/leave` | Sai da campanha |
| GET | `/api/campaigns/:id/rolls?before=&seed=` | Histórico de rolagens |
| GET | `/api/campaigns/:id/messages?before=` | Histórico do chat (privadas só para remetente/destinatário) |
| GET | `/api/campaigns/:id/seeds` | Sementes (a semente só aparece depois de revelada) |
| POST | `/api/campaigns/:id/seeds/reveal` | Admin: revela a semente atual e lacra uma nova |
| GET | `/api/campaigns/:id/events` | Registro de eventos |

## Eventos em tempo real (Socket.IO)

Conexão com `auth: { token }`.

| Cliente → servidor | Dados |
|---|---|
| `room:join` / `room:leave` | `{campaignId}` |
| `dice:roll` | `{campaignId, expression, clientSeed, requestId, label}` |
| `chat:send` | `{campaignId, body, to?, asMaster?}` |
| `chat:typing` | `{campaignId, typing}` |

| Servidor → clientes | Quando |
|---|---|
| `dice:result` | Nova rolagem |
| `chat:message` | Nova mensagem |
| `chat:typing` | Alguém digitando |
| `presence` | Alguém entrou/saiu da mesa |
| `members:update` | Participantes mudaram |
| `campaign:update` | Limite alterado |
| `campaign:removed` | Você foi removido |
| `seed:revealed` | Semente revelada |

## Como a conferência dos dados funciona

1. O servidor cria uma semente secreta aleatória (`crypto.randomBytes`) e publica só o lacre `SHA-256(semente)`.
2. Cada rolagem usa `HMAC-SHA256(semente, "sementeDoJogador:contador:índice:tentativa")`, com amostragem sem viés.
3. Quando o administrador revela a semente, o navegador de cada jogador refaz todos os cálculos e confere o lacre.
4. Rolagens e eventos têm gatilhos no banco que impedem qualquer alteração ou exclusão.
