require('dotenv').config();

const express = require('express');
const path = require('path');
const mysql = require('mysql2/promise');
const { GoogleGenAI } = require('@google/genai');

const app = express();
const preferredPort = Number(process.env.PORT) || 3001;
const db = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'dwcopa',
  waitForConnections: true,
  connectionLimit: 10,
  charset: 'utf8mb4'
});

const gemini = process.env.GEMINI_API_KEY
  ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
  : null;

async function allQuery(sql, params = []) {
  const [rows] = await db.execute(sql, params);
  return rows;
}

function normalizeQuestion(question) {
  return question
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

function getSearchTerm(question) {
  return question
    .replace(/\b(19\d{2}|20\d{2})\b/g, '')
    .replace(/\b(quem|qual|quais|quantos|quantas|me|mostre|mostrar|listar|lista|jogador|jogadores|selecao|selecoes|copa|copas|ano|anos|gol|gols|artilharia|assistencia|assistencias|partida|partidas|minuto|minutos|cartao|cartoes|desempenho|fez|fizeram|do|da|dos|das|de|o|a|os|as|no|na|nos|nas|em|um|uma|com|teve|tem|foram|foi|faca|fazer|para|por|mais|melhor|melhores)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function getRelevantContext(question) {
  const normalizedQuestion = normalizeQuestion(question);
  const year = normalizedQuestion.match(/\b(19\d{2}|20\d{2})\b/)?.[1] || null;
  const searchTerm = getSearchTerm(normalizedQuestion);
  const params = [];

  if (/\b(copa|copas|sede|ano)\b/.test(normalizedQuestion) && !/jogador|gol|assist|minuto|cartao|partida/.test(normalizedQuestion)) {
    if (year) {
      return allQuery(
        'SELECT ID_Copa AS id_copa, Ano AS ano, Sede AS sede FROM dim_copa WHERE Ano = ? ORDER BY Ano',
        [year]
      );
    }

    return allQuery('SELECT ID_Copa AS id_copa, Ano AS ano, Sede AS sede FROM dim_copa ORDER BY Ano');
  }

  if (/\b(selecao|selecoes|pais|paises)\b/.test(normalizedQuestion) && !/jogador|gol|assist|minuto|cartao|partida/.test(normalizedQuestion)) {
    return allQuery(
      `
        SELECT DISTINCT s.ID_Selecao AS id_selecao, s.Nome_Selecao AS selecao, s.Sigla AS sigla
        FROM dim_selecao s
        INNER JOIN fato_desempenho_jogador f ON f.ID_Selecao = s.ID_Selecao
        ORDER BY s.Nome_Selecao
      `
    );
  }

  const filters = [];
  if (year) {
    filters.push('c.Ano = ?');
    params.push(year);
  }

  if (searchTerm) {
    filters.push(`(
      LOWER(j.Nome_Jogador) LIKE ? OR
      LOWER(s.Nome_Selecao) LIKE ? OR
      LOWER(s.Sigla) LIKE ? OR
      LOWER(p.Nome_Posicao) LIKE ?
    )`);
    const likeTerm = `%${searchTerm}%`;
    params.push(likeTerm, likeTerm, likeTerm, likeTerm);
  }

  const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const joins = `
    FROM fato_desempenho_jogador f
    INNER JOIN dim_jogador j ON j.ID_Jogador = f.ID_Jogador
    INNER JOIN dim_selecao s ON s.ID_Selecao = f.ID_Selecao
    INNER JOIN dim_copa c ON c.ID_Copa = f.ID_Copa
    LEFT JOIN dim_posicao p ON p.ID_Posicao = f.ID_Posicao
  `;

  if (/gol|gols|artilh|marcou/.test(normalizedQuestion)) {
    return allQuery(
      `
        SELECT j.Nome_Jogador AS jogador, s.Nome_Selecao AS selecao,
               SUM(f.Gols) AS gols, SUM(f.Partidas_Jogadas) AS partidas
        ${joins}
        ${whereClause}
        GROUP BY j.ID_Jogador, j.Nome_Jogador, s.Nome_Selecao
        ORDER BY gols DESC, partidas DESC
        LIMIT 20
      `,
      params
    );
  }

  if (/assist/.test(normalizedQuestion)) {
    return allQuery(
      `
        SELECT j.Nome_Jogador AS jogador, s.Nome_Selecao AS selecao,
               SUM(f.Assistencias) AS assistencias, SUM(f.Partidas_Jogadas) AS partidas
        ${joins}
        ${whereClause}
        GROUP BY j.ID_Jogador, j.Nome_Jogador, s.Nome_Selecao
        ORDER BY assistencias DESC, partidas DESC
        LIMIT 20
      `,
      params
    );
  }

  return allQuery(
    `
      SELECT j.Nome_Jogador AS jogador, s.Nome_Selecao AS selecao,
             p.Nome_Posicao AS posicao, c.Ano AS copa, c.Sede AS sede,
             f.Partidas_Jogadas AS partidas, f.Titular AS titular,
             f.Minutos_Jogados AS minutos, f.Gols AS gols,
             f.Assistencias AS assistencias, f.Cartoes_Amarelos AS cartoes_amarelos,
             f.Cartoes_Vermelhos AS cartoes_vermelhos
      ${joins}
      ${whereClause}
      ORDER BY c.Ano DESC, f.Gols DESC, f.Minutos_Jogados DESC
      LIMIT 20
    `,
    params
  );
}

function formatContext(context) {
  if (!Array.isArray(context) || context.length === 0) {
    return 'Nenhum dado encontrado no banco para esta pergunta.';
  }

  return JSON.stringify(context, null, 2);
}

async function getAIResponse(question, context) {
  const formattedContext = formatContext(context);

  if (!gemini) {
    if (!context || context.length === 0) {
      return 'Não encontrei informações no banco que correspondam à sua pergunta.';
    }

    const firstRow = context[0];
    if (firstRow && firstRow.total_gasto !== undefined) {
      return `Com base no banco, o maior faturamento está em ${firstRow.nome} com total de R$ ${Number(firstRow.total_gasto).toFixed(2)}.`;
    }

    return `Com base nos dados do banco, encontrei: ${JSON.stringify(context.slice(0, 3))}.`;
  }

  const interaction = await gemini.interactions.create({
    model: 'gemini-3.6-flash',
    input: `Você é um assistente que responde somente com base no contexto do banco de dados fornecido. Se não houver dados suficientes, diga que não encontrou informação suficiente.\n\nPergunta do usuário: ${question}\n\nContexto do banco: ${formattedContext}`
  });

  return interaction.output_text?.trim() || 'Não consegui gerar uma resposta.';
}

app.use(express.json());
app.use(express.static(__dirname));

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'main.html'));
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, message: 'API funcionando' });
});

app.post('/api/chat', async (req, res) => {
  try {
    const question = String(req.body?.question || '').trim();

    if (!question) {
      return res.status(400).json({ error: 'Pergunta obrigatória.' });
    }

    const context = await getRelevantContext(question);
    const answer = await getAIResponse(question, context);

    res.json({
      answer,
      question,
      context
    });
  } catch (error) {
    console.error('Erro ao processar pergunta:', error);
    const databaseUnavailable = ['ECONNREFUSED', 'ENOTFOUND', 'ER_ACCESS_DENIED_ERROR'].includes(error.code);
    res.status(databaseUnavailable ? 503 : 500).json({
      error: databaseUnavailable
        ? 'Não foi possível acessar o banco dwcopa. Verifique o MySQL e as variáveis DB_* no arquivo .env.'
        : 'Ocorreu um erro ao consultar o banco e gerar a resposta.',
      answer: databaseUnavailable
        ? 'O banco de dados está indisponível no momento.'
        : 'Ocorreu um erro ao consultar o banco e gerar a resposta.'
    });
  }
});

async function startServer() {
  const candidatePorts = Array.from(new Set([preferredPort, 3002, 3003, 3004, 3005, 3010]));

  for (const port of candidatePorts) {
    try {
      await new Promise((resolve, reject) => {
        const server = app.listen(port, () => {
          console.log(`Servidor rodando em http://localhost:${port}`);
          resolve();
        });

        server.on('error', (error) => {
          if (error.code === 'EADDRINUSE') {
            reject(error);
            return;
          }

          reject(error);
        });
      });
      return;
    } catch (error) {
      if (error.code !== 'EADDRINUSE') {
        throw error;
      }
    }
  }

  throw new Error('Não foi possível iniciar o servidor porque todas as portas disponíveis estão ocupadas.');
}

startServer().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
